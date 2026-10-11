// lib/jobs/queue.ts — durable Postgres job queue client (service role only).
//
// All queue transitions happen inside SECURITY DEFINER functions (see
// supabase/migrations/20261011190000_phase3_job_queue.sql): the database owns
// claiming, leases, backoff and crash recovery, so an application restart can
// never lose or double-run work (rule 3). This module is a thin, typed wrapper.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { InvoiceStatus, JobStatus, JobType } from '@/lib/statuses'

export type { JobStatus, JobType } from '@/lib/statuses'

type Db = SupabaseClient

export interface ClaimedJob {
  id: string
  workspace_id: string
  invoice_id: string | null
  job_type: JobType
  status: JobStatus
  attempts: number
  max_attempts: number
  lease_expires_at: string
}

export type FailOutcome = 'requeued' | 'failed' | 'stale'

/** A retry can never succeed: bad/unsupported input, permanently lost file. */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError'
}

export function isPermanentJobFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'PermanentJobError'
}

const int = (raw: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const JOB_LEASE_SECONDS = int(process.env.JOB_LEASE_SECONDS, 120)
const BACKOFF_BASE_SECONDS = int(process.env.JOB_BACKOFF_BASE_SECONDS, 15)
const BACKOFF_CAP_SECONDS = int(process.env.JOB_BACKOFF_CAP_SECONDS, 900)

/** Exponential backoff on the attempt count: 15s, 30s, 60s … capped. */
export function backoffSeconds(attempts: number): number {
  const exp = Math.max(1, attempts) - 1
  return Math.min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** exp)
}

/**
 * Claim up to `limit` due jobs for this worker. FOR UPDATE SKIP LOCKED means
 * concurrent claimers get disjoint sets — never the same job twice. Only pass
 * job types a handler is actually registered for, otherwise nothing is claimed.
 */
export async function claimJobs(
  db: Db,
  args: { worker: string; jobTypes: JobType[]; limit?: number; leaseSeconds?: number },
): Promise<ClaimedJob[]> {
  if (args.jobTypes.length === 0) return []
  const { data, error } = await db.rpc('claim_processing_jobs', {
    p_worker: args.worker,
    p_lease_seconds: args.leaseSeconds ?? JOB_LEASE_SECONDS,
    p_limit: args.limit ?? 1,
    p_job_types: args.jobTypes,
  })
  if (error) throw new Error(`JOB_CLAIM_ERROR: ${error.message}`)
  return ((data ?? []) as unknown as ClaimedJob[]).map((row) => ({
    ...row,
    // bytea/timestamptz come back as strings; keep the raw lease for logging.
    lease_expires_at: String(row.lease_expires_at ?? ''),
  }))
}

/** Extend the lease during long work. False means you no longer own the job. */
export async function renewLease(
  db: Db, jobId: string, worker: string, leaseSeconds?: number,
): Promise<boolean> {
  const { data, error } = await db.rpc('renew_processing_job_lease', {
    p_job_id: jobId,
    p_worker: worker,
    p_lease_seconds: leaseSeconds ?? JOB_LEASE_SECONDS,
  })
  if (error) throw new Error(`JOB_RENEW_ERROR: ${error.message}`)
  return data === true
}

/** Mark success. False = fenced (our lease was already recovered by another). */
export async function completeJob(db: Db, jobId: string, worker: string): Promise<boolean> {
  const { data, error } = await db.rpc('complete_processing_job', {
    p_job_id: jobId,
    p_worker: worker,
  })
  if (error) throw new Error(`JOB_COMPLETE_ERROR: ${error.message}`)
  return data === true
}

/**
 * Record a failure: requeue with backoff, or settle permanently. The database
 * decides which, because it alone knows the attempt count. `invoiceStatus` is
 * applied only when the job settles, in the same transaction — a job and its
 * invoice can never be observed as a torn pair.
 */
export async function failJob(
  db: Db,
  args: {
    jobId: string
    worker: string
    errorCode: string
    retryInSeconds?: number
    permanent?: boolean
    invoiceStatus?: Extract<InvoiceStatus, 'failed' | 'needs_review'>
  },
): Promise<FailOutcome> {
  const { data, error } = await db.rpc('fail_processing_job', {
    p_job_id: args.jobId,
    p_worker: args.worker,
    p_error_code: args.errorCode.slice(0, 120),
    p_retry_in_seconds: args.retryInSeconds ?? backoffSeconds(1),
    p_permanent: args.permanent ?? false,
    p_invoice_status: args.invoiceStatus ?? null,
  })
  if (error) throw new Error(`JOB_FAIL_ERROR: ${error.message}`)
  const outcome = String(data ?? 'stale')
  return outcome === 'requeued' || outcome === 'failed' || outcome === 'stale'
    ? outcome
    : 'stale'
}

/** Crash recovery: expired leases are requeued or settled. Safe to run often. */
export async function recoverStaleJobs(
  db: Db,
): Promise<{ requeued: number; failed: number }> {
  const { data, error } = await db.rpc('recover_stale_processing_jobs')
  if (error) throw new Error(`JOB_RECOVER_ERROR: ${error.message}`)
  const row = (data ?? { requeued: 0, failed: 0 }) as { requeued?: number; failed?: number }
  return { requeued: Number(row.requeued ?? 0), failed: Number(row.failed ?? 0) }
}

/** Queue depth by status (counts only, no content) for health reporting. */
export async function queueDepth(db: Db): Promise<Record<string, number>> {
  const { data, error } = await db.rpc('processing_job_depth')
  if (error) throw new Error(`JOB_DEPTH_ERROR: ${error.message}`)
  const out: Record<string, number> = {}
  for (const row of (data ?? []) as Array<{ status: string; count: number }>) {
    out[row.status] = Number(row.count)
  }
  return out
}
