// lib/jobs/wake.ts — best-effort worker wake-up after a job is enqueued (§P2-9).
//
// On a serverless host nothing runs between cron ticks, so a freshly-filed invoice
// would otherwise sit idle until the next scheduled tick (historically up to 5
// minutes). This fires ONE immediate, NON-BLOCKING tick at the deployed worker
// endpoint right after intake files work, collapsing that latency to ~seconds while
// the (now 1-minute) cron + `worker:poll` remain the durable backstop.
//
// Deliberate safety properties:
//   * Pure + dependency-free: it imports no `@/` alias, no DB and NO logger, so it
//     is unit-testable in-process AND can never write the worker secret to a log.
//   * Fail-closed / no-op when unconfigured: no PUBLIC_APP_URL or no WORKER_SECRET
//     means no wake is attempted (the cron still drives work) — an unset deployment
//     exposes nothing and never errors.
//   * Fire-and-forget: the caller never awaits network success. A rejection is
//     swallowed; a lost wake only reverts to the cron interval, never lost work.
//   * It performs the SAME authenticated call an operator's cron makes, so it grants
//     no extra authority — it just arrives sooner. No invoice/PII data is sent or
//     logged; the body is only a bounded limit.
const clampLimit = (n: number): number => Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : 5, 1), 25)

/** The deployed worker endpoint + secret, or null when waking is not configured. */
export function workerWakeConfig(
  env: Record<string, string | undefined> = process.env,
): { url: string; secret: string } | null {
  const base = (env.PUBLIC_APP_URL ?? '').trim()
  const secret = (env.WORKER_SECRET ?? '').trim()
  if (!base || !secret) return null
  return { url: `${base.replace(/\/+$/, '')}/api/jobs/worker`, secret }
}

export interface WakeOptions {
  /** Jobs to ask the tick to claim (bounded 1..25); default 5. */
  limit?: number
  /** Injected fetch for tests; defaults to the global. */
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
}

/**
 * Fire one best-effort tick at the deployed worker. Returns nothing and NEVER
 * throws: an unconfigured deployment or a network fault is silent, because the
 * scheduler is the durable backstop and intake must never fail over a wake.
 */
export function wakeWorker(opts: WakeOptions = {}): void {
  const cfg = workerWakeConfig(opts.env ?? process.env)
  if (!cfg) return
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return
  const limit = clampLimit(opts.limit ?? 5)
  let signal: AbortSignal | undefined
  try {
    signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(5_000)
      : undefined
  } catch {
    signal = undefined
  }
  try {
    // Intentionally NOT awaited. A rejection is a no-op (cron backstop remains);
    // we log nothing here so the secret can never reach a log sink.
    void doFetch(cfg.url, {
      method: 'POST',
      headers: { 'x-worker-token': cfg.secret, 'content-type': 'application/json' },
      body: JSON.stringify({ limit }),
      ...(signal ? { signal } : {}),
    }).then(
      () => undefined,
      () => undefined,
    )
  } catch {
    // A synchronous throw from fetch setup is equally harmless.
  }
}
