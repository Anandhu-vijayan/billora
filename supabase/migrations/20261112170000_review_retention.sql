alter table public.workspaces
  add column if not exists review_retention_days smallint not null default 90,
  add column if not exists review_retention_accepted_at timestamptz,
  add column if not exists review_retention_policy_version text,
  add column if not exists review_retention_actor uuid
    references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'workspaces_review_retention_days_ck'
       and conrelid = 'public.workspaces'::regclass
  ) then
    alter table public.workspaces
      add constraint workspaces_review_retention_days_ck
      check (review_retention_days between 30 and 3650);
  end if;
end;
$$;

alter table public.invoices
  add column if not exists needs_review_at timestamptz,
  add column if not exists review_retention_expires_at timestamptz,
  add column if not exists review_retention_policy_version text,
  add column if not exists review_activity_at timestamptz,
  add column if not exists retention_legal_hold boolean not null default false,
  add column if not exists retention_delete_available_at timestamptz not null default clock_timestamp(),
  add column if not exists retention_delete_attempts integer not null default 0,
  add column if not exists retention_delete_claim_token uuid,
  add column if not exists retention_delete_claim_expires_at timestamptz,
  add column if not exists retention_delete_error_code text;

create index if not exists invoices_review_retention_idx
  on public.invoices (review_retention_expires_at, retention_delete_available_at)
  where status = 'needs_review' and retention_legal_hold = false;

create table if not exists public.invoice_review_retention_notices (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  notice_days smallint not null check (notice_days in (7, 1)),
  scheduled_at timestamptz not null,
  delivered_at timestamptz,
  available_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  claim_token uuid,
  claim_expires_at timestamptz,
  unique (invoice_id, notice_days)
);

alter table public.invoice_review_retention_notices enable row level security;
revoke all on public.invoice_review_retention_notices from public, anon, authenticated;

create index if not exists invoice_review_retention_notices_due_idx
  on public.invoice_review_retention_notices (available_at, scheduled_at)
  where delivered_at is null;

create table if not exists public.invoice_retention_audit (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  invoice_id uuid not null,
  deleted_at timestamptz not null default clock_timestamp(),
  policy_version text not null
);

alter table public.invoice_retention_audit enable row level security;
revoke all on public.invoice_retention_audit from public, anon, authenticated;

create or replace function public.track_invoice_review_retention()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days smallint;
  v_policy_version text;
begin
  if new.status = 'needs_review'
     and (tg_op = 'INSERT' or old.status is distinct from 'needs_review') then
    select w.review_retention_days,
           coalesce(w.review_retention_policy_version, 'review-retention-v1')
      into v_days, v_policy_version
      from public.workspaces w
     where w.id = new.workspace_id;
    new.needs_review_at := clock_timestamp();
    new.review_retention_expires_at := new.needs_review_at + make_interval(days => v_days);
    new.review_retention_policy_version := coalesce(v_policy_version, 'review-retention-v1');
    new.review_activity_at := null;
    new.retention_delete_available_at := clock_timestamp();
    new.retention_delete_attempts := 0;
    new.retention_delete_claim_token := null;
    new.retention_delete_claim_expires_at := null;
    new.retention_delete_error_code := null;
  elsif tg_op = 'UPDATE' and old.status = 'needs_review' and new.status <> 'needs_review' then
    new.needs_review_at := null;
    new.review_retention_expires_at := null;
    new.review_retention_policy_version := null;
    new.review_activity_at := null;
    new.retention_delete_claim_token := null;
    new.retention_delete_claim_expires_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_track_review_retention on public.invoices;
create trigger invoices_track_review_retention
before insert or update of status on public.invoices
for each row execute function public.track_invoice_review_retention();

create or replace function public.enqueue_invoice_review_retention_notices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'needs_review' and new.review_retention_expires_at is not null
     and (tg_op = 'INSERT' or old.status is distinct from 'needs_review') then
    insert into public.invoice_review_retention_notices (
      invoice_id, workspace_id, notice_days, scheduled_at
    ) values
      (new.id, new.workspace_id, 7, new.review_retention_expires_at - interval '7 days'),
      (new.id, new.workspace_id, 1, new.review_retention_expires_at - interval '1 day')
    on conflict (invoice_id, notice_days) do update
      set scheduled_at = excluded.scheduled_at,
          delivered_at = null,
          available_at = clock_timestamp(),
          attempts = 0,
          claim_token = null,
          claim_expires_at = null;
  elsif tg_op = 'UPDATE' and old.status = 'needs_review' and new.status <> 'needs_review' then
    delete from public.invoice_review_retention_notices n
     where n.invoice_id = new.id and n.delivered_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_enqueue_review_retention_notices on public.invoices;
