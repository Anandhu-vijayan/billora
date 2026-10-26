// lib/eval/score.ts — the pure acceptance scorer (§Acceptance).
//
// WHAT THIS IS: the arithmetic behind `npm run eval`. It turns a set of labelled
// golden samples (a human's expected fields vs the extractor's captured actuals)
// into the four numbers the spec demands — per-field accuracy, exact-row accuracy,
// AUTO-APPROVE PRECISION (the count of rows the pipeline auto-approved that do NOT
// match the human label — which MUST be 0), the % auto-approved, and p50/p95 latency.
//
// WHY PURE + ALIAS-FREE: it touches no DB, OCR, Gemini, crypto or filesystem, so it
// runs IN-PROCESS under `node --test` via importTs and is fully unit-testable on
// authored input pairs. It NEVER invents a bill and NEVER relaxes a comparison to
// manufacture a pass — that is the whole point of the precision gate. The labelled
// GOLDEN BILLS themselves are supplied by a human (anonymised real invoices); this
// module only scores whatever pairs it is handed, and the runner refuses to report a
// green when there are none.
//
// Non-negotiables encoded here:
//   * Auto-approve PRECISION > recall: an `approved` row that disagrees with the
//     human label on ANY core field is a `wrong` and fails the gate outright.
//   * Fields the human left blank are NOT scored (a missing label is never a hit or
//     a miss), so accuracy is measured only where there is ground truth.
//   * Amounts compare in integer minor units (never float equality); a genuine `0`
//     is a value, distinct from an absent field.

/** The core, always-labelled fields. Optional fields are scored only when present. */
export const CORE_EVAL_FIELDS = [
  'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
  'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
] as const

export type EvalField = (typeof CORE_EVAL_FIELDS)[number] | 'round_off'

const TEXT_FIELDS = new Set<string>(['invoice_number', 'vendor_name', 'supplier_gstin'])
const DATE_FIELDS = new Set<string>(['invoice_date'])
const MONEY_FIELDS = new Set<string>(['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount', 'round_off'])

export interface EvalExpected {
  invoice_date?: string | null
  invoice_number?: string | null
  vendor_name?: string | null
  supplier_gstin?: string | null
  taxable_value?: number | string | null
  cgst_amount?: number | string | null
  sgst_amount?: number | string | null
  igst_amount?: number | string | null
  total_amount?: number | string | null
  round_off?: number | string | null
}

/** The extractor's captured output for one bill, plus its review decision + timing. */
export interface EvalActual extends EvalExpected {
  review?: 'approved' | 'needs_review'
  reasons?: string[]
  latencyMs?: number
}

export interface EvalSample {
  id: string
  /** Human ground truth. A blank/null field is simply not scored for that field. */
  expected: EvalExpected
  /** Captured extractor output for the same bill. */
  actual: EvalActual
}

export interface FieldScore {
  scored: number
  matched: number
  /** matched / scored, or null when the field was never labelled (no ground truth). */
  accuracy: number | null
}

export interface EvalMetrics {
  count: number
  perField: Record<string, FieldScore>
  /** # samples labelled on EVERY core field whose value the row matched exactly. */
  exactRowScored: number
  exactRowMatched: number
  exactRowAccuracy: number | null
  /** Samples the pipeline chose to auto-approve (review === 'approved'). */
  autoApprovedCount: number
  /** autoApprovedCount / count — how often the machine took the wheel. */
  autoApproveRate: number | null
  /** Approved rows that disagree with the human label on any core field. MUST be 0. */
  autoApproveWrongCount: number
  /** 1 when there were approvals and none were wrong; null when nothing was approved. */
  autoApprovePrecision: number | null
  latency: { count: number; p50: number | null; p95: number | null }
}

/** Normalise a text-ish field for comparison; '' / null / undefined collapse to null. */
function normText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim().toLowerCase().replace(/\s+/g, ' ')
  return s === '' ? null : s
}

/** Canonicalise an ISO-ish date to digits only, so separators/format drift never fakes a miss. */
function normDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const digits = String(value).replace(/\D/g, '')
  if (digits === '') return null
  // Accept yyyymmdd, ddmm-yyyy-ish: compare the digit string. A canonical
  // `YYYY-MM-DD` label and a `YYYYMMDD` actual both reduce to the same 8 digits.
  return digits
}

/** Money in integer minor units, or null when absent/unparseable. A real 0 stays 0. */
function normMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** Is a labelled value present (not null/blank)? Absent labels are simply not scored. */
function labelPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

/** Compare one field's expected vs actual. Returns null when the field is unlabelled. */
function fieldMatch(field: EvalField, expected: EvalExpected, actual: EvalActual): boolean | null {
  const exp = (expected as Record<string, unknown>)[field]
  if (!labelPresent(exp)) return null
  const act = (actual as Record<string, unknown>)[field]
  if (MONEY_FIELDS.has(field)) {
    const e = normMoney(exp); const a = normMoney(act)
    return e !== null && a !== null && e === a
  }
  if (DATE_FIELDS.has(field)) {
    const e = normDate(exp); const a = normDate(act)
    return e !== null && e === a
  }
  if (TEXT_FIELDS.has(field)) {
    const e = normText(exp); const a = normText(act)
    // A blank expected is already filtered; a blank actual is a miss.
    return e !== null && e === a
  }
  // Fallback: exact string compare of trimmed values.
  return normText(exp) === normText(act) && normText(exp) !== null
}

