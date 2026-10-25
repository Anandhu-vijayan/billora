-- 20261025000000_review_edit.sql — Phase 3 editable WhatsApp review.
-- Forward-only and rerunnable (IF NOT EXISTS / guarded constraint swaps).
-- Applied migrations are NOT modified. whatsapp_sessions is already RLS-enabled
-- and service-role only; adding a column grants no new access — same pattern as
-- 20261012120000 (delivery bookkeeping) and 20261011150000 (pending_client_id).
--
-- Design (master plan §7 — editable review):
--   * A reviewer can now open a flagged invoice IN-CHAT and correct individual
--     fields before approving. The conversation machine gains one sub-state,
--     'awaiting_review_edit', entered by tapping an "Edit" row and exited by
--     CANCEL or a successful APPROVE.
--   * Like pending_client_id, the invoice currently being edited is persisted on
--     the session row (review_edit_invoice_id) so the open editor survives a
--     process restart and a webhook redelivery, and never silently retargets to a
--     different invoice. It references public.invoices(id) ON DELETE SET NULL: if
--     the invoice is removed the session simply leaves the editor, holding nothing
--     dangling. Correcting a field persists to the ENCRYPTED extracted_records
--     payload (plus its in-payload correction audit), so NO new column is needed
--     for values or history — only this navigation pointer is.

-- 1) The invoice open in the in-chat editor (edit sub-state only).
alter table public.whatsapp_sessions add column if not exists review_edit_invoice_id uuid
  references public.invoices(id) on delete set null;

-- 2) Widen the conversation state CHECK with the editor sub-state. The set below
--    is the authoritative 20261011150000 list plus 'awaiting_review_edit'; the
--    drop/add swap keeps it idempotent if re-run.
alter table public.whatsapp_sessions drop constraint if exists whatsapp_sessions_state_check;
alter table public.whatsapp_sessions
  add constraint whatsapp_sessions_state_check
  check (state in (
    'new', 'awaiting_account_type', 'awaiting_org_name', 'awaiting_client_select',
    'awaiting_client_name', 'individual_ready', 'organization_ready',
    'awaiting_pending_confirm', 'awaiting_review_edit', 'collecting', 'cancelled'
  ));
