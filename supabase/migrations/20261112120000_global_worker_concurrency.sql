-- 20261112120000_global_worker_concurrency.sql
--
-- Enforce worker concurrency in PostgreSQL, not per process. Every worker
-- instance (including an older deployment still using the four-argument RPC)
-- passes through the same transaction-scoped advisory lock and claim policy.
--
-- Initial pilot defaults: at most 5 processing jobs globally and at most 2
-- processing jobs per workspace. These are safety limits, not throughput claims.
-- Operators may tune them through JOB_GLOBAL_CONCURRENCY and
-- JOB_WORKSPACE_CONCURRENCY after staging load tests.

create or replace function public.claim_processing_jobs(
  p_worker text,
  p_lease_seconds integer,
  p_limit integer,
  p_job_types text[],
  p_global_limit integer,
  p_workspace_limit integer
) returns setof public.processing_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_global_active integer;
  v_global_slots integer;
begin
  -- Serialize admission across every app/worker instance. The lock is held
  -- only for this short claim transaction, never while a job is processed.
  perform pg_advisory_xact_lock(74192, 1);

  select count(*)::integer
    into v_global_active
    from public.processing_jobs
   where status = 'processing';

  v_global_slots :=
    least(greatest(coalesce(p_global_limit, 5), 1), 25) - v_global_active;

  if v_global_slots <= 0 then
    return;
  end if;

  return query
    with active_per_workspace as (
      select workspace_id, count(*)::integer as active_count
        from public.processing_jobs
       where status = 'processing'
       group by workspace_id
    ),
    eligible as (
      select
        j.id,
        row_number() over (
          partition by j.workspace_id
          order by j.available_at, j.created_at, j.id
        ) as workspace_rank,
        greatest(
          0,
          least(greatest(coalesce(p_workspace_limit, 2), 1), 25)
            - coalesce(a.active_count, 0)
        ) as workspace_slots
      from public.processing_jobs j
      left join active_per_workspace a on a.workspace_id = j.workspace_id
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
    ),
    cand as (
      select j.id
        from public.processing_jobs j
        join eligible e on e.id = j.id
       where e.workspace_rank <= e.workspace_slots
       order by j.available_at, j.created_at, j.id
       limit least(greatest(coalesce(p_limit, 1), 1), 25, v_global_slots)
       for update of j skip locked
    )
    update public.processing_jobs j
       set status = 'processing',
           attempts = j.attempts + 1,
           locked_by = p_worker,
           locked_at = now(),
           lease_expires_at = now() + make_interval(secs => least(greatest(30, coalesce(p_lease_seconds, 120)), 1800)),
           started_at = coalesce(j.started_at, now()),
           safe_error_code = null,
           updated_at = now()
      from cand c
     where j.id = c.id
    returning j.*;
end;
$$;

-- Backwards-compatible RPC for old app instances during a rolling deploy.
-- It delegates to the same globally coordinated claim implementation.
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
  select *
    from public.claim_processing_jobs(
      p_worker, p_lease_seconds, p_limit, p_job_types, 5, 2
    );
$$;

revoke all on function public.claim_processing_jobs(text, integer, integer, text[], integer, integer)
  from public, anon, authenticated;
revoke all on function public.claim_processing_jobs(text, integer, integer, text[])
  from public, anon, authenticated;
grant execute on function public.claim_processing_jobs(text, integer, integer, text[], integer, integer)
  to service_role;
grant execute on function public.claim_processing_jobs(text, integer, integer, text[])
  to service_role;

comment on function public.claim_processing_jobs(text, integer, integer, text[], integer, integer) is
  'Globally coordinated queue claim. Advisory lock enforces global and per-workspace processing caps across all worker instances; service_role only.';
comment on function public.claim_processing_jobs(text, integer, integer, text[]) is
  'Backward-compatible claim RPC; delegates to global concurrency defaults of 5 jobs total and 2 per workspace.';