/** Nearest-rank percentile (ceil(p/100*n)-1, clamped). Empty input yields null. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]
}

/** Does the row match the human label on every core field that was labelled? */
function rowMatches(expected: EvalExpected, actual: EvalActual): boolean {
  for (const field of CORE_EVAL_FIELDS) {
    const m = fieldMatch(field, expected, actual)
    if (m === false) return false
  }
  // Optional round_off is only a disagreement when labelled.
  const ro = fieldMatch('round_off', expected, actual)
  return ro !== false
}

export function scoreEval(samples: readonly EvalSample[]): EvalMetrics {
  const perField: Record<string, FieldScore> = {}
  const allFields: EvalField[] = [...CORE_EVAL_FIELDS, 'round_off']
  for (const f of allFields) perField[f] = { scored: 0, matched: 0, accuracy: null }

  let exactRowScored = 0
  let exactRowMatched = 0
  let autoApprovedCount = 0
  let autoApprovedLabelled = 0
  let autoApproveWrongCount = 0
  const latencies: number[] = []

  for (const s of samples) {
    // Per-field accuracy across every labelled core/optional field.
    let anyLabelled = false
    for (const f of allFields) {
      const m = fieldMatch(f, s.expected, s.actual)
      if (m === null) continue
      anyLabelled = true
      perField[f].scored += 1
      if (m) perField[f].matched += 1
    }
    // Exact-row accuracy is measured only where the row has ground truth.
    if (anyLabelled) {
      exactRowScored += 1
      if (rowMatches(s.expected, s.actual)) exactRowMatched += 1
    }

    const approved = s.actual.review === 'approved'
    if (approved) {
      autoApprovedCount += 1
      // Precision is only meaningful against a labelled row; an unlabelled
      // approval is neither credited nor blamed (never a fabricated hit).
      if (anyLabelled) {
        autoApprovedLabelled += 1
        if (!rowMatches(s.expected, s.actual)) autoApproveWrongCount += 1
      }
    }

    if (typeof s.actual.latencyMs === 'number' && Number.isFinite(s.actual.latencyMs) && s.actual.latencyMs >= 0) {
      latencies.push(s.actual.latencyMs)
    }
  }

  for (const f of allFields) {
    const fs = perField[f]
    fs.accuracy = fs.scored === 0 ? null : fs.matched / fs.scored
  }

  latencies.sort((a, b) => a - b)
  const count = samples.length

  return {
    count,
    perField,
    exactRowScored,
    exactRowMatched,
    exactRowAccuracy: exactRowScored === 0 ? null : exactRowMatched / exactRowScored,
    autoApprovedCount,
    autoApproveRate: count === 0 ? null : autoApprovedCount / count,
    autoApproveWrongCount,
    autoApprovePrecision: autoApprovedLabelled === 0 ? null : (autoApprovedLabelled - autoApproveWrongCount) / autoApprovedLabelled,
    latency: { count: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  }
}

export interface GateThresholds {
  /** Minimum acceptable exact-row accuracy for the labelled set. Default 0.9. */
  minExactRowAccuracy: number
  /** Minimum acceptable auto-approve precision. Default 1 (0 wrong, always). */
  minAutoApprovePrecision: number
}

export const DEFAULT_GATE: GateThresholds = { minExactRowAccuracy: 0.9, minAutoApprovePrecision: 1 }

export interface GateResult {
  pass: boolean
  failures: string[]
}

/**
 * Decide pass/fail for CI. The auto-approve PRECISION floor is absolute: any
 * labelled row the machine approved that disagrees with the human label fails, and
 * a precision below the floor fails. An empty/absent golden set is a FAIL (never a
 * silent green) — the caller must supply real labelled bills.
 */
export function evaluateGate(metrics: EvalMetrics, thresholds: GateThresholds = DEFAULT_GATE): GateResult {
  const failures: string[] = []
  if (metrics.count === 0) {
    failures.push('no labelled golden samples were scored — acceptance cannot pass on an empty set')
  }
  if (metrics.autoApproveWrongCount > 0) {
    failures.push(`auto-approve precision violation: ${metrics.autoApproveWrongCount} approved row(s) disagree with the human label (must be 0)`)
  }
  if (metrics.autoApprovePrecision !== null && metrics.autoApprovePrecision < thresholds.minAutoApprovePrecision) {
    failures.push(`auto-approve precision ${(metrics.autoApprovePrecision * 100).toFixed(1)}% below floor ${(thresholds.minAutoApprovePrecision * 100).toFixed(1)}%`)
  }
  if (metrics.exactRowAccuracy !== null && metrics.exactRowAccuracy < thresholds.minExactRowAccuracy) {
    failures.push(`exact-row accuracy ${(metrics.exactRowAccuracy * 100).toFixed(1)}% below floor ${(thresholds.minExactRowAccuracy * 100).toFixed(1)}%`)
  }
  return { pass: failures.length === 0, failures }
}
