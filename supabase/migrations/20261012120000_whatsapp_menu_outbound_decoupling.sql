-- 20261012120000_whatsapp_menu_outbound_decoupling.sql
-- Stage 2: interactive menu + inbound/outbound decoupling bookkeeping.
--
-- The inbound webhook_events ledger stays the idempotency source of truth (this
-- migration does not touch it). These nullable columns only track OUTBOUND
-- delivery so a failed reply can be resent later WITHOUT re-running any business
-- operation that already succeeded (rule 5: processing success != delivery).
-- whatsapp_sessions is already RLS-enabled and service-role only; adding columns
-- grants no new access. Forward-only + re-runnable (IF NOT EXISTS).

-- A transient reply failure is recorded (short code) and the text reply is
-- remembered so the sender's NEXT inbound message can best-effort resend it.
alter table public.whatsapp_sessions
  add column if not exists last_reply_error_code text;
alter table public.whatsapp_sessions
  add column if not exists pending_reply_body text;

-- Marks the moment the first "Invoice received…" acknowledgment was sent for
-- this session, so subsequent clean uploads are not re-acked (no nagging).
alter table public.whatsapp_sessions
  add column if not exists upload_ack_sent_at timestamptz;
