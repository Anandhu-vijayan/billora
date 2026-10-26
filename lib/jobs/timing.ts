// lib/jobs/timing.ts — per-stage timing primitive (§P2-12).
//
// Deliberately PURE: zero imports (no logger, no `@/` alias, no builtins) so it is
// loadable in-process by the transpile test harness AND safe to import from anywhere
// (worker, handlers, the OCR engine) with no cycle risk. It only MEASURES; the caller
// owns logging, so this can never decide to log a payload/PII on its own.
//
// Usage:
//   const t = new StageTimer()
//   ...download+decrypt...  t.mark('decrypt')
//   ...extraction...        t.mark('extract')
//   ...persist...           t.mark('persist')
//   logger.info('[Extract] stage timing', { ...t.summary(), invoiceId })
//
// `clock` is injectable purely for deterministic tests; production uses Date.now().
// Elapsed values are integers (ms); a monotonic clock is not required here because we
// only ever want a coarse per-stage breakdown for latency debugging, not a security
// boundary. Durations are clamped at 0 so a coarse clock can never report negative ms.

export interface StageMeasure {
  stage: string
  ms: number
}

export interface StageSummary {
  stages: StageMeasure[]
  totalMs: number
}

export class StageTimer {
  private readonly startedAt: number
  private lastAt: number
  private readonly marks: StageMeasure[] = []

  constructor(private readonly clock: () => number = () => Date.now()) {
    this.startedAt = clock()
    this.lastAt = this.startedAt
  }

  /** Close the open segment as `stage`, return its elapsed ms (>= 0). */
  mark(stage: string): number {
    const now = this.clock()
    const ms = Math.max(0, now - this.lastAt)
    this.lastAt = now
    this.marks.push({ stage, ms })
    return ms
  }

  /** ms since the timer started (>= 0). */
  total(): number {
    return Math.max(0, this.clock() - this.startedAt)
  }

  /**
   * Snapshot for logging: a copy of each stage plus the wall-clock total. Metadata
   * only (stage names + integer durations) — never any invoice content.
   */
  summary(): StageSummary {
    return {
      stages: this.marks.map((m) => ({ stage: m.stage, ms: m.ms })),
      totalMs: this.total(),
    }
  }
}
