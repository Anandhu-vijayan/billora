-- Exclusive, lease-based WhatsApp webhook claims with token fencing.
-- Apply this migration before deploying the application code that calls its RPCs.
alter table public.webhook_events
  add column if not exists claim_token uuid,
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_expires_at timestamptz;

alter table public.webhook_events drop constraint if exists webhook_events_status_ck;
alter table public.webhook_events add constraint webhook_events_status_ck
  check (status in ('received', 'processing', 'accepted', 'failed'));

create index if not exists webhook_events_expired_claim_idx
  on public.webhook_events (claim_expires_at) where status = 'processing';
drop index if exists public.webhook_events_pending_idx;
create index if not exists webhook_events_pending_idx
  on public.webhook_events (received_at)
  where processed_at is null and status in ('received', 'failed');

create or replace function public.claim_whatsapp_webhook_event(
  p_provider_message_id text, p_claim_token uuid, p_lease_seconds integer default 180
)
returns table (
  claimed boolean, created boolean, event_id uuid, provider_message_id text,
  status text, attempts integer, processed_at timestamptz, claim_expires_at timestamptz
)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_row public.webhook_events%rowtype;
begin
  if p_provider_message_id is null or length(p_provider_message_id) = 0
     or length(p_provider_message_id) > 512 or p_claim_token is null then
    raise exception 'invalid webhook claim arguments' using errcode = '22023';
  end if;

  insert into public.webhook_events (
    provider_message_id, status, attempts, claim_token, claimed_at, claim_expires_at,
    processed_at, last_error_code
  ) values (
    p_provider_message_id, 'processing', 1, p_claim_token, clock_timestamp(),
    clock_timestamp() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 900))),
    null, null
  )
  on conflict (provider_message_id) do update
    set status = 'processing',
        attempts = public.webhook_events.attempts + 1,
        claim_token = excluded.claim_token,
        claimed_at = clock_timestamp(),
        claim_expires_at = clock_timestamp() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 900))),
        processed_at = null,
        last_error_code = null
    where public.webhook_events.status in ('received', 'failed')
       or (public.webhook_events.status = 'processing'
           and public.webhook_events.claim_expires_at <= clock_timestamp())
  returning * into v_row;

  if found then
    return query select true, (v_row.attempts = 1), v_row.id, v_row.provider_message_id,
      v_row.status, v_row.attempts, v_row.processed_at, v_row.claim_expires_at;
    return;
  end if;

  select * into v_row from public.webhook_events e
   where e.provider_message_id = p_provider_message_id;
  if not found then raise exception 'webhook event disappeared during claim' using errcode = '40001'; end if;
  return query select false, false, v_row.id, v_row.provider_message_id,
    v_row.status, v_row.attempts, v_row.processed_at, v_row.claim_expires_at;
end;
$$;

create or replace function public.renew_whatsapp_webhook_event_claim(
  p_provider_message_id text, p_claim_token uuid, p_lease_seconds integer default 180
)
returns boolean language sql security definer set search_path = pg_catalog, public
as $$
  with renewed as (
    update public.webhook_events
       set claim_expires_at = clock_timestamp()
         + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 900)))
     where provider_message_id = p_provider_message_id and status = 'processing'
       and claim_token = p_claim_token and claim_expires_at > clock_timestamp()
    returning 1
  ) select exists(select 1 from renewed);
$$;

create or replace function public.complete_whatsapp_webhook_event(
  p_provider_message_id text, p_claim_token uuid, p_error_code text default null
)
returns boolean language sql security definer set search_path = pg_catalog, public
as $$
  with completed as (
    update public.webhook_events
       set status = 'accepted', processed_at = clock_timestamp(),
           last_error_code = case when p_error_code is null then null else left(p_error_code, 120) end,
           claim_token = null, claim_expires_at = null
     where provider_message_id = p_provider_message_id and status = 'processing'
       and claim_token = p_claim_token and claim_expires_at > clock_timestamp()
    returning 1
  ) select exists(select 1 from completed);
$$;

create or replace function public.fail_whatsapp_webhook_event(
  p_provider_message_id text, p_claim_token uuid, p_error_code text
)
returns boolean language sql security definer set search_path = pg_catalog, public
as $$
  with failed as (
    update public.webhook_events
       set status = 'failed', last_error_code = left(coalesce(p_error_code, 'PROCESSING_ERROR'), 120),
           claim_token = null, claim_expires_at = null
     where provider_message_id = p_provider_message_id and status = 'processing'
       and claim_token = p_claim_token and claim_expires_at > clock_timestamp()
    returning 1
  ) select exists(select 1 from failed);
$$;

revoke all on function public.claim_whatsapp_webhook_event(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.renew_whatsapp_webhook_event_claim(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_whatsapp_webhook_event(text, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_whatsapp_webhook_event(text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_webhook_event(text, uuid, integer) to service_role;
grant execute on function public.renew_whatsapp_webhook_event_claim(text, uuid, integer) to service_role;
grant execute on function public.complete_whatsapp_webhook_event(text, uuid, text) to service_role;
grant execute on function public.fail_whatsapp_webhook_event(text, uuid, text) to service_role;
