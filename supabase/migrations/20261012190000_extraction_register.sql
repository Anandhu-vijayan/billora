-- 20261012190000_extraction_register.sql
-- Stage 3: extraction -> batch -> register -> delivery.
--
-- Forward-only and re-runnable (IF NOT EXISTS / guarded DO blocks). Applied
-- migrations are NOT modified. Everything added here is service-role only: no
-- grants to anon/authenticated, and no new RLS policies, so nothing widens the
-- browser-visible surface. Design (master plan §Phase-4 + rule 3):
--   * A register_generation job is scoped to a batch, not an invoice, so the
--     queue needs a batch column + a batch-level dedup slot that mirrors the
--     invoice-level processing_jobs_target_uniq (one live register job per batch).
--   * invoice_batches gains a period-uniqueness constraint so ensure_invoice_batch
--     can resolve (workspace, client, month) idempotently under concurrency.
--   * generated_workbooks gains a monotonic version + generated_at so a re-run
--     retires the prior object instead of leaving two "latest" files.

-- 1) Queue: batch linkage + batch-level dedup for register jobs.
alter table public.processing_jobs
  add column if not exists batch_id uuid references public.invoice_batches(id) on delete cascade;

-- Register jobs carry batch_id and no invoice_id; dedup one per batch, exactly
-- as invoice jobs dedup one per (invoice_id, job_type).
create unique index if not exists processing_jobs_batch_uniq
  on public.processing_jobs (batch_id, job_type)
  where batch_id is not null and invoice_id is null;

-- Support the batch-readiness scan (outstanding extraction jobs per batch).
create index if not exists processing_jobs_batch_outstanding_idx
  on public.processing_jobs (batch_id, job_type, status)
  where batch_id is not null;

-- 2) Batches: make (workspace, client, period) resolvable idempotently. PG15+
--    "nulls not distinct" lets individuals (client null) dedup as one slot.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'invoice_batches'
      and indexname = 'invoice_batches_period_uniq'
  ) then
    create unique index invoice_batches_period_uniq
      on public.invoice_batches (workspace_id, client_id, period_start, period_end)
      nulls not distinct;
  end if;
end $$;

-- 3) Workbooks: version + generation timestamp for freshness.
alter table public.generated_workbooks
  add column if not exists version integer not null default 1 check (version >= 1);
alter table public.generated_workbooks
  add column if not exists generated_at timestamptz not null default now();

-- 4) ensure_invoice_batch: resolve-or-create the (workspace, client, month)
--    batch. SECURITY DEFINER, empty search_path, service-role only. Concurrency
--    is handled by the unique index: a losing insert re-reads the winner's row.
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
  -- Reuse an open/processing batch for this exact tenant + period.
  select b.id into v_id
  from public.invoice_batches b
  where b.workspace_id = p_workspace
    and b.client_id is not distinct from p_client
    and b.period_start is not distinct from p_start
    and b.period_end is not distinct from p_end
    and b.status in ('open', 'processing')
  limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- Create, or (on a concurrent winner) do nothing and fall through to re-read.
  insert into public.invoice_batches (workspace_id, client_id, period_start, period_end, status)
  values (p_workspace, p_client, p_start, p_end, 'open')
  on conflict (workspace_id, client_id, period_start, period_end)
  do nothing
  returning id into v_id;
  if v_id is not null then
    return v_id;
  end if;

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
  'Resolve-or-create the (workspace, client, month) invoice batch. service_role only.';
comment on column public.generated_workbooks.version is
  'Monotonic per-batch register version; a newer build retires prior rows to expired.';
