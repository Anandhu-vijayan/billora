-- 20261019000000_duplicate_prevention.sql
-- §Part-5 Layer 2: invoice-identity duplicate detection (blind index).
--
-- WRITE-ONLY + ADDITIVE. This migration is deliberately NOT applied by the code;
-- the operator applies it when ready. Until it is applied the extraction job's
-- identity_key write and prior-duplicate lookup FAIL SOFT (see the optional
-- own_gstin precedent), so duplicate detection is simply inactive and NO invoice
-- is ever blocked or lost.
--
-- What it adds — and why it is safe:
--   * `invoices.identity_key bytea` stores ONLY an HMAC-SHA256 blind index of the
--     canonical (invoice number, supplier discriminator, invoice date) under the
--     file master key. It is not reversible and never holds a plaintext financial
--     fact, so it adds no new PII at rest. Layer 1 (exact-file dedup) reuses the
--     already-stored `file_sha256` and needs NO schema change.
--   * A partial index backs the tenant-scoped lookup
--     (workspace_id, client_id, identity_key) over LIVE rows only.
--   * Service-role writes only: the column is added to an existing table whose
--     RLS and grants already govern it, so no new policy or grant is created and
--     the browser-visible surface is not widened. A duplicate is flagged for a
--     human (needs_review) and NEVER auto-dropped, auto-approved, or deleted.
--
-- Forward-only and re-runnable (IF NOT EXISTS / guarded DO block).

alter table public.invoices
  add column if not exists identity_key bytea;

comment on column public.invoices.identity_key is
  '§Part-5 HMAC-SHA256 blind index of (invoice number, supplier, date) for duplicate detection. Not reversible; never plaintext. service_role writes only.';

-- Backs the tenant-scoped prior-duplicate lookup over live invoices only.
-- Partial so deleted rows and never-keyed (NULL) rows stay out of the index.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'invoices'
      and indexname = 'invoices_identity_dup_idx'
  ) then
    create index invoices_identity_dup_idx
      on public.invoices (workspace_id, client_id, identity_key)
      where identity_key is not null and status <> 'deleted';
  end if;
end $$;
