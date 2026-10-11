-- Billora Phase 3: durable job queue (atomic claiming, leases, retries, recovery).
-- Forward-only and rerunnable (IF NOT EXISTS / guarded constraint swaps).
-- Applied migrations are NOT modified. Everything below is service-role only:
-- no grants to anon/authenticated, so no browser can claim or complete a job.
--
-- Design (master plan §4 + §6, rule 3 "Postgres is the source of truth"):
--   * processing_jobs is the queue. Workers claim with FOR UPDATE SKIP LOCKED,
--     so N concurrent workers never hand out the same job twice.
--   * A claim takes a LEASE (locked_by + lease_expires_at) and bumps attempts.
--     If the worker dies, the lease lapses and recover_stale_processing_jobs()
--     puts the job back — uploads survive restarts and crashes.
--   * complete/fail/renew all require locked_by = p_worker AND an unexpired
--     lease. That is the fence: a slow zombie worker whose lease was already
--     recovered can never overwrite the state a live worker owns.
--   * Idempotency lives in the data, not the code: one job per
--     (invoice_id, job_type) and one invoice per file_object_path, so webhook
--     redelivery cannot queue the same file twice.
--   * 'retry' is NOT a status. A retry is the same row back in 'queued' with a
--     future available_at (exponential backoff computed by the caller). Distinct
--     lifecycles stay distinct: job status never encodes invoice or batch state.

-- 1) Queue columns on the existing table.
alter table public.processing_jobs add column if not exists job_type text not null default 'invoice_extraction'
  check (job_type in ('invoice_extraction', 'register_generation'));
alter table public.processing_jobs add column if not exists available_at timestamptz not null default now();
alter table public.processing_jobs add column if not exists locked_by text;
alter table public.processing_jobs add column if not exists locked_at timestamptz;
alter table public.processing_jobs add column if not exists lease_expires_at timestamptz;
alter table public.processing_jobs add column if not exists max_attempts integer not null default 3
  check (max_attempts >= 1);
alter table public.processing_jobs add column if not exists started_at timestamptz;
alter table public.processing_jobs add column if not exists finished_at timestamptz;

-- Claim order: due jobs first, oldest first.
create index if not exists processing_jobs_claim_idx
  on public.processing_jobs (available_at, created_at)
  where status = 'queued';
-- Stale-lease sweep.
create index if not exists processing_jobs_lease_idx
  on public.processing_jobs (lease_expires_at)
  where status = 'processing';

-- 2) Integrity: strictly idempotent intake and queueing.
--    A webhook redelivery may re-upload the same bytes, but it can never create
--    a second invoice row or a second job for the same target.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'invoices_file_object_path_key' and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices add constraint invoices_file_object_path_key unique (file_object_path);
  end if;
end $$;

create unique index if not exists processing_jobs_target_uniq
  on public.processing_jobs (invoice_id, job_type)
  where invoice_id is not null;

-- 3) Atomic claim. Returns the rows this worker now owns.
create or replace function public.claim_processing_jobs(
  p_worker text,
  p_lease_seconds integer default 120,
  p_limit integer default 1,
  p_job_types text[] default null
) returns setof public.processing_jobs
language sql
security definer
set search_path = ''
as $$
  with cand as (
    select j.id
    from public.processing_jobs j
    where j.status = 'queued'
      and j.available_at <= now()
      and (p_job_types is null or j.job_type = any (p_job_types))
    order by j.available_at, j.created_at
    -- Batch and lease are clamped: no caller can grab the whole queue or hold
    -- a lease so long that crash recovery stops working.
    limit least(greatest(1, p_limit), 25)
    for update skip locked
  )
  update public.processing_jobs j
  set status = 'processing',
      attempts = j.attempts + 1,
      locked_by = p_worker,
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => least(greatest(30, p_lease_seconds), 1800)),
      started_at = coalesce(j.started_at, now()),
      safe_error_code = null,
      updated_at = now()
  from cand c
  where j.id = c.id
  returning j.*;
$$;

-- 4) Lease renewal for long-running work. False = you no longer own the job.
create or replace function public.renew_processing_job_lease(
  p_job_id uuid,
  p_worker text,
  p_lease_seconds integer default 120
) returns boolean
language sql
security definer
set search_path = ''
as $$
  with renewed as (
    update public.processing_jobs
    set lease_expires_at = now() + make_interval(secs => least(greatest(30, p_lease_seconds), 1800)),
        updated_at = now()
    where id = p_job_id
      and locked_by = p_worker
      and status = 'processing'
      and lease_expires_at > now()
    returning 1
  )
  select exists (select 1 from renewed);
$$;

-- 5) Success. Fenced on ownership, so a zombie worker's write is discarded.
create or replace function public.complete_processing_job(
  p_job_id uuid,
  p_worker text
) returns boolean
language sql
security definer
set search_path = ''
as $$
  with done as (
    update public.processing_jobs
    set status = 'completed',
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        finished_at = now(),
        safe_error_code = null,
        updated_at = now()
    where id = p_job_id
      and locked_by = p_worker
      and status = 'processing'
      and lease_expires_at > now()
    returning 1
  )
  select exists (select 1 from done);
