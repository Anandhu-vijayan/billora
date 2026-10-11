-- Billora Phase 1 hardening: canonical batch lifecycle + conversation ready states.
-- Forward-only and rerunnable (guarded constraint swaps). Applied migrations are NOT modified.
-- Design (AGENTS master plan §4):
--   * invoice_batches adopts the batch lifecycle: collecting -> ready -> processing
--     -> completed | needs_review | failed | cancelled. Legacy 'open' rows are
--     rewritten to 'collecting' (same meaning, canonical name).
--   * whatsapp_sessions gains the IndividualReady / OrganizationReady states from
--     the conversation state machine: setup completes into a ready state, and the
--     first follow-up message promotes the sender into 'collecting'.
--   * Conversation, batch, invoice, job, and workbook keep DISTINCT lifecycles;
--     no state is merged into another table's status field.

-- 1) Batch lifecycle on invoice_batches (constraint name matches the inline
--    CHECK created by 20261002143735_initial_schema.sql).
update public.invoice_batches set status = 'collecting' where status = 'open';
alter table public.invoice_batches drop constraint if exists invoice_batches_status_check;
alter table public.invoice_batches
  add constraint invoice_batches_status_check
  check (status in (
    'collecting', 'ready', 'processing', 'completed',
    'needs_review', 'failed', 'cancelled'
  ));
alter table public.invoice_batches alter column status set default 'collecting';

-- 2) Conversation ready states on whatsapp_sessions (constraint name matches
--    the inline CHECK created by 20261010120000_whatsapp_onboarding_v1.sql).
alter table public.whatsapp_sessions drop constraint if exists whatsapp_sessions_state_check;
alter table public.whatsapp_sessions
  add constraint whatsapp_sessions_state_check
  check (state in (
    'new', 'awaiting_account_type', 'awaiting_org_name', 'awaiting_client_select',
    'awaiting_client_name', 'individual_ready', 'organization_ready',
    'collecting', 'cancelled'
  ));
