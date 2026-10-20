// lib/ocr/calc/reconcile.ts — pure, deterministic invoice-total reconciliation.
//
// WHY THIS EXISTS: the previous validation hard-coded a SINGLE equation
// (`total === taxable + cgst + sgst + igst`) inside ledger.ts, and a second,
// slightly different copy (with a magic `1.01` float tolerance) inside quality.ts.
// Real Indian GST invoices routinely print components that equation cannot
// represent — a line/invoice discount, freight / packaging / other charges, a
// cess, explicit deductions, and a round-off — so a *correct* invoice (e.g. the
// Zetran sample: 29,280 − 2,800 discount + 5,270.40 tax + 500 shipping =
// 32,250.40) was wrongly flagged as `total-mismatch`. This module is the single
// calculation engine every caller (extraction evaluation, human-review
// revalidation, register export) delegates to, so the three can never diverge.
//
// NON-NEGOTIABLES (mirrored by the rest of the pipeline):
//   * Integer paise only — every amount is a `bigint` minor unit, so no
//     floating-point error can enter a comparison or a tax rounding. Parsing of
//     raw text/number into paise stays in validators/money.ts (single home).
//   * NEVER fabricate: reconciliation only COMPARES components the source
//     actually printed against the printed total. It never rewrites a value to
//     make the equation pass, and never infers a missing charge.
//   * Conservative, never MORE permissive than the old fixed equation: the
//     canonical reading (no optional component folded in) is always evaluated
//     FIRST, so any invoice that used to reconcile still reconciles identically;
//     a component is only used when the canonical reading does NOT already tie.
//   * No double counting: an optional component (cess / freight / discount /
//     deduction / round-off) may already be embedded in another printed figure.
//     The engine therefore searches over folding each present component in or
//     leaving it out, and only calls it a mismatch when NO documented reading
//     ties the printed total within tolerance.
import { minorUnitsToString } from '../validators/money'

/**
 * The monetary components of one invoice, already parsed to integer paise.
 * `null` means "not present on the document" (NOT zero, NOT unknown-guessed).
 * The five canonical heads plus the optional structural components the previous
 * fixed equation could not represent.
 */
export interface ReconcileComponents {
  taxable: bigint | null
  cgst: bigint | null
  sgst: bigint | null
  igst: bigint | null
  /** GST cess, where printed (some categories). */
  cess?: bigint | null
  /** Freight / packaging / other ADDITIVE charges (taxable or not, per source). */
  shipping?: bigint | null
  /** Invoice-level discount (subtractive). */
  discount?: bigint | null
  /** Explicit deductions (TDS-on-payment, advance, etc.) — subtractive. */
  deduction?: bigint | null
  /** Round-off, signed (the page may round up or down). */
  roundOff?: bigint | null
  /** The printed grand total / amount payable to reconcile against. */
  printedTotal: bigint | null
}

export type ReconcileStatus = 'reconciles' | 'mismatch' | 'unverifiable'

/** Which optional components the winning/selected reading folded in. */
export interface AppliedComponents {
  cess: boolean
  shipping: boolean
  discount: boolean
  deduction: boolean
  roundOff: boolean
}

export interface ReconcileResult {
  status: ReconcileStatus
  /** Reconstructed total (paise) for the selected reading. */
  expectedMinor: bigint | null
  printedMinor: bigint | null
  differenceMinor: bigint | null
  /** Optional components folded into `expectedMinor` (all false = canonical). */
  applied: AppliedComponents
  /** Machine-readable reason codes; empty when the total reconciles. */
  reasons: string[]
}

const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a)

// The optional addends, each with its sign. A component contributes only when
// present AND selected by the reading being tested; null values are skipped by
// every reading so a plain invoice has exactly ONE candidate reading.
const OPTIONAL_KEYS = ['cess', 'shipping', 'discount', 'deduction', 'roundOff'] as const
type OptionalKey = (typeof OPTIONAL_KEYS)[number]
const SIGN: Record<OptionalKey, 1 | -1> = { cess: 1, shipping: 1, roundOff: 1, discount: -1, deduction: -1 }

