-- 20261013120000_privacy_extraction_exports.sql
-- Privacy-first extraction + at-rest workbook protection + retention.
--
-- Forward-only and re-runnable (IF NOT EXISTS / CREATE OR REPLACE / guarded DO).
-- Applied migrations are never modified. Everything added here is service-role
-- only: no grants to anon/authenticated and no new RLS policies, so the
-- browser-visible surface is unchanged. Covers three decisions:
--   * LOCAL-FIRST extraction records WHERE its confidence came from, so an
--     operator can distinguish a local/ai result from a review placeholder.
--   * Generated workbooks are now ENCRYPTED AT REST (octet-stream container)
--     and served only through /api/exports/[id]/download after a workspace
--     membership re-check. Track the container's key version + plaintext size.
--   * Retention/deletion: two service-role-only, idempotent RPCs return the
--     object paths of rows past retention so an operator-scheduled job can
--     remove the storage objects. (SQL cannot delete Storage objects; the sweep
--     is a separate authorized admin step — see scripts + ops runbook.)

-- 1) extracted_records: provenance of the review decision. Default 'human' is
--    the honest fallback for a row written when no local engine ran and AI was
--    disabled — a placeholder that must be reviewed, never a fabricated value.
alter table public.extracted_records
  add column if not exists confidence_source text not null default 'human'
    check (confidence_source in ('local', 'ai', 'human'));

-- 2) generated_workbooks: the encrypted container's wrapping key version (for
--    rotation auditing + decrypt) and the original plaintext byte length.
alter table public.generated_workbooks
  add column if not exists file_encryption_key_version text;
alter table public.generated_workbooks
  add column if not exists size_bytes bigint
    check (size_bytes is null or size_bytes >= 0);

-- Support the retention sweep's expiry scan without a sequential scan.
create index if not exists generated_workbooks_expiry_idx
  on public.generated_workbooks (expires_at)
  where expires_at is not null;

-- 3) Exports bucket storage-compat: the register is now uploaded as an opaque
--    AES-256-GCM container (application/octet-stream). Keep the spreadsheetml
--    MIME for any transitional plaintext object until the legacy set rolls off.
--    Private flag and any size limit are left exactly as provisioned; we only
--    touch allowed_mime_types on the one bucket.
update storage.buckets
  set allowed_mime_types = array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
  where id = 'billora-exports';

-- 4) Retention: purge expired workbooks. Deletes rows that are already
--    retired/deleted or whose link lapsed, and RETURNS their object paths so an
--    operator job can remove the storage objects. SECURITY DEFINER, empty
--    search_path, service-role only.
create or replace function public.purge_expired_workbooks(p_now timestamptz)
returns setof text
language sql
security definer
set search_path = ''
as $$
  with d as (
    delete from public.generated_workbooks
     where status in ('expired', 'deleted')
        or (expires_at is not null and expires_at < p_now)
     returning file_object_path
  )
  select file_object_path from d where file_object_path is not null;
$$;

comment on function public.purge_expired_workbooks(timestamptz) is
  'Delete retired/expired workbook rows; returns object paths for storage cleanup. service_role only.';

-- 5) Retention: purge invoices past their retention horizon. Deletes dependent
--    queue rows first (their FK does not cascade), then the invoices; the
--    extracted_records FK cascades automatically. Returns invoice object paths
--    so the originals can be removed from Storage by the operator sweep. This
--    is a policy hook, NOT a claim of a legally-mandated duration — the caller
--    sets retention_expires_at per its own (counsel-reviewed) retention policy.
create or replace function public.purge_expired_invoices(p_now timestamptz)
returns setof text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select array_agg(id) into v_ids
    from public.invoices
   where retention_expires_at is not null
     and retention_expires_at < p_now;

  if v_ids is null or array_length(v_ids, 1) is null then
    return;
  end if;

  -- Clear queue rows first: processing_jobs -> invoices is a plain FK (no
  -- cascade). extracted_records cascades on the invoice delete below.
  delete from public.processing_jobs where invoice_id = any (v_ids);

  return query
    with d as (
      delete from public.invoices
       where id = any (v_ids)
      returning file_object_path
    )
    select file_object_path from d where file_object_path is not null;
end;
$$;

comment on function public.purge_expired_invoices(timestamptz) is
  'Delete invoices past retention_expires_at (cascades extracted_records); returns object paths. service_role only.';

-- Lock both down to service_role: no browser/anon access to retention sweeps.
revoke all on function public.purge_expired_workbooks(timestamptz) from public, anon, authenticated;
revoke all on function public.purge_expired_invoices(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_expired_workbooks(timestamptz) to service_role;
grant execute on function public.purge_expired_invoices(timestamptz) to service_role;
