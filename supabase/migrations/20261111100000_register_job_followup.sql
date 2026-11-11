-- 20261111100000_register_job_followup.sql
--
-- Prevent a late-finishing invoice extraction from being lost behind a register
-- generation job that already took its source snapshot.
--
-- Before this migration, processing_jobs_batch_uniq covered ALL register job
-- statuses. enqueueRegisterGeneration therefore treated an in-flight build as
-- proof that a rebuild was already pending. If another invoice joined the batch
-- after build_register's initial membership/readiness snapshot, its enqueue was
-- discarded and the first workbook could permanently omit that invoice.
--
-- New contract:
--   * At most one QUEUED register job per batch (the coalesced follow-up slot).
--   * A PROCESSING register job may coexist with that one queued follow-up.
--   * claim_processing_jobs will not claim a register job while another register
--     job for the same batch is processing. This preserves single-build ordering.
--   * Completed/failed jobs remain as history; they no longer occupy the slot.
--
-- Forward-only, additive to application behaviour, service-role execution only.

drop index if exists public.processing_jobs_batch_uniq;

create unique index processing_jobs_batch_uniq
  on public.processing_jobs (batch_id, job_type)
  where batch_id is not null
    and invoice_id is null
    and job_type = 'register_generation'
    and status = 'queued';

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
      and (
        j.job_type <> 'register_generation'
        or j.batch_id is null
        or not exists (
          select 1
          from public.processing_jobs active
          where active.batch_id = j.batch_id
            and active.invoice_id is null
            and active.job_type = 'register_generation'
            and active.status = 'processing'
        )
      )
    order by j.available_at, j.created_at
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

revoke all on function public.claim_processing_jobs(text, integer, integer, text[])
  from public, anon, authenticated;
grant execute on function public.claim_processing_jobs(text, integer, integer, text[])
  to service_role;

comment on index public.processing_jobs_batch_uniq is
  'At most one queued register-generation follow-up per batch; a processing build may coexist and is serialized by claim_processing_jobs.';
