-- 20261013130000_fix_batch_period_status.sql
-- Fix: ensure_invoice_batch wrote/read the legacy 'open' batch status, which the
-- Phase-1 lifecycle migration (20261011000000) replaced with 'collecting' in the
-- invoice_batches_status_check. Since 'open' is no longer permitted, the resolver
-- raised a CHECK violation on the very first (workspace, client, month) batch it
-- tried to create, so NO batch was ever assigned and NO register job was ever
-- scheduled (the "Done produces nothing / needs_review invoices are never batched"
-- bug). Forward-only and re-runnable: it only re-defines the same function body.
--
-- Same tenant model as the original: SECURITY DEFINER, empty search_path,
-- service-role only (no anon/authenticated access). Nothing else changes.
create or replace function public.ensure_invoice_batch(
  p_workspace uuid,
  p_client uuid,
  p_start date,
  p_end date
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- Reuse an in-flight batch for this exact tenant + period. 'collecting' is the
  -- canonical open state since the Phase-1 lifecycle migration; 'processing' is a
  -- batch a register build is currently working through.
  select b.id into v_id
  from public.invoice_batches b
  where b.workspace_id = p_workspace
    and b.client_id is not distinct from p_client
    and b.period_start is not distinct from p_start
    and b.period_end is not distinct from p_end
    and b.status in ('collecting', 'processing')
  limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- Create, or (on a concurrent winner) do nothing and fall through to re-read.
  insert into public.invoice_batches (workspace_id, client_id, period_start, period_end, status)
  values (p_workspace, p_client, p_start, p_end, 'collecting')
  on conflict (workspace_id, client_id, period_start, period_end)
  do nothing
  returning id into v_id;
  if v_id is not null then
    return v_id;
  end if;

  -- A terminal batch (completed/needs_review/...) already exists for this period:
  -- converge on it instead of leaving the invoice unbatched.
  select b.id into v_id
  from public.invoice_batches b
  where b.workspace_id = p_workspace
    and b.client_id is not distinct from p_client
    and b.period_start is not distinct from p_start
    and b.period_end is not distinct from p_end
  limit 1;
  return v_id;
end;
$$;

revoke all on function public.ensure_invoice_batch(uuid, uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.ensure_invoice_batch(uuid, uuid, date, date)
  to service_role;

comment on function public.ensure_invoice_batch(uuid, uuid, date, date) is
  'Resolve-or-create the (workspace, client, month) invoice batch. service_role only. Uses the canonical "collecting" open status.';
