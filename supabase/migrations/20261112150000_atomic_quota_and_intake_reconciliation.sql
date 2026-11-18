-- Atomic per-day invoice reservations and a durable storage/database intake
-- ledger. Provider message IDs are idempotency keys; scope keys are workspace
-- IDs or existing sender HMACs, never raw phone numbers.

create table if not exists public.whatsapp_daily_intake_counters (
  scope_key text not null,
  quota_date date not null,
  reserved_count integer not null default 0 check (reserved_count >= 0),
  primary key (scope_key, quota_date)
);

create table if not exists public.whatsapp_intake_quota_reservations (
  provider_message_id text not null,
  scope_key text not null,
  quota_date date not null,
  status text not null check (status in ('reserved', 'committed', 'released')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '30 minutes'),
  primary key (provider_message_id, scope_key, quota_date)
);

alter table public.whatsapp_daily_intake_counters enable row level security;
alter table public.whatsapp_intake_quota_reservations enable row level security;
revoke all on public.whatsapp_daily_intake_counters from public, anon, authenticated;
revoke all on public.whatsapp_intake_quota_reservations from public, anon, authenticated;

create table if not exists public.whatsapp_intake_storage (
  provider_message_id text not null,
  object_path text primary key,
  object_kind text not null check (object_kind in ('invoice', 'pending')),
  state text not null default 'uploading'
    check (state in ('uploading', 'uploaded', 'linked', 'cleanup_pending', 'deleted')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  available_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  last_error_code text,
  cleanup_claim_token uuid,
  cleanup_claim_expires_at timestamptz
);

alter table public.whatsapp_intake_storage enable row level security;
revoke all on public.whatsapp_intake_storage from public, anon, authenticated;

create index if not exists whatsapp_intake_storage_reconcile_idx
  on public.whatsapp_intake_storage (available_at, created_at)
  where state in ('uploading', 'uploaded', 'cleanup_pending');

alter table public.pending_uploads
  add column if not exists provider_message_id text;

create or replace function public.reserve_whatsapp_daily_intake(
  p_provider_message_id text,
  p_scope_key text,
  p_limit integer
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date := (clock_timestamp() at time zone 'UTC')::date;
  v_status text;
  v_reserved integer;
begin
  if p_provider_message_id is null or length(p_provider_message_id) = 0
     or length(p_provider_message_id) > 512
     or p_scope_key is null or length(p_scope_key) = 0 or length(p_scope_key) > 256 then
    raise exception 'invalid intake quota arguments' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_provider_message_id || ':' || p_scope_key || ':' || v_date::text, 9163
  ));

  select r.status into v_status
    from public.whatsapp_intake_quota_reservations r
   where r.provider_message_id = p_provider_message_id
     and r.scope_key = p_scope_key
     and r.quota_date = v_date
   for update;
  if v_status in ('reserved', 'committed') then
    return true;
  end if;

  insert into public.whatsapp_daily_intake_counters (scope_key, quota_date)
  values (p_scope_key, v_date)
  on conflict (scope_key, quota_date) do nothing;

  update public.whatsapp_daily_intake_counters c
     set reserved_count = c.reserved_count + 1
   where c.scope_key = p_scope_key
     and c.quota_date = v_date
     and (coalesce(p_limit, 0) <= 0 or c.reserved_count < p_limit)
  returning c.reserved_count into v_reserved;

  if not found then
    return false;
  end if;

  insert into public.whatsapp_intake_quota_reservations (
    provider_message_id, scope_key, quota_date, status, expires_at
  ) values (
    p_provider_message_id, p_scope_key, v_date, 'reserved',
    clock_timestamp() + interval '30 minutes'
  )
  on conflict (provider_message_id, scope_key, quota_date) do update
    set status = 'reserved',
        updated_at = clock_timestamp(),
        expires_at = clock_timestamp() + interval '30 minutes';
  return true;
end;
$$;