create trigger invoices_enqueue_review_retention_notices
after insert or update of status on public.invoices
for each row execute function public.enqueue_invoice_review_retention_notices();

update public.invoices i
   set needs_review_at = coalesce(i.needs_review_at, i.received_at),
       review_retention_expires_at = coalesce(
         i.review_retention_expires_at,
         i.received_at + make_interval(days => w.review_retention_days)
       ),
       review_retention_policy_version = coalesce(
         i.review_retention_policy_version,
         w.review_retention_policy_version,
         'review-retention-v1'
       )
  from public.workspaces w
 where i.workspace_id = w.id
   and i.status = 'needs_review';

insert into public.invoice_review_retention_notices (
  invoice_id, workspace_id, notice_days, scheduled_at
)
select i.id, i.workspace_id, notice.notice_days,
       i.review_retention_expires_at - make_interval(days => notice.notice_days)
  from public.invoices i
  cross join (values (7::smallint), (1::smallint)) as notice(notice_days)
 where i.status = 'needs_review'
   and i.review_retention_expires_at is not null
on conflict (invoice_id, notice_days) do nothing;

create or replace function public.touch_invoice_review_activity(
  p_workspace_id uuid,
  p_invoice_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_updated integer;
begin
  update public.invoices
     set review_activity_at = clock_timestamp()
   where workspace_id = p_workspace_id
     and id = any(coalesce(p_invoice_ids, array[]::uuid[]))
     and status = 'needs_review';
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

create or replace function public.claim_due_invoice_review_retention_notices(
  p_workspace_id uuid,
  p_claim_token uuid,
  p_limit integer default 50,
  p_lease_seconds integer default 120
) returns table (notice_id uuid, invoice_id uuid, notice_days smallint)
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select n.id
      from public.invoice_review_retention_notices n
      join public.invoices i on i.id = n.invoice_id
      join public.workspaces w on w.id = n.workspace_id
     where n.workspace_id = p_workspace_id
       and n.delivered_at is null
       and n.scheduled_at <= clock_timestamp()
       and n.available_at <= clock_timestamp()
       and i.status = 'needs_review'
       and i.review_retention_expires_at is not null
       and w.review_retention_accepted_at is not null
       and w.review_retention_policy_version = i.review_retention_policy_version
       and (n.claim_expires_at is null or n.claim_expires_at <= clock_timestamp())
     order by n.notice_days desc, n.scheduled_at, n.id
     limit least(greatest(coalesce(p_limit, 50), 1), 100)
     for update of n skip locked
  )
  update public.invoice_review_retention_notices n
     set claim_token = p_claim_token,
         claim_expires_at = clock_timestamp()
           + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900))),
         attempts = n.attempts + 1
    from candidates c
   where n.id = c.id
  returning n.id, n.invoice_id, n.notice_days;
$$;

create or replace function public.finish_invoice_review_retention_notice(
  p_notice_id uuid,
  p_claim_token uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.invoice_review_retention_notices
     set delivered_at = clock_timestamp(),
         claim_token = null,
         claim_expires_at = null
   where id = p_notice_id
     and delivered_at is null
     and claim_token = p_claim_token
     and claim_expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.retry_invoice_review_retention_notice(
  p_notice_id uuid,
  p_claim_token uuid
) returns boolean
language sql
security definer
set search_path = ''
as $$
  with retried as (
    update public.invoice_review_retention_notices
       set available_at = clock_timestamp()
             + make_interval(secs => (least(3600, greatest(30, 30 * power(2, least(attempts, 7)))))::integer),
           claim_token = null,
           claim_expires_at = null
     where id = p_notice_id
       and delivered_at is null
       and claim_token = p_claim_token
       and claim_expires_at > clock_timestamp()
    returning 1
  )
  select exists (select 1 from retried);
$$;

create or replace function public.claim_expired_review_invoices(
  p_claim_token uuid,
  p_limit integer default 10,
  p_lease_seconds integer default 120
) returns table (invoice_id uuid, workspace_id uuid, object_path text, policy_version text)
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select i.id
      from public.invoices i
      join public.workspaces w on w.id = i.workspace_id
     where i.status = 'needs_review'
       and i.review_retention_expires_at <= clock_timestamp()
       and i.retention_legal_hold = false
       and i.retention_delete_available_at <= clock_timestamp()
       and (i.review_activity_at is null or i.review_activity_at <= clock_timestamp() - interval '24 hours')
       and w.review_retention_accepted_at is not null
       and w.review_retention_policy_version = i.review_retention_policy_version
       and not exists (
         select 1 from public.invoice_review_retention_notices n
          where n.invoice_id = i.id and n.notice_days in (7, 1)
            and n.delivered_at is null
       )
       and (i.retention_delete_claim_expires_at is null
            or i.retention_delete_claim_expires_at <= clock_timestamp())
     order by i.review_retention_expires_at, i.id
     limit least(greatest(coalesce(p_limit, 10), 1), 50)
     for update of i skip locked
  )
  update public.invoices i
     set retention_delete_claim_token = p_claim_token,
         retention_delete_claim_expires_at = clock_timestamp()
           + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900))),
         retention_delete_attempts = i.retention_delete_attempts + 1
    from candidates c
   where i.id = c.id
  returning i.id, i.workspace_id, i.file_object_path, i.review_retention_policy_version;
