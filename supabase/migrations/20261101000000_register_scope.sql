-- 20261101000000_register_scope.sql
--
-- §register-scope: a register's accounting month becomes a VALIDATED property of
-- the register itself and of each invoice — not a value copied out of one batch's
-- period_start at read time. Two additive, forward-only, nullable changes let the
-- generator (a) gather every approved invoice for (workspace, client, month) ACROSS
-- batches, (b) drop any invoice whose own date does not fall in the month it is being
-- filed into, and (c) name/label a delivered workbook from the scope it was actually
-- built for.
--
--   1) invoices.invoice_month (text 'YYYY-MM'): the canonical accounting month an
--      invoice was filed under, derived ONLY from a reliably parsed invoice date —
--      the same guard resolveInvoiceBatch uses to assign batch_id. This is the
--      cross-batch register scope key: a mis-tagged batch_id can no longer leave an
--      invoice out of — or drop it into — the wrong month's register. NULL = the
--      invoice is not yet reliably dated/batched (unchanged: it stays visible in
--      review and is never filed on a guessed month).
--
--   2) generated_workbooks.period_start / period_end (date): the validated scope
--      period the workbook was built for, stamped at publish. The download filename,
--      the in-chat delivery filename, and the Done/Review month label now read the
--      workbook's OWN period instead of reaching into invoice_batches, so a delivered
--      file can never be named for a month its contents disagree with. NULL on legacy
--      rows -> every reader falls back to the batch period, byte-for-byte prior
--      behaviour.
--
-- WRITE-only + ADDITIVE + NULLABLE. No grant/RLS surface is widened (service-role
-- writes only; the new columns inherit the existing table RLS). Existing rows are
-- backfilled best-effort from their batch so the new read path is complete before the
-- runtime repopulates them on the next approval/rebuild.

-- 1) canonical accounting month on the invoice -------------------------------
alter table public.invoices
  add column if not exists invoice_month text
    check (invoice_month is null or invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

comment on column public.invoices.invoice_month is
  '§register-scope: YYYY-MM accounting month resolved from the invoice''s own reliably-parsed date; the cross-batch register scope key. NULL = undated/unbatched.';

-- Backs the (workspace, client, month) cross-batch gather of approved invoices,
-- partial so undated/unbatched rows never bloat the index. Guarded for re-runs.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'invoices'
      and indexname = 'invoices_scope_month_idx'
  ) then
    create index invoices_scope_month_idx
      on public.invoices (workspace_id, client_id, invoice_month)
      where invoice_month is not null and status <> 'deleted';
  end if;
end $$;

-- Backfill already-batched invoices from their batch period. Batch assignment is
-- date-driven, so the batch month is the best available proven value; build-time
-- validation against the invoice's own decrypted date is the real guard regardless.
update public.invoices i
  set invoice_month = to_char(b.period_start, 'YYYY-MM')
  from public.invoice_batches b
  where i.batch_id = b.id and i.workspace_id = b.workspace_id
    and i.invoice_month is null and b.period_start is not null;

-- 2) the workbook's own validated period -------------------------------------
alter table public.generated_workbooks
  add column if not exists period_start date,
  add column if not exists period_end date;

comment on column public.generated_workbooks.period_start is
  '§register-scope: the validated accounting period this register file was generated for; the filename/label source. NULL on legacy rows -> read falls back to the batch period.';
comment on column public.generated_workbooks.period_end is
  '§register-scope: end of the validated period stamped at publish. NULL on legacy rows.';

-- Backfill existing rows from their batch so the new read path is complete for
-- already-issued registers (no live workbook is left naming a month it lacks).
update public.generated_workbooks w
  set period_start = b.period_start, period_end = b.period_end
  from public.invoice_batches b
  where w.batch_id = b.id and w.workspace_id = b.workspace_id
    and w.period_start is null;
