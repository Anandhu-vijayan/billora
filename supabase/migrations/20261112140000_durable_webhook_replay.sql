-- Store encrypted, replayable WhatsApp message envelopes independently of the
-- provider's redelivery window. Plain sender/message data never enters SQL.

create table if not exists public.whatsapp_webhook_payloads (
  provider_message_id text primary key
    references public.webhook_events(provider_message_id) on delete cascade,
  encrypted_payload bytea not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '72 hours')
);

alter table public.whatsapp_webhook_payloads enable row level security;
revoke all on public.whatsapp_webhook_payloads from public, anon, authenticated;

create index if not exists whatsapp_webhook_payloads_expiry_idx
  on public.whatsapp_webhook_payloads (expires_at);

create or replace function public.store_whatsapp_webhook_payload(
  p_provider_message_id text,
  p_payload_hex text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_provider_message_id is null or length(p_provider_message_id) = 0
     or length(p_provider_message_id) > 512
     or p_payload_hex is null or length(p_payload_hex) = 0
     or length(p_payload_hex) > 131072 then
    raise exception 'invalid webhook payload arguments' using errcode = '22023';
  end if;

  insert into public.webhook_events (provider_message_id, status, attempts)
  values (p_provider_message_id, 'received', 0)
  on conflict (provider_message_id) do nothing;

  select e.status into v_status
    from public.webhook_events e
   where e.provider_message_id = p_provider_message_id
   for update;

  if v_status = 'accepted' then
    return false;
  end if;

  insert into public.whatsapp_webhook_payloads (
    provider_message_id, encrypted_payload, expires_at
  ) values (
    p_provider_message_id, decode(p_payload_hex, 'hex'),
    clock_timestamp() + interval '72 hours'
  )
  on conflict (provider_message_id) do update
    set encrypted_payload = excluded.encrypted_payload,
        expires_at = excluded.expires_at;
  return true;
end;
$$;

create or replace function public.list_replayable_whatsapp_payloads(p_limit integer default 1)
returns table (
  provider_message_id text,
  encrypted_payload_hex text,
  event_status text
)
language sql
security definer
set search_path = ''
as $$
  select p.provider_message_id, encode(p.encrypted_payload, 'hex'), e.status
    from public.whatsapp_webhook_payloads p
    join public.webhook_events e using (provider_message_id)
   where p.expires_at > clock_timestamp()
     and (
       e.status in ('received', 'failed')
       or (e.status = 'processing' and e.claim_expires_at <= clock_timestamp())
     )
   order by p.created_at, p.provider_message_id
   limit least(greatest(coalesce(p_limit, 1), 1), 10);
$$;

create or replace function public.purge_expired_whatsapp_payloads()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.whatsapp_webhook_payloads
   where expires_at <= clock_timestamp();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.complete_whatsapp_webhook_event(
  p_provider_message_id text, p_claim_token uuid, p_error_code text default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_completed boolean := false;
begin
  update public.webhook_events
     set status = 'accepted',
         processed_at = clock_timestamp(),
         last_error_code = case when p_error_code is null then null else left(p_error_code, 120) end,
         claim_token = null,
         claim_expires_at = null
   where provider_message_id = p_provider_message_id
     and status = 'processing'
     and claim_token = p_claim_token
     and claim_expires_at > clock_timestamp();
  v_completed := found;

  if v_completed then
    delete from public.whatsapp_webhook_payloads
     where provider_message_id = p_provider_message_id;
  end if;
  return v_completed;
end;
$$;

revoke all on function public.store_whatsapp_webhook_payload(text, text)
  from public, anon, authenticated;
revoke all on function public.list_replayable_whatsapp_payloads(integer)
  from public, anon, authenticated;
revoke all on function public.purge_expired_whatsapp_payloads()
  from public, anon, authenticated;
revoke all on function public.complete_whatsapp_webhook_event(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.store_whatsapp_webhook_payload(text, text) to service_role;
grant execute on function public.list_replayable_whatsapp_payloads(integer) to service_role;
grant execute on function public.purge_expired_whatsapp_payloads() to service_role;
grant execute on function public.complete_whatsapp_webhook_event(text, uuid, text) to service_role;

comment on table public.whatsapp_webhook_payloads is
  'Short-lived AES-GCM-encrypted normalized webhook messages for recovery independent of provider redelivery.';
