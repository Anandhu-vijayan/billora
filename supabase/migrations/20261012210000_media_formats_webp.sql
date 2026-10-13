-- 20261012210000_media_formats_webp.sql
-- Support WebP end to end + make the invoices bucket accept the encrypted
-- container's transport type. Forward-only and re-runnable.
--
-- Why: the extraction vision pipeline (lib/ocr/vision.ts SUPPORTED_MIME) already
-- accepts image/webp, and intake now sniffs the REAL bytes and persists the
-- VALIDATED MIME. But both the invoices/pending_uploads content_type CHECKs and
-- the bucket allowed_mime_types predate WebP, so a validated WebP invoice would
-- hit a DB CHECK and a mislabeled upload could hit the bucket MIME list. The
-- encrypted container is always uploaded as application/octet-stream; the
-- invoice_storage_encryption migration introduces that transport type and this
-- file re-asserts the full permitted set idempotently, so an environment that
-- applies either ordering lands in the same consistent state.
--
-- Security posture is unchanged: the bucket stays private (no policy edits here)
-- and keeps its existing 20 MiB per-file limit; only the permitted MIME set is
-- widened. NOT NULL on pending_uploads.content_type is preserved (we touch only
-- the CHECK constraint, never the nullability). HEIC/HEIF is intentionally NOT
-- added — no converter is a declared dependency, so intake rejects it with a
-- clear reply instead of storing something the pipeline cannot extract.

-- 1) invoices.content_type: allow image/webp (keep pdf/jpeg/png + nullable).
--    Drop any existing content_type CHECK by discovered name, then re-add.
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
     where rel.relname = 'invoices'
       and rel.relnamespace = current_schema()::regnamespace
       and con.contype = 'c'
       and con.conname like '%content_type%'
  loop
    execute format('alter table public.invoices drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.invoices
  add constraint invoices_content_type_check
  check (content_type is null or content_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp'
  ));

-- 2) pending_uploads.content_type: same widened set (NOT NULL is untouched).
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
     where rel.relname = 'pending_uploads'
       and rel.relnamespace = current_schema()::regnamespace
       and con.contype = 'c'
       and con.conname like '%content_type%'
  loop
    execute format('alter table public.pending_uploads drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.pending_uploads
  add constraint pending_uploads_content_type_check
  check (content_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp'
  ));

-- 3) invoices bucket: accept the encrypted container transport type + WebP,
--    re-asserting the full set. Private flag and size limit are left exactly as
--    provisioned; we only update allowed_mime_types on the one bucket.
update storage.buckets
  set allowed_mime_types = array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/octet-stream'
  ]
  where id = 'billora-invoices';
