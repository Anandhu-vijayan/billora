-- 20261030000000_workbook_deliveries.sql
--
-- Durable WhatsApp workbook DELIVERY outbox + atomic-claim state machine.
--
-- WHY (root cause of "September file never arrived"): the old path stored every
-- register handoff in the SINGLE `whatsapp_sessions.pending_reply_body` text
-- column via an unguarded read-modify-write, so two concurrent per-batch builds
-- clobbered each other's `[[deliver:<id>]]` token and only the last-writer's
-- workbook ever reached the chat. A successful proactive push also nulled the
-- whole slot, erasing another workbook's pending token. One free-text column
-- cannot be the authoritative record of multiple independent deliveries.
--
-- WHAT this adds — one row per (workbook, recipient) with its OWN status, claim
-- token, lease and attempt/backoff, so:
--   * every ready workbook gets an independent, durable delivery record,
--   * concurrent workers/restarts can NEVER double-send or lose a delivery
--     (claims are atomic under FOR UPDATE SKIP LOCKED, fenced by claim_token),
--   * generation success is fully decoupled from send success (a failed send
--     leaves the workbook 'ready' and the row retryable),
--   * an uncertain send lands in 'unknown' and is NEVER blindly resent.
--
-- POSTURE: forward-only, re-runnable (IF NOT EXISTS / guarded DO blocks).
-- Service-role only — no grants to anon/authenticated and no new RLS policy
-- widening any browser-visible surface (mirrors the lock-down of the other
-- operational tables). The recipient is stored ONLY as its HMAC (the raw phone
-- number is never persisted anywhere). Until this migration is applied the
-- runtime keeps the legacy next-inbound behavior; applying it turns on the
-- durable outbox path (see lib/jobs/handlers/deliver-register.ts).

-- ---------------------------------------------------------------------------
-- 1) The outbox table.
-- ---------------------------------------------------------------------------
create table if not exists public.workbook_deliveries (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  workbook_id            uuid not null,
  -- The owner this register is addressed to — the sender HMAC, NEVER a phone.
  recipient_sender_hmac  text not null,
  -- pending -> sending -> sent | failed | unknown. 'sending' always carries a
  -- live claim_token + claim_expires_at lease; recovery moves stale leases to
  -- 'unknown' (not auto-resent) because Meta may have accepted the send even if
  -- we crashed before saving the response.
  status                 text not null default 'pending'
                           check (status in ('pending', 'sending', 'sent', 'failed', 'unknown')),
  attempt_count          integer not null default 0 check (attempt_count >= 0),
  next_attempt_at        timestamptz not null default now(),
  claimed_at             timestamptz,
  claim_token            text,
  claim_expires_at       timestamptz,
  provider_message_id    text,
  last_error             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  sent_at                timestamptz,
  -- One logical delivery per workbook + recipient: makes the publish-side write
  -- an idempotent UPSERT (a rebuild/re-delivery never forks a second row).
  unique (workspace_id, workbook_id, recipient_sender_hmac),
  -- Composite FK: a delivery can only ever reference a workbook in its OWN
  -- workspace, so a cross-tenant workbook id can never be attached here.
  foreign key (workbook_id, workspace_id)
    references public.generated_workbooks(id, workspace_id) on delete cascade
);

-- Due-work pickup: rows eligible to claim, oldest first. Partial so it never
-- scans the (large) historical sent/expired mass.
create index if not exists workbook_deliveries_due_idx
  on public.workbook_deliveries (recipient_sender_hmac, next_attempt_at)
  where status in ('pending', 'failed');

-- Expired-lease recovery sweep: 'sending' rows whose claim lapsed.
create index if not exists workbook_deliveries_lease_idx
  on public.workbook_deliveries (claim_expires_at)
  where status = 'sending';

-- Tenant join helper (workspace-scoped reads/counts).
create index if not exists workbook_deliveries_workspace_idx
  on public.workbook_deliveries (workspace_id, status);

alter table public.workbook_deliveries enable row level security;

-- No policy grants any anon/authenticated access: reads and writes are
-- service-role only, from the webhook/worker path (RLS with zero policies
-- denies every non-service role).

comment on table public.workbook_deliveries is
  'Durable per-(workbook,recipient) WhatsApp delivery outbox with an atomic-claim state machine. service_role only.';
comment on column public.workbook_deliveries.recipient_sender_hmac is
  'The owner HMAC this register is addressed to. Never a raw phone number.';
comment on column public.workbook_deliveries.claim_token is
  'Ownership fence: only the worker whose claim_token matches may mark/release a sending row.';
comment on column public.workbook_deliveries.status is
  'pending -> sending -> sent | failed | unknown. unknown = uncertain send, never auto-resent.';

-- ---------------------------------------------------------------------------
-- 2) Atomic claim. Transitions due pending/failed rows for ONE recipient to
--    'sending' under FOR UPDATE SKIP LOCKED (a concurrent caller never grabs the
--    same rows), stamps a fresh claim_token + lease, and bumps attempt_count.
--    Returns the claimed rows so the caller can send them.
-- ---------------------------------------------------------------------------
create or replace function public.claim_workbook_deliveries(
  p_recipient_sender_hmac text,
  p_limit integer default 5,
  p_lease_seconds integer default 120
) returns setof public.workbook_deliveries
language sql
security definer
set search_path = ''
as $$
  update public.workbook_deliveries d
     set status            = 'sending',
         claim_token       = gen_random_uuid()::text,
         claimed_at        = now(),
         claim_expires_at  = now() + make_interval(secs => greatest(1, p_lease_seconds)),
         attempt_count     = d.attempt_count + 1,
         updated_at        = now()
   where d.id in (
     select c.id
       from public.workbook_deliveries c
      where c.recipient_sender_hmac = p_recipient_sender_hmac
        and c.status in ('pending', 'failed')
        and c.next_attempt_at <= now()
      order by c.next_attempt_at, c.created_at
      limit greatest(1, least(p_limit, 25))
      for update skip locked
   )
   returning d.*;
