-- 20261027000000_delivery_scope_indexes.sql
--
-- §wrong-month delivery fix (Parts 3 + 7): finalize/Done now resolves the
-- ready-register scope as (workspace, client) -> batch ids -> ready workbooks
-- instead of a workspace-wide ready sweep. Additive, forward-only index support
-- for exactly those two reads. No table/column changes, no grants, no RLS
-- changes — nothing here widens any browser-visible surface (all reads are
-- service-role only from the webhook path).
--
-- Re-runnable: every statement is IF NOT EXISTS guarded.

-- 1) Batch lookup for the client scope: (workspace, client) -> batch ids.
create index if not exists invoice_batches_workspace_client_idx
  on public.invoice_batches (workspace_id, client_id);

-- 2) Scoped ready sweep: (workspace, batch) restricted to live 'ready' rows
--    with a stored object. Partial so it stays tiny and only serves the
--    finalize/delivery read, never the historical (expired/sent) mass.
create index if not exists generated_workbooks_ready_scope_idx
  on public.generated_workbooks (workspace_id, batch_id, created_at desc)
  where status = 'ready';

comment on index public.invoice_batches_workspace_client_idx is
  'Supports client-scoped batch resolution for finalize/delivery (wrong-month guard).';
comment on index public.generated_workbooks_ready_scope_idx is
  'Supports (workspace, batch)-scoped ready-register delivery reads (wrong-month guard).';
