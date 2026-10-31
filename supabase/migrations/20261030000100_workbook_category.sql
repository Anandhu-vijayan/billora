-- 20261030000100_workbook_category.sql
--
-- §separate-files-per-category: a monthly register is now emitted as ONE FILE
-- PER accounting category, not one multi-sheet workbook. Each generated_workbooks
-- row records WHICH category it renders so:
--   * a batch's purchase / expense / fixed-asset / ... files are distinct rows
--     with distinct object keys (see deriveWorkbookKey's category seed),
--   * the delivery outbox + the chat can name each file honestly
--     ("September 2026 (Expense)"), and
--   * the "current register for a batch" query can pick the right file per scope.
--
-- WRITE-ONLY + ADDITIVE + NULLABLE. Existing rows keep accounting_category = NULL
-- (historically the single multi-sheet register); the runtime treats NULL as the
-- primary 'purchase' scope, byte-for-byte matching prior behavior. Forward-only
-- and re-runnable. Service-role writes only — no grant/RLS surface is widened.

alter table public.generated_workbooks
  add column if not exists accounting_category text;

comment on column public.generated_workbooks.accounting_category is
  '§separate-files-per-category: the accounting category this register file renders (purchase/expense/service/fixed_asset/capital_purchase/sales/other/unknown). NULL = the historical single register, read as purchase.';

-- Supports "the current live file(s) for a batch, by category" without a full
-- scan, and keeps the per-batch retire/version lookups cheap as categories grow.
-- Guarded so re-runs are safe. (Deliberately NOT unique: a rebuild briefly holds
-- the prior + new version of a category 'ready' before the prior is retired, and
-- version ordering — not a uniqueness constraint — picks the current one.)
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'generated_workbooks'
      and indexname = 'generated_workbooks_batch_category_idx'
  ) then
    create index generated_workbooks_batch_category_idx
      on public.generated_workbooks (workspace_id, batch_id, accounting_category, version desc)
      where status in ('ready', 'sent');
  end if;
end $$;
