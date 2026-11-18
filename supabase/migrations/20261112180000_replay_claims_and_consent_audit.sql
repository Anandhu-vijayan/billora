-- Harden the replay queue with a claim lease and append-only consent audit evidence.

alter table public.whatsapp_webhook_payloads
  add column if not exists claim_token uuid,
  add column if not exists claim_expires_at timestamptz;

create index if not exists whatsapp_webhook_payloads_claim_idx
  on public.whatsapp_webhook_payloads (claim_expires_at)
  where claim_expires_at is not null;

create table if not exists public.workspace_consent_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  consent_kind text not null check (consent_kind in ('gemini')),
  decision text not null check (decision in ('enabled', 'withdrawn')),
  consent_version text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists workspace_consent_events_workspace_idx
  on public.workspace_consent_events (workspace_id, created_at desc);

create or replace function public.claim_replayable_whatsapp_payloads(
  p_limit integer default 1,
  p_lease_seconds integer default 300
) returns table (
  provider_message_id text,
  encrypted_payload_hex text,
  claim_token uuid,
  event_status text
)
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select p.provider_message_id,
           encode(p.encrypted_payload, 'hex') as encrypted_payload_hex,
           e.status as event_status
      from public.whatsapp_webhook_payloads p
      join public.webhook_events e using (provider_message_id)
     where p.expires_at > clock_timestamp()
       and (e.status in ('received', 'failed')
         or (e.status = 'processing' and e.claim_expires_at <= clock_timestamp()))
       and (p.claim_expires_at is null or p.claim_expires_at <= clock_timestamp())
     order by p.created_at, p.provider_message_id
     limit least(greatest(coalesce(p_limit, 1), 1), 10)
     for update of p skip locked
  )
  update public.whatsapp_webhook_payloads p
     set claim_token = gen_random_uuid(),
         claim_expires_at = clock_timestamp() + make_interval(
           secs => greatest(30, least(coalesce(p_lease_seconds, 300), 1800))
         )
    from candidates c
   where p.provider_message_id = c.provider_message_id
   returning p.provider_message_id,
             c.encrypted_payload_hex,
             p.claim_token,
             c.event_status;
$$;

create or replace function public.finish_replayable_whatsapp_payload(
  p_provider_message_id text,
  p_claim_token uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.whatsapp_webhook_payloads p
   where p.provider_message_id = p_provider_message_id
     and p.claim_token = p_claim_token
     and p.claim_expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.release_replayable_whatsapp_payload(
  p_provider_message_id text,
  p_claim_token uuid
) returns boolean
language sql
security definer
set search_path = ''
as $$
  with released as (
    update public.whatsapp_webhook_payloads p
       set claim_token = null,
           claim_expires_at = null
     where p.provider_message_id = p_provider_message_id
       and p.claim_token = p_claim_token
       and p.claim_expires_at > clock_timestamp()
    returning 1
  )
  select exists (select 1 from released);
$$;

revoke all on function public.claim_replayable_whatsapp_payloads(integer, integer)
  from public, anon, authenticated;
revoke all on function public.finish_replayable_whatsapp_payload(text, uuid)
  from public, anon, authenticated;
revoke all on function public.release_replayable_whatsapp_payload(text, uuid)
  from public, anon, authenticated;

grant execute on function public.claim_replayable_whatsapp_payloads(integer, integer)
  to service_role;
grant execute on function public.finish_replayable_whatsapp_payload(text, uuid)
  to service_role;
grant execute on function public.release_replayable_whatsapp_payload(text, uuid)
  to service_role;

comment on table public.workspace_consent_events is
  'Append-only consent audit log for workspace privacy decisions; not used to store invoice content.';
