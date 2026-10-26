-- 20261026000000_client_own_gstin.sql — P0 supplier/buyer GSTIN integrity.
-- Forward-only and rerunnable (IF NOT EXISTS / guarded constraint swaps).
-- Applied migrations are NOT modified. RLS/grants on public.clients are unchanged:
-- this only adds a nullable column, so no new access is granted and no existing
-- policy is affected.
--
-- Design (master plan P0 §1):
--   * A purchase bill's BUYER is the workspace client. When that client's own GSTIN
--     is known, any GSTIN equal to it can never be the SUPPLIER (the seller who
--     issued the bill). Extraction cross-checks every stored/exported row against
--     this value, which closes the AI-path gap where a buyer GSTIN was silently
--     shipped as the supplier because no recipient token had been parsed.
--   * Set deliberately, optionally. It is validated in the application with the
--     existing GSTIN mod-36 checksum before it is ever written; the CHECK here is
--     a shape-only backstop (state/UT digits, PAN block, entity digit, 'Z',
--     checksum slot) that still permits NULL (unset) so existing rows are untouched.
--   * The learn-from-usage rule (a recipient GSTIN recurring on >=3 of a client's
--     invoices) only ever SUGGESTS this value for human confirmation; nothing is
--     applied silently. That logic lives in the app, not here.

alter table public.clients
  add column if not exists own_gstin text;

-- Guarded, idempotent shape backstop. Drop-then-add so re-running against a
-- database that already has an older version of the constraint is safe.
alter table public.clients drop constraint if exists clients_own_gstin_shape_check;
alter table public.clients
  add constraint clients_own_gstin_shape_check
  check (
    own_gstin is null
    or own_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
  );
