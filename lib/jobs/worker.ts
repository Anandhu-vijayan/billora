// lib/jobs/worker.ts — queue runner. Claims due jobs, keeps the lease alive,
// and records the outcome through the fenced RPCs in lib/jobs/queue.ts.
//
// Two rules shape this file:
//   * No handler, no claim. A job is only taken for a job type that has a
//     registered handler, so the queue can never "process" work the system
//     cannot actually do (Phase 4 registers invoice extraction). With nothing
//     registered a tick claims zero rows and jobs stay safely queued.
//   * The lease is the permission to write. If renew fails or complete/fail
//     returns `stale`/false, this worker lost ownership (it was too slow and
//     recovery handed the job to someone else) — it reports the loss and does
//     NOT pretend its result was recorded.
import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { JobType } from '@/lib/statuses'
import type { InvoiceStatus } from '@/lib/statuses'
import {
  JOB_LEASE_SECONDS, backoffSeconds, claimJobs, completeJob, failJob,
  isPermanentJobFailure, recoverStaleJobs, renewLease, type ClaimedJob,
} from '@/lib/jobs/queue'

type Db = SupabaseClient

export interface JobContext {
  db: Db
  job: ClaimedJob
  worker: string
  /** Remaining lease in seconds; long handlers should checkpoint often. */
  leaseSeconds: number
}

export type JobHandler = (ctx: JobContext) => Promise<void>

/** Fail here instead of burning retries: throw PermanentJobError from a handler. */
export type JobFailureRoute = Extract<InvoiceStatus, 'failed' | 'needs_review'>

const handlers = new Map<JobType, JobHandler>()

export function registerJobHandler(jobType: JobType, handler: JobHandler): void {
  handlers.set(jobType, handler)
}

export function registeredJobTypes(): JobType[] {
  return [...handlers.keys()]
}

/** Test seam: drop every handler so a tick is provably inert. */
export function clearJobHandlers(): void {
  handlers.clear()
}

export interface TickResult {
  worker: string
  recovered: number
  claimed: number
  completed: number
  requeued: number
  failed: number
  /** Writes this worker lost to fencing — another worker owns the row now. */
  fenced: number
  idle: boolean
}

const budgetMs = (): number => {
  const parsed = Number.parseInt(process.env.JOB_TICK_BUDGET_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 1000 ? parsed : 45_000
}

const tickLimit = (): number => {
  const parsed = Number.parseInt(process.env.JOB_TICK_LIMIT ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 25) : 3
}

/**
 * Keep the lease alive while a handler runs. Renewal is best-effort: if it
 * starts failing the handler still finishes and its write gets fenced, which is
 * the correct outcome for a worker that cannot reach the database.
 */
function startHeartbeat(db: Db, job: ClaimedJob, worker: string, leaseSeconds: number): () => void {
  const everyMs = Math.max(5_000, Math.floor((leaseSeconds * 1000) / 3))
  const timer = setInterval(() => {
    renewLease(db, job.id, worker, leaseSeconds)
      .then((ok) => {
        if (!ok) logger.warn('[Worker] lease renewal refused; result will be fenced', { job: job.id.slice(0, 8) })
      })
      .catch((e: unknown) => {
        logger.warn('[Worker] lease renewal error', {
          job: job.id.slice(0, 8), error: e instanceof Error ? e.message : String(e),
        })
      })
  }, everyMs)
  return () => clearInterval(timer)
}

/**
 * One queue pass: sweep stale leases, claim due work for registered types,
 * run each handler independently. Never throws — a broken handler cannot take
 * the tick (or the other jobs) down with it.
 */
export async function runWorkerTick(
  db: Db,
  args?: { worker?: string; limit?: number; leaseSeconds?: number },
): Promise<TickResult> {
  const worker = args?.worker ?? `w_${randomUUID().slice(0, 8)}`
  const leaseSeconds = args?.leaseSeconds ?? JOB_LEASE_SECONDS
  const result: TickResult = {
    worker, recovered: 0, claimed: 0, completed: 0, requeued: 0, failed: 0, fenced: 0, idle: true,
  }

  // Crash recovery first: work abandoned by a dead worker becomes claimable.
  try {
    const recovered = await recoverStaleJobs(db)
    result.recovered = recovered.requeued + recovered.failed
    if (result.recovered > 0) {
      logger.info('[Worker] stale leases recovered', {
        requeued: recovered.requeued, failed: recovered.failed,
      })
    }
  } catch (e: unknown) {
    logger.error('[Worker] recovery pass failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  const jobTypes = registeredJobTypes()
  if (jobTypes.length === 0) {
    logger.info('[Worker] no job handlers registered; queue untouched')
    return result
  }

  const deadline = Date.now() + budgetMs()
  const batch = await claimJobs(db, {
    worker, jobTypes, limit: args?.limit ?? tickLimit(), leaseSeconds,
  })
  result.idle = batch.length === 0

  for (const job of batch) {
    // Time budget exhausted: stop taking more work. These rows keep their
    // lease and recovery returns them to the queue if we never come back.
    if (Date.now() > deadline) {
      logger.warn('[Worker] tick budget reached; leaving remaining leases to lapse', {
        worker, remaining: batch.length - result.claimed,
      })
      break
    }
    result.claimed += 1
    const handler = handlers.get(job.job_type)
    if (!handler) {
      // Defensive: registeredJobTypes() should prevent this. Requeue without
      // settling — a later deploy may register the handler.
      await failJob(db, {
        jobId: job.id, worker, errorCode: 'HANDLER_NOT_REGISTERED',
        retryInSeconds: backoffSeconds(job.attempts),
      }).catch(() => undefined)
      result.requeued += 1
      continue
    }

    const stopHeartbeat = startHeartbeat(db, job, worker, leaseSeconds)
    try {
      await handler({ db, job, worker, leaseSeconds })
      const owned = await completeJob(db, job.id, worker)
      if (owned) result.completed += 1
      else result.fenced += 1
    } catch (e: unknown) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      const code = detail.split(':')[0] || 'JOB_HANDLER_ERROR'
      const permanent = isPermanentJobFailure(e)
      const outcome = await failJob(db, {
        jobId: job.id,
        worker,
        errorCode: code,
        retryInSeconds: permanent ? 0 : backoffSeconds(job.attempts),
        permanent,
        // Applied by the RPC only when the job actually settles for good.
        invoiceStatus: 'failed',
      })
      if (outcome === 'requeued') result.requeued += 1
      else if (outcome === 'failed') result.failed += 1
      else result.fenced += 1
      logger.warn('[Worker] job failed', {
        job: job.id.slice(0, 8), type: job.job_type, attempt: job.attempts,
        outcome, error: code, detail: detail.slice(0, 200),
      })
    } finally {
      stopHeartbeat()
    }
  }

  if (result.claimed > 0) {
    logger.info('[Worker] tick finished', {
      worker, claimed: result.claimed, completed: result.completed,
      requeued: result.requeued, failed: result.failed, fenced: result.fenced,
      recovered: result.recovered,
    })
  }
  return result
}