$$;

-- ---------------------------------------------------------------------------
-- 3) Confirm a send. Only the current claim_token holder, on a 'sending' row,
--    can mark it 'sent'. Fenced so a stale/expired worker cannot settle a row a
--    newer worker now owns.
-- ---------------------------------------------------------------------------
create or replace function public.mark_workbook_delivery_sent(
  p_id uuid,
  p_claim_token text,
  p_provider_message_id text default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workbook_deliveries
     set status             = 'sent',
         sent_at            = now(),
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         last_error         = null,
         claim_token        = null,
         claimed_at         = null,
         claim_expires_at   = null,
         updated_at         = now()
   where id = p_id
     and claim_token = p_claim_token
     and status = 'sending';
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Release a transiently-failed send back to 'failed' with a safe retry delay,
--    clearing the claim so it becomes claimable again at next_attempt_at. Only
--    the claim_token holder may do this.
-- ---------------------------------------------------------------------------
create or replace function public.release_workbook_delivery(
  p_id uuid,
  p_claim_token text,
  p_retry_seconds integer default 30,
  p_last_error text default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workbook_deliveries
     set status           = 'failed',
         last_error       = p_last_error,
         next_attempt_at  = now() + make_interval(secs => greatest(1, p_retry_seconds)),
         claim_token      = null,
         claimed_at       = null,
         claim_expires_at = null,
         updated_at       = now()
   where id = p_id
     and claim_token = p_claim_token
     and status = 'sending';
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Resolve an UNCERTAIN send. When the outcome is unknown (crash/timeout after
--    Meta may have accepted), the claimer moves the row to an explicit final
--    state instead of risking a duplicate. Allowed targets: 'unknown' (needs
--    reconciliation) or 'sent'/'failed' if the caller later confirms. NEVER
--    re-arms to 'pending' — an unknown is not blindly resent.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_workbook_delivery(
  p_id uuid,
  p_claim_token text,
  p_final_state text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_final_state not in ('unknown', 'sent', 'failed') then
    return false;
  end if;
  update public.workbook_deliveries
     set status           = p_final_state,
         sent_at          = case when p_final_state = 'sent' then now() else sent_at end,
         claim_token      = null,
         claimed_at       = null,
         claim_expires_at = null,
         updated_at       = now()
   where id = p_id
     and claim_token = p_claim_token
     and status = 'sending';
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Expired-lease recovery. A 'sending' row whose lease lapsed means its worker
--    died mid-send — the send may or may not have reached Meta, so it moves to
--    'unknown' (NOT back to 'pending'), which the reconciliation path handles.
--    Returns how many rows were recovered.
-- ---------------------------------------------------------------------------
create or replace function public.recover_expired_delivery_leases()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.workbook_deliveries
     set status           = 'unknown',
         last_error       = coalesce(last_error, 'LEASE_EXPIRED_UNCONFIRMED'),
         claim_token      = null,
         claimed_at       = null,
         claim_expires_at = null,
         updated_at       = now()
   where status = 'sending'
     and claim_expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Legacy backfill. For an owner whose workspace has 'ready' workbooks that
--    predate the outbox (no delivery row), create pending rows so they get
--    delivered on the next inbound. Restricted to still-'ready' workbooks:
--    deliverWorkbookToWhatsApp is idempotent (ready->sent), so a workbook that
--    was already delivered is 'sent' and never re-picked — legacy recovery can
--    NOT blindly resend an already-sent file. Returns rows enqueued.
-- ---------------------------------------------------------------------------
create or replace function public.backfill_missing_deliveries(
  p_workspace_id uuid,
  p_recipient_sender_hmac text
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.workbook_deliveries
    (workspace_id, workbook_id, recipient_sender_hmac, status)
  select w.workspace_id, w.id, p_recipient_sender_hmac, 'pending'
    from public.generated_workbooks w
   where w.workspace_id = p_workspace_id
     and w.status = 'ready'
     and w.file_object_path is not null
     and not exists (
       select 1 from public.workbook_deliveries d
        where d.workbook_id = w.id
          and d.recipient_sender_hmac = p_recipient_sender_hmac
     );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: service-role only; nothing callable from the public API surface.
-- ---------------------------------------------------------------------------
revoke all on function public.claim_workbook_deliveries(text, integer, integer)  from public, anon, authenticated;
revoke all on function public.mark_workbook_delivery_sent(uuid, text, text)      from public, anon, authenticated;
revoke all on function public.release_workbook_delivery(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.resolve_workbook_delivery(uuid, text, text)        from public, anon, authenticated;
revoke all on function public.recover_expired_delivery_leases()                  from public, anon, authenticated;
revoke all on function public.backfill_missing_deliveries(uuid, text)            from public, anon, authenticated;

grant execute on function public.claim_workbook_deliveries(text, integer, integer)  to service_role;
grant execute on function public.mark_workbook_delivery_sent(uuid, text, text)      to service_role;
grant execute on function public.release_workbook_delivery(uuid, text, integer, text) to service_role;
grant execute on function public.resolve_workbook_delivery(uuid, text, text)        to service_role;
grant execute on function public.recover_expired_delivery_leases()                  to service_role;
grant execute on function public.backfill_missing_deliveries(uuid, text)            to service_role;

comment on function public.claim_workbook_deliveries(text, integer, integer) is
  'Atomically claim due pending/failed deliveries for one recipient (SKIP LOCKED). service_role only.';
comment on function public.recover_expired_delivery_leases() is
  'Move lapsed sending leases to unknown (never auto-resent). service_role only.';