$$;

-- 6) Failure: requeue with backoff, or settle permanently.
--    permanent = a retry can never succeed (unsupported input, lost file).
--    attempts >= max_attempts also settles, so nothing retries forever.
--    p_invoice_status lets the handler route the invoice itself ('failed' or
--    'needs_review') in the SAME transaction — job and invoice can never be
--    observed as a torn pair.
create or replace function public.fail_processing_job(
  p_job_id uuid,
  p_worker text,
  p_error_code text,
  p_retry_in_seconds integer default 30,
  p_permanent boolean default false,
  p_invoice_status text default null
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice uuid;
  v_settle boolean;
  v_updated integer;
begin
  if p_invoice_status is not null
     and p_invoice_status not in ('failed', 'needs_review') then
    raise exception 'FAIL_JOB_BAD_INVOICE_STATUS';
  end if;

  -- Lock the row and confirm this worker still owns an unexpired lease.
  select j.invoice_id, (j.attempts >= j.max_attempts)
    into v_invoice, v_settle
  from public.processing_jobs j
  where j.id = p_job_id
    and j.locked_by = p_worker
    and j.status = 'processing'
    and j.lease_expires_at > now()
  for update;

  if not found then
    return 'stale';
  end if;

  v_settle := v_settle or coalesce(p_permanent, false);

  update public.processing_jobs
  set status = case when v_settle then 'failed' else 'queued' end,
      safe_error_code = left(p_error_code, 120),
      locked_by = null,
      locked_at = null,
      lease_expires_at = null,
      available_at = case when v_settle then available_at
                         else now() + make_interval(secs => greatest(0, p_retry_in_seconds)) end,
      finished_at = case when v_settle then now() else finished_at end,
      updated_at = now()
  where id = p_job_id;

  if v_settle and p_invoice_status is not null and v_invoice is not null then
    update public.invoices
    set status = p_invoice_status
    where id = v_invoice
      and status not in ('completed', 'deleted');
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  end if;

  return case when v_settle then 'failed' else 'requeued' end;
end;
$$;

-- 7) Stuck-job recovery: a crashed worker's lease lapses, the job comes back.
--    Jobs already out of attempts settle as failed (with the invoice routed to
--    'failed') instead of spinning forever.
create or replace function public.recover_stale_processing_jobs()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requeued integer;
  v_failed integer;
begin
  with requeued as (
    update public.processing_jobs
    set status = 'queued',
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        available_at = now() + interval '5 seconds',
        safe_error_code = 'LEASE_EXPIRED',
        updated_at = now()
    where status = 'processing'
      and lease_expires_at <= now()
      and attempts < max_attempts
    returning 1
  )
  select count(*) into v_requeued from requeued;

  with settled as (
    update public.processing_jobs
    set status = 'failed',
        locked_by = null,
        locked_at = null,
        lease_expires_at = null,
        finished_at = now(),
        safe_error_code = 'LEASE_EXPIRED',
        updated_at = now()
    where status = 'processing'
      and lease_expires_at <= now()
      and attempts >= max_attempts
    returning id, invoice_id
  ),
  inv as (
    update public.invoices i
    set status = 'failed'
    from settled s
    where i.id = s.invoice_id
      and i.status not in ('completed', 'deleted', 'needs_review')
  )
  select count(*) into v_failed from settled;

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$$;

-- 8) Queue depth for health/status reporting (counts only, no content).
create or replace function public.processing_job_depth()
returns table (status text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select j.status, count(*)
  from public.processing_jobs j
  group by j.status
  order by j.status;
$$;

-- 9) API surface: trusted server (service role) only.
revoke all on function public.claim_processing_jobs(text, integer, integer, text[])
  from public, anon, authenticated;
revoke all on function public.renew_processing_job_lease(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.complete_processing_job(uuid, text)
  from public, anon, authenticated;
revoke all on function public.fail_processing_job(uuid, text, text, integer, boolean, text)
  from public, anon, authenticated;
revoke all on function public.recover_stale_processing_jobs()
  from public, anon, authenticated;
revoke all on function public.processing_job_depth()
  from public, anon, authenticated;

grant execute on function public.claim_processing_jobs(text, integer, integer, text[]) to service_role;
grant execute on function public.renew_processing_job_lease(uuid, text, integer) to service_role;
grant execute on function public.complete_processing_job(uuid, text) to service_role;
grant execute on function public.fail_processing_job(uuid, text, text, integer, boolean, text) to service_role;
grant execute on function public.recover_stale_processing_jobs() to service_role;
grant execute on function public.processing_job_depth() to service_role;

comment on function public.claim_processing_jobs(text, integer, integer, text[]) is
  'Atomic queue claim: FOR UPDATE SKIP LOCKED + lease. service_role only.';
comment on function public.fail_processing_job(uuid, text, text, integer, boolean, text) is
  'Fenced failure: requeue with backoff or settle; optional invoice routing in the same transaction.';
comment on function public.recover_stale_processing_jobs() is
  'Crash recovery: expired leases are requeued or settled once attempts are exhausted.';
