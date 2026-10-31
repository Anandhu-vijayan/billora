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
import { StageTimer } from '@/lib/jobs/timing'
import type { JobType } from '@/lib/statuses'
import type { InvoiceStatus } from '@/lib/statuses'
import {
  JOB_LEASE_SECONDS, backoffSeconds, claimJobs, completeJob, failJob,
  isPermanentJobFailure, recoverStaleJobs, renewLease, type ClaimedJob,
} from '@/lib/jobs/queue'
import { recoverExpiredDeliveryLeases } from '@/lib/whatsapp/delivery-outbox'

type Db = SupabaseClient

export interface JobContext {
  db: Db
  job: ClaimedJob
  worker: string
  /** Remaining lease in seconds; long handlers should checkpoint often. */
  leaseSeconds: number
  /** Renews and verifies ownership before a handler commits durable output. */
  assertLease(): Promise<void>
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

// A job may start only if at least this much of the tick budget remains, so a
// handler that begins just under the deadline cannot run past the platform's
// hard function timeout (route maxDuration) and be killed mid-write. The first
// job of a tick always runs — a tick must make progress.
const minJobWindowMs = (): number => {
  const parsed = Number.parseInt(process.env.JOB_MIN_WINDOW_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20_000
}

const tickLimit = (): number => {
  const parsed = Number.parseInt(process.env.JOB_TICK_LIMIT ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 25) : 3
}

// How many claimed jobs a single tick runs CONCURRENTLY (§P2-10). Bounded to the
// per-tick limit so it can never fan out wider than the tick is allowed to claim,
// and hard-capped at 25 so a typo cannot overwhelm Gemini/storage. Default 3.
const jobConcurrency = (): number => {
  const parsed = Number.parseInt(process.env.JOB_CONCURRENCY ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 25) : 3
}

export class JobLeaseLostError extends Error {
  override name = 'JobLeaseLostError'
}

interface LeaseHeartbeat {
  assertOwned(): Promise<void>
  stop(): void
}

/** Renew often and fail closed if ownership cannot be confirmed. */
function startHeartbeat(db: Db, job: ClaimedJob, worker: string, leaseSeconds: number): LeaseHeartbeat {
  const everyMs = Math.max(1_000, Math.floor((leaseSeconds * 1000) / 4))
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | null = null
  let lost: JobLeaseLostError | null = null
  let stopped = false

  const renew = (): Promise<void> => {
    if (lost) return Promise.reject(lost)
    if (inFlight) return inFlight
    inFlight = (async () => {
      let lastError: unknown
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const owned = await renewLease(db, job.id, worker, leaseSeconds)
          if (!owned) throw new JobLeaseLostError('JOB_LEASE_RENEWAL_REFUSED')
          if (attempt > 1) {
            logger.info('[Worker] lease renewal recovered after transient error', {
              jobId: job.id, worker, attempt,
            })
          }
          return
        } catch (error) {
          if (error instanceof JobLeaseLostError) throw error
          lastError = error
          if (attempt === 1) {
            logger.warn('[Worker] lease renewal transient error; retrying', {
              jobId: job.id, worker, attempt,
              errorType: error instanceof Error ? error.name : 'unknown',
            })
            await new Promise((resolve) => setTimeout(resolve, 300))
          }
        }
      }
      throw lastError
    })().catch((error: unknown) => {
      // A renewal that was already in flight when the handler finished races the
      // job's own settlement (the row has just left 'processing'), so it is
      // refused. That is expected once stop() was called: not an ownership loss.
      if (stopped) throw error
      lost = error instanceof JobLeaseLostError
        ? error
        : new JobLeaseLostError('JOB_LEASE_RENEWAL_UNCONFIRMED')
      logger.error('[Worker] lease ownership lost or unconfirmed', {
        jobId: job.id, worker, reason: lost.message,
      })
      throw lost
    }).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const schedule = (): void => {
    if (stopped || lost) return
    timer = setTimeout(() => {
      void renew().then(schedule, () => undefined)
    }, everyMs)
  }
  schedule()

  return {
    assertOwned: renew,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

/**
 * Process ONE already-claimed job to its fenced outcome, mutating the shared
 * tick `result` counters. Extracted so a batch can run several concurrently
 * (§P2-10). It NEVER rejects: every path (missing handler, lease loss, handler
 * throw, fenced completion) is recorded and swallowed, so Promise.all over a batch
 * can't let one bad job take the tick — or its siblings — down. Lease ownership is
 * still enforced per job: a lost renewal fences ONLY that job, never the batch.
 */
async function processClaimedJob(
  db: Db, job: ClaimedJob, worker: string, leaseSeconds: number, result: TickResult,
): Promise<void> {
  const handler = handlers.get(job.job_type)
  if (!handler) {
    // Defensive: registeredJobTypes() should prevent this. Requeue without
    // settling — a later deploy may register the handler.
    await failJob(db, {
      jobId: job.id, worker, errorCode: 'HANDLER_NOT_REGISTERED',
      retryInSeconds: backoffSeconds(job.attempts),
    }).catch(() => undefined)
    result.requeued += 1
    return
  }

  const heartbeat = startHeartbeat(db, job, worker, leaseSeconds)
  // §P2-12: time the handler itself so a slow job is attributable without any PII.
  const jobTiming = new StageTimer()
  try {
    await handler({ db, job, worker, leaseSeconds, assertLease: heartbeat.assertOwned })
    await heartbeat.assertOwned()
    heartbeat.stop() // stop renewing BEFORE the job settles
    const owned = await completeJob(db, job.id, worker)
    jobTiming.mark('handler')
    logger.info('[Worker] job timing', {
      jobId: job.id, type: job.job_type, worker,
      outcome: owned ? 'completed' : 'fenced', ...jobTiming.summary(),
    })
    if (owned) result.completed += 1
    else {
      result.fenced += 1
      logger.warn('[Worker] completion fenced after handler', { jobId: job.id, worker })
    }
  } catch (e: unknown) {
    heartbeat.stop() // never renew a lease while (or after) failing the job
    if (e instanceof JobLeaseLostError) {
      result.fenced += 1
      logger.warn('[Worker] handler stopped after lease loss', { jobId: job.id, worker })
      return
    }
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
      jobId: job.id, type: job.job_type, attempt: job.attempts,
      outcome, error: code, detail: detail.slice(0, 200),
      durationMs: jobTiming.total(),
    })
  } finally {
    heartbeat.stop()
  }
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
  const worker = args?.worker ?? `w_${randomUUID()}`
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

  // §delivery recovery: a 'sending' delivery whose lease lapsed (the worker died
  // mid-send, so it is uncertain whether Meta accepted it) moves to 'unknown' —
  // NEVER blindly resent. Opportunistic per tick; returns 0 (no-op) until the
  // outbox migration is applied, so this is inert on an un-migrated deployment.
  try {
    const swept = await recoverExpiredDeliveryLeases(db)
    if (swept > 0) logger.info('[Worker] expired delivery leases recovered to unknown', { swept })
  } catch (e: unknown) {
    logger.error('[Worker] delivery lease recovery failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  const jobTypes = registeredJobTypes()
  if (jobTypes.length === 0) {
    logger.info('[Worker] no job handlers registered; queue untouched')
    return result
  }

  const deadline = Date.now() + budgetMs()
  const maxJobs = Math.min(Math.max(1, args?.limit ?? tickLimit()), 25)
  const concurrency = jobConcurrency()
  while (result.claimed < maxJobs) {
    if (Date.now() > deadline || (result.claimed > 0 && Date.now() > deadline - minJobWindowMs())) {
      logger.info('[Worker] tick budget reached before next claim', { worker, claimed: result.claimed })
      break
    }
    // Claim a whole batch (bounded by the tick's remaining budget AND the
    // concurrency cap) and run it CONCURRENTLY (§P2-10). claimJobs uses FOR UPDATE
    // SKIP LOCKED, so a concurrent sibling worker never grabs the same rows, and
    // each job still settles independently through the fenced RPCs — one slow or
    // failing handler cannot block or corrupt the others in the same batch.
    const want = Math.min(concurrency, maxJobs - result.claimed)
    const batch = await claimJobs(db, { worker, jobTypes, limit: want, leaseSeconds })
    if (batch.length === 0) break
    result.claimed += batch.length
    result.idle = false
    await Promise.all(batch.map((job) => processClaimedJob(db, job, worker, leaseSeconds, result)))
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