$$;

create or replace function public.finish_expired_review_invoice_retention(
  p_invoice_id uuid,
  p_workspace_id uuid,
  p_object_path text,
  p_policy_version text,
  p_claim_token uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.invoices i
    join public.workspaces w on w.id = i.workspace_id
    where i.id = p_invoice_id
      and i.workspace_id = p_workspace_id
      and i.file_object_path is not distinct from p_object_path
      and i.status = 'needs_review'
      and i.review_retention_expires_at <= clock_timestamp()
      and i.retention_legal_hold = false
      and (i.review_activity_at is null or i.review_activity_at <= clock_timestamp() - interval '24 hours')
      and i.retention_delete_claim_token = p_claim_token
      and i.retention_delete_claim_expires_at > clock_timestamp()
      and w.review_retention_accepted_at is not null
      and w.review_retention_policy_version = p_policy_version
      and i.review_retention_policy_version = p_policy_version
      and not exists (
        select 1 from public.invoice_review_retention_notices n
         where n.invoice_id = i.id and n.notice_days in (7, 1)
           and n.delivered_at is null
      )
  ) then
    return false;
  end if;

  insert into public.invoice_retention_audit (workspace_id, invoice_id, policy_version)
  values (p_workspace_id, p_invoice_id, p_policy_version);
  delete from public.processing_jobs where invoice_id = p_invoice_id;
  delete from public.invoices where id = p_invoice_id and workspace_id = p_workspace_id;
  return found;
end;
$$;

create or replace function public.retry_expired_review_invoice_retention(
  p_invoice_id uuid,
  p_claim_token uuid,
  p_error_code text
) returns boolean
language sql
security definer
set search_path = ''
as $$
  with retried as (
    update public.invoices i
       set retention_delete_available_at = clock_timestamp()
             + make_interval(secs => (least(86400, greatest(60, 60 * power(2, least(i.retention_delete_attempts, 10)))))::integer),
           retention_delete_error_code = left(coalesce(p_error_code, 'STORAGE_DELETE_FAILED'), 120),
           retention_delete_claim_token = null,
           retention_delete_claim_expires_at = null
     where i.id = p_invoice_id
       and i.retention_delete_claim_token = p_claim_token
       and i.retention_delete_claim_expires_at > clock_timestamp()
    returning 1
  )
  select exists (select 1 from retried);
$$;

revoke all on function public.touch_invoice_review_activity(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.claim_due_invoice_review_retention_notices(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_invoice_review_retention_notice(uuid, uuid) from public, anon, authenticated;
revoke all on function public.retry_invoice_review_retention_notice(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_expired_review_invoices(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_expired_review_invoice_retention(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.retry_expired_review_invoice_retention(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.touch_invoice_review_activity(uuid, uuid[]) to service_role;
grant execute on function public.claim_due_invoice_review_retention_notices(uuid, uuid, integer, integer) to service_role;
grant execute on function public.finish_invoice_review_retention_notice(uuid, uuid) to service_role;
grant execute on function public.retry_invoice_review_retention_notice(uuid, uuid) to service_role;
grant execute on function public.claim_expired_review_invoices(uuid, integer, integer) to service_role;
grant execute on function public.finish_expired_review_invoice_retention(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.retry_expired_review_invoice_retention(uuid, uuid, text) to service_role;

comment on table public.invoice_retention_audit is
  'Minimal metadata for successfully deleted unresolved invoices; contains no invoice content or sender identity.';