function appliedFromMask(mask: number, activeKeys: readonly OptionalKey[]): AppliedComponents {
  const out: AppliedComponents = { cess: false, shipping: false, discount: false, deduction: false, roundOff: false }
  activeKeys.forEach((key, i) => { if ((mask & (1 << i)) !== 0) out[key] = true })
  return out
}

// Mask bits index the ACTIVE (present) optional components in `activeKeys` order,
// so a 2-component invoice enumerates exactly 4 readings and reaches every bit.
function totalFor(mask: number, c: ReconcileComponents, activeKeys: readonly OptionalKey[]): bigint {
  let sum = (c.taxable as bigint) + nz(c.cgst) + nz(c.sgst) + nz(c.igst)
  activeKeys.forEach((key, i) => {
    if ((mask & (1 << i)) !== 0) {
      const value = c[key] as bigint
      sum = SIGN[key] === 1 ? sum + value : sum - value
    }
  })
  return sum
}

const nz = (v: bigint | null | undefined): bigint => v ?? BigInt(0)

/**
 * Reconcile a printed invoice total against its components. Never mutates any
 * input value; only decides whether a documented reading ties out.
 */
export function reconcileInvoiceTotal(
  c: ReconcileComponents,
  toleranceMinor: bigint,
): ReconcileResult {
  const tol = toleranceMinor < BigInt(0) ? BigInt(0) : toleranceMinor
  const printed = c.printedTotal

  if (printed === null) {
    return { status: 'unverifiable', expectedMinor: null, printedMinor: null, differenceMinor: null, applied: NONE, reasons: ['total-missing'] }
  }
  if (c.taxable === null) {
    return { status: 'unverifiable', expectedMinor: null, printedMinor: printed, differenceMinor: null, applied: NONE, reasons: ['taxable-base-missing'] }
  }

  const present: Record<OptionalKey, boolean> = {
    cess: c.cess != null,
    shipping: c.shipping != null,
    discount: c.discount != null,
    deduction: c.deduction != null,
    roundOff: c.roundOff != null,
  }
  const activeKeys = OPTIONAL_KEYS.filter((k) => present[k])
  const combos = 1 << activeKeys.length

  // Enumerate every subset of the PRESENT optional components. Mask 0 is the
  // canonical reading (nothing folded in), so it is tested first and a plain
  // invoice behaves exactly as the old fixed equation.
  let bestMask = 0
  let bestExpected = totalFor(0, c, activeKeys)
  let bestDiff = absDiff(bestExpected, printed)
  if (bestDiff <= tol) return win(bestMask, bestExpected, printed, activeKeys)

  for (let mask = 1; mask < combos; mask += 1) {
    const expected = totalFor(mask, c, activeKeys)
    const diff = absDiff(expected, printed)
    if (diff <= tol) return win(mask, expected, printed, activeKeys)
    if (diff < bestDiff) { bestDiff = diff; bestMask = mask; bestExpected = expected }
  }

  // Nothing ties out: report the closest reading as a genuine mismatch.
  return {
    status: 'mismatch',
    expectedMinor: bestExpected,
    printedMinor: printed,
    differenceMinor: bestDiff,
    applied: appliedFromMask(bestMask, activeKeys),
    reasons: [`total-mismatch:${minorUnitsToString(bestExpected)}!=${minorUnitsToString(printed)}`],
  }
}

const NONE: AppliedComponents = { cess: false, shipping: false, discount: false, deduction: false, roundOff: false }

function win(mask: number, expected: bigint, printed: bigint, activeKeys: readonly OptionalKey[]): ReconcileResult {
  return {
    status: 'reconciles',
    expectedMinor: expected,
    printedMinor: printed,
    differenceMinor: absDiff(expected, printed),
    applied: appliedFromMask(mask, activeKeys),
    reasons: [],
  }
}
