-- 20261012000000_invoice_storage_encryption.sql
-- Stage 1: envelope encryption of original invoice files + opaque HMAC paths.
--
-- Forward-only and re-runnable. Adds the columns the encrypted intake records
-- (key version for rotation auditing + plaintext size for accounting) and opens
-- the invoices bucket to the octet-stream transport type that encrypted
-- containers upload as. Logical media typing is unchanged: invoices.content_type
-- still CHECKs to pdf/jpeg/png (the media type extraction routes on), while the
-- stored *blob* is an opaque AES-256-GCM container uploaded as octet-stream.
--
-- The exports bucket is deliberately untouched this stage: generated workbooks
-- still upload as plaintext spreadsheetml until Stage 3 adds their own scheme.

-- 1) invoices: track the wrapping key version + the original plaintext size.
alter table public.invoices
  add column if not exists file_encryption_key_version text;
alter table public.invoices
  add column if not exists size_bytes bigint
    check (size_bytes is null or size_bytes >= 0);

-- 2) pending_uploads: same key version so a later assignment can resolve the
--    held container. size_bytes already exists on this table.
alter table public.pending_uploads
  add column if not exists file_encryption_key_version text;

-- 3) Storage-compat for encrypted uploads: allow octet-stream on the invoices
--    bucket so the encrypted container uploads. Keeps pdf/jpeg/png for any
--    transitional plaintext object until the legacy re-encrypt completes.
update storage.buckets
  set allowed_mime_types = array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/octet-stream'
  ]
  where id = 'billora-invoices';

-- billora-exports allowed_mime_types is intentionally preserved exactly
-- (array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']).