create or replace function public.commit_whatsapp_daily_intake(
  p_provider_message_id text,
  p_scope_key text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.whatsapp_intake_quota_reservations
     set status = 'committed', updated_at = clock_timestamp()
   where provider_message_id = p_provider_message_id
     and scope_key = p_scope_key
     and status = 'reserved';
  get diagnostics v_updated = row_count;
  return v_updated = 1 or exists (
    select 1 from public.whatsapp_intake_quota_reservations
     where provider_message_id = p_provider_message_id
       and scope_key = p_scope_key
       and status = 'committed'
  );
end;
$$;

create or replace function public.release_whatsapp_daily_intake(
  p_provider_message_id text
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released integer := 0;
  v_row record;
begin
  for v_row in
    update public.whatsapp_intake_quota_reservations r
       set status = 'released', updated_at = clock_timestamp()
     where r.provider_message_id = p_provider_message_id
       and r.status = 'reserved'
     returning r.scope_key, r.quota_date
  loop
    update public.whatsapp_daily_intake_counters c
       set reserved_count = greatest(0, c.reserved_count - 1)
     where c.scope_key = v_row.scope_key
       and c.quota_date = v_row.quota_date;
    v_released := v_released + 1;
  end loop;
  return v_released;
end;
$$;

create or replace function public.release_whatsapp_daily_intake_scope(
  p_provider_message_id text,
  p_scope_key text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_released integer := 0;
begin
  for v_row in
    update public.whatsapp_intake_quota_reservations
       set status = 'released', updated_at = clock_timestamp()
     where provider_message_id = p_provider_message_id
       and scope_key = p_scope_key
       and status in ('reserved', 'committed')
    returning scope_key, quota_date
  loop
    update public.whatsapp_daily_intake_counters
       set reserved_count = greatest(0, reserved_count - 1)
     where scope_key = v_row.scope_key
       and quota_date = v_row.quota_date;
    v_released := v_released + 1;
  end loop;
  return v_released > 0;
end;
$$;

create or replace function public.begin_whatsapp_intake_storage(
  p_provider_message_id text,
  p_object_path text,
  p_object_kind text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_provider_message_id is null or p_object_path is null
     or p_object_kind not in ('invoice', 'pending') then
    raise exception 'invalid intake storage arguments' using errcode = '22023';
  end if;
  insert into public.whatsapp_intake_storage (
    provider_message_id, object_path, object_kind, state
  ) values (p_provider_message_id, p_object_path, p_object_kind, 'uploading')
  on conflict (object_path) do update
    set provider_message_id = excluded.provider_message_id,
        object_kind = excluded.object_kind,
        state = case
          when public.whatsapp_intake_storage.state = 'deleted' then 'uploading'
          else public.whatsapp_intake_storage.state
        end,
        available_at = clock_timestamp(),
        updated_at = clock_timestamp();
  return true;
end;
$$;

create or replace function public.mark_whatsapp_intake_storage(
  p_object_path text,
  p_state text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_state not in ('uploaded', 'linked') then
    raise exception 'invalid intake storage state' using errcode = '22023';
  end if;
  update public.whatsapp_intake_storage
     set state = p_state,
         updated_at = clock_timestamp(),
         available_at = clock_timestamp(),
         last_error_code = null,
         cleanup_claim_token = null,
         cleanup_claim_expires_at = null
   where object_path = p_object_path
     and state <> 'deleted';
  return found;
end;
$$;

create or replace function public.claim_orphaned_whatsapp_intake(
  p_claim_token uuid,
  p_limit integer default 10,
  p_grace_seconds integer default 86400,
  p_lease_seconds integer default 120
) returns table (object_path text, object_kind text, provider_message_id text)
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select s.object_path
      from public.whatsapp_intake_storage s
      join public.webhook_events e using (provider_message_id)
     where s.created_at <= clock_timestamp()
           - make_interval(secs => greatest(coalesce(p_grace_seconds, 86400), 3600))
       and s.available_at <= clock_timestamp()
       and (
         s.state in ('uploading', 'uploaded')
         or (s.state = 'cleanup_pending' and s.cleanup_claim_expires_at <= clock_timestamp())
       )
       and (
         e.status = 'accepted'
         or (
           e.status in ('received', 'failed', 'processing')
           and not exists (
             select 1 from public.whatsapp_webhook_payloads p
              where p.provider_message_id = e.provider_message_id
                and p.expires_at > clock_timestamp()
           )
           and (e.status <> 'processing' or e.claim_expires_at <= clock_timestamp())
         )
       )
       and not exists (select 1 from public.invoices i where i.file_object_path = s.object_path)
       and not exists (select 1 from public.pending_uploads p where p.object_path = s.object_path)
     order by s.created_at, s.object_path
     limit least(greatest(coalesce(p_limit, 10), 1), 50)
     for update of s skip locked
  )
  update public.whatsapp_intake_storage s
     set state = 'cleanup_pending',
         cleanup_claim_token = p_claim_token,
         cleanup_claim_expires_at = clock_timestamp()
           + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30)),
         attempts = s.attempts + 1,
         updated_at = clock_timestamp()
    from candidates c
   where s.object_path = c.object_path
  returning s.object_path, s.object_kind, s.provider_message_id;
$$;

create or replace function public.finish_orphaned_whatsapp_intake(
  p_object_path text,
  p_claim_token uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.whatsapp_intake_storage s
     set state = 'deleted',
         updated_at = clock_timestamp(),
         cleanup_claim_token = null,
         cleanup_claim_expires_at = null,
         last_error_code = null
   where s.object_path = p_object_path
     and s.state = 'cleanup_pending'
     and s.cleanup_claim_token = p_claim_token
     and s.cleanup_claim_expires_at > clock_timestamp()
     and not exists (select 1 from public.invoices i where i.file_object_path = s.object_path)
     and not exists (select 1 from public.pending_uploads p where p.object_path = s.object_path);
  return found;
end;
$$;

create or replace function public.retry_orphaned_whatsapp_intake(
  p_object_path text,
  p_claim_token uuid,
  p_error_code text
) returns boolean
language sql
security definer
set search_path = ''
as $$
  with retry as (
    update public.whatsapp_intake_storage s
       set state = 'uploaded',
           last_error_code = left(coalesce(p_error_code, 'STORAGE_DELETE_FAILED'), 120),
           available_at = clock_timestamp()
             + make_interval(secs => least(3600, greatest(30, 30 * (2 ^ least(s.attempts, 7))::integer))),
           cleanup_claim_token = null,
           cleanup_claim_expires_at = null,
           updated_at = clock_timestamp()
     where s.object_path = p_object_path
       and s.state = 'cleanup_pending'
       and s.cleanup_claim_token = p_claim_token
       and s.cleanup_claim_expires_at > clock_timestamp()
    returning 1
  )
  select exists (select 1 from retry);
$$;

create or replace function public.purge_old_whatsapp_intake_quota()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_deleted integer;
begin
  delete from public.whatsapp_intake_quota_reservations
   where quota_date < (clock_timestamp() at time zone 'UTC')::date - 45
     and status in ('committed', 'released');
  get diagnostics v_deleted = row_count;
  delete from public.whatsapp_daily_intake_counters
   where quota_date < (clock_timestamp() at time zone 'UTC')::date - 45
     and not exists (
       select 1 from public.whatsapp_intake_quota_reservations r
        where r.scope_key = whatsapp_daily_intake_counters.scope_key
          and r.quota_date = whatsapp_daily_intake_counters.quota_date
     );
  return v_deleted;
end;
$$;

create or replace function public.recover_whatsapp_daily_intake_reservations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_recovered integer := 0;
  v_object_linked boolean;
begin
  for v_row in
    select r.provider_message_id, r.scope_key, r.quota_date
      from public.whatsapp_intake_quota_reservations r
     where r.status = 'reserved' and r.expires_at <= clock_timestamp()
     for update skip locked
  loop
    select exists (
      select 1
        from public.whatsapp_intake_storage s
       where s.provider_message_id = v_row.provider_message_id
         and (
           exists (select 1 from public.invoices i where i.file_object_path = s.object_path)
           or exists (select 1 from public.pending_uploads p where p.object_path = s.object_path)
         )
    ) into v_object_linked;

    if v_object_linked then
      update public.whatsapp_intake_quota_reservations
         set status = 'committed', updated_at = clock_timestamp()
       where provider_message_id = v_row.provider_message_id
         and scope_key = v_row.scope_key
         and quota_date = v_row.quota_date
         and status = 'reserved';
    else
      update public.whatsapp_intake_quota_reservations
         set status = 'released', updated_at = clock_timestamp()
       where provider_message_id = v_row.provider_message_id
         and scope_key = v_row.scope_key
         and quota_date = v_row.quota_date
         and status = 'reserved';
      update public.whatsapp_daily_intake_counters
         set reserved_count = greatest(0, reserved_count - 1)
       where scope_key = v_row.scope_key and quota_date = v_row.quota_date;
    end if;
    v_recovered := v_recovered + 1;
  end loop;
  return v_recovered;
end;
$$;

revoke all on function public.reserve_whatsapp_daily_intake(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.commit_whatsapp_daily_intake(text, text)
  from public, anon, authenticated;
revoke all on function public.release_whatsapp_daily_intake(text)
  from public, anon, authenticated;
revoke all on function public.release_whatsapp_daily_intake_scope(text, text)
  from public, anon, authenticated;
revoke all on function public.begin_whatsapp_intake_storage(text, text, text)
  from public, anon, authenticated;
revoke all on function public.mark_whatsapp_intake_storage(text, text)
  from public, anon, authenticated;
revoke all on function public.claim_orphaned_whatsapp_intake(uuid, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.finish_orphaned_whatsapp_intake(text, uuid)
  from public, anon, authenticated;
revoke all on function public.retry_orphaned_whatsapp_intake(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.purge_old_whatsapp_intake_quota()
  from public, anon, authenticated;
revoke all on function public.recover_whatsapp_daily_intake_reservations()
  from public, anon, authenticated;
grant execute on function public.reserve_whatsapp_daily_intake(text, text, integer) to service_role;
grant execute on function public.commit_whatsapp_daily_intake(text, text) to service_role;
grant execute on function public.release_whatsapp_daily_intake(text) to service_role;
grant execute on function public.release_whatsapp_daily_intake_scope(text, text) to service_role;
grant execute on function public.begin_whatsapp_intake_storage(text, text, text) to service_role;
grant execute on function public.mark_whatsapp_intake_storage(text, text) to service_role;
grant execute on function public.claim_orphaned_whatsapp_intake(uuid, integer, integer, integer) to service_role;
grant execute on function public.finish_orphaned_whatsapp_intake(text, uuid) to service_role;
grant execute on function public.retry_orphaned_whatsapp_intake(text, uuid, text) to service_role;
grant execute on function public.purge_old_whatsapp_intake_quota() to service_role;
grant execute on function public.recover_whatsapp_daily_intake_reservations() to service_role;
