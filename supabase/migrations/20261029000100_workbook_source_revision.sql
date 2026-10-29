-- 20261029000100_workbook_source_revision.sql
-- §6 register CONCURRENCY + VERSIONING / DELIVERY-ISOLATION metadata.
--
-- WRITE-ONLY + ADDITIVE. Deliberately NOT applied by the code; the operator
-- applies it when ready (npx supabase db push). Until then the runtime keeps the
-- EXISTING behavior byte-for-byte: the base workbook publish (retire -> monotonic
-- version -> insert ready row -> best-effort delivery) never depends on these
-- columns, and the source-revision re-check + metadata write are separate
-- FAIL-SOFT steps (see lib/jobs/handlers/build-register.ts). A register is always
-- generated and delivered exactly as before; only the extra provenance is absent.
--
-- What it adds to `public.generated_workbooks` — and why it is safe:
--   * `source_dataset_revision text` — an opaque fingerprint of the EXACT approved
--     source set (invoice membership + per-record updated_at) the workbook was
--     built from. Recorded on the row so the register's inputs are auditable, and
--     re-checked at publish time so a workbook built over a set that a reviewer
--     changed mid-build is never published as current (it requeues and rebuilds).
--   * `source_row_count integer` — how many approved invoices this workbook
--     rendered, so a count/consistency check needs no re-decrypt.
--   * `source_membership_hash bytea` — a SHA-256 of the SORTED approved
--     invoice-id set. It is a one-way digest (never the ids themselves), so it
--     adds NO new PII and lets membership be compared without exposing rows.
--   * `workbook_checksum bytea` — SHA-256 of the PLAINTEXT workbook bytes, a
--     content-integrity seal distinct from the at-rest ciphertext, so a corrupt
--     or truncated object is detectable independent of decryption.
--   * `retired_at timestamptz` — when a superseded workbook was retired, making
--     the version chain and delivery-isolation auditable (which register was
--     live when, and exactly when it stopped being servable).
--
-- All columns are NULLABLE and added with IF NOT EXISTS: no existing row or
-- read is affected, no CHECK/RLS/grant surface is widened (the table keeps its
-- current member-READ-only policy and service-role writes). Forward-only and
-- re-runnable.

alter table public.generated_workbooks
  add column if not exists source_dataset_revision text;
alter table public.generated_workbooks
  add column if not exists source_row_count integer;
alter table public.generated_workbooks
  add column if not exists source_membership_hash bytea;
alter table public.generated_workbooks
  add column if not exists workbook_checksum bytea;
alter table public.generated_workbooks
  add column if not exists retired_at timestamptz;

comment on column public.generated_workbooks.source_dataset_revision is
  '§6 opaque fingerprint of the approved source set (membership + updated_at) this workbook was built from; re-checked before publish so a mid-build source change forces a rebuild. service_role writes only.';
comment on column public.generated_workbooks.source_row_count is
  '§6 number of approved invoices rendered into this workbook (consistency, no re-decrypt needed).';
comment on column public.generated_workbooks.source_membership_hash is
  '§6 SHA-256 of the SORTED approved invoice-id set. One-way digest, never the ids; adds no PII.';
comment on column public.generated_workbooks.workbook_checksum is
  '§6 SHA-256 of the PLAINTEXT workbook bytes — a content-integrity seal independent of the at-rest ciphertext.';
comment on column public.generated_workbooks.retired_at is
  '§6 when this workbook was superseded/retired (status moved to expired), making the version chain + delivery isolation auditable.';

-- Supports the "current live register for a batch" and "recently retired for
-- audit" lookups without scanning the whole table. Guarded so re-runs are safe.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'generated_workbooks'
      and indexname = 'generated_workbooks_live_batch_idx'
  ) then
    create index generated_workbooks_live_batch_idx
      on public.generated_workbooks (workspace_id, batch_id, version desc)
      where status in ('ready', 'sent');
  end if;
end $$;
