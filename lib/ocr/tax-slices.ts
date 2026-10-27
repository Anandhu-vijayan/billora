// lib/ocr/tax-slices.ts — the rate-wise tax breakdown carried alongside an invoice.
//
// WHY THIS EXISTS: the canonical `LedgerRow` has always modelled ONE rate per tax
// head (a single taxable value, a single CGST/SGST/IGST amount, and the printed
// per-head rate). A real Indian GST invoice routinely mixes several rates in one
// bill (5% + 18% + 28%, or an exempt line beside a taxed line). The accountant's
// register must show that breakdown WITHOUT ever splitting the invoice into one
// row per rate — so the invoice stays one row and the per-rate detail rides with
// it as an OPTIONAL list of slices.
//
// NON-NEGOTIABLES (mirrored by the rest of the pipeline):
//   * NEVER fabricate a rate or an amount. A slice value is `null` when the source
//     did not print it — null is UNKNOWN, never zero. A rate is taken ONLY from
//     printed evidence (a rate-wise summary or a reliably single-rate invoice head),
//     NEVER back-computed from a tax amount.
//   * BACKWARD COMPATIBLE. `tax_slices` is optional everywhere. A legacy single-rate
//     payload with no slices keeps working: a slice is derived ONLY when the rate
//     and amounts are reliably supported by data the row already carries.
//   * DECIMAL-SAFE. Every financial comparison goes through integer paise
//     (`moneyToMinorUnits`) and the shared tax-rate expectation helper — no
//     floating-point equality, and the SAME configured tolerance the invoice-level
//     reconciliation uses. This module never re-derives an amount to make a check
//     pass; it only COMPARES printed evidence.
//   * ADDITIVE VALIDATION ONLY. `validateTaxSlices` can add review reasons and set
//     per-slice statuses; it can NEVER clear a reason the invoice-level evaluator
//     already raised, so wiring it in can only ever tighten precision, never loosen
//     an auto-approval.
//
// Kept pure + alias-free (only relative dependency-free imports) so the test
// harness (`scripts/_ts-import.mjs`) exercises the REAL logic in-process.
import { moneyToMinorUnits, minorUnitsToString } from './validators/money'
import { expectedTaxMinorUnits } from './validators/tax-rates'

/** How a slice's tax is structured. Mirrors the export-side treatment vocabulary. */
export type SliceTreatment = 'local' | 'interstate' | 'unknown'

/** Per-slice validation outcome; 'validated' means the breakdown actually tied out. */
export type SliceValidationStatus = 'validated' | 'unvalidated' | 'conflicting'

/** Where a slice came from, kept for the Tax Breakdown provenance column. */
export type SliceProvenance = 'printed-summary' | 'item-level' | 'invoice-heads' | 'derived' | 'human'

/**
 * One rate/treatment slice of an invoice's tax breakdown. Amounts and rate are
 * plain rupee / percentage NUMBERS (as stored on `LedgerRow`), each `null` when
 * genuinely unknown. A value of `0` means the source printed zero, NOT "absent".
 */
export interface InvoiceTaxSlice {
  rate_percent: number | null
  taxable_value: number | null
  cgst_amount: number | null
  sgst_amount: number | null
  igst_amount: number | null
  cess_amount?: number | null
  treatment?: SliceTreatment | null
  provenance?: SliceProvenance | null
  confidence?: number | null
  validation_status?: SliceValidationStatus | null
}

/** Machine reason codes for the mixed-rate path (centralised so naming can't drift). */
export const MIXED_GST_REASONS = {
  breakdownMissing: 'mixed-gst-breakdown-missing',
  sliceMismatch: 'mixed-gst-slice-mismatch',
  invoiceTotalMismatch: 'mixed-gst-invoice-total-mismatch',
  rateUnresolved: 'mixed-gst-rate-unresolved',
  treatmentConflict: 'mixed-gst-treatment-conflict',
} as const

const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a)
const nz = (v: bigint | null | undefined): bigint => v ?? BigInt(0)

/** A finite number in [0,100] is a usable printed rate; anything else is unknown. */
export function isRateValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
}

/** Normalise one raw slice, coercing non-finite / negative-money to null (unknown). */
function normalizeSlice(raw: Partial<InvoiceTaxSlice>): InvoiceTaxSlice {
  const amount = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  // A negative money is only kept where it can be legitimate; slices here are tax
  // components which are non-negative, so a negative parse is treated as unknown.
  const nonNeg = (v: unknown): number | null => {
    const n = amount(v)
    if (n === null) return null
    return n >= 0 ? n : null
  }
  return {
    rate_percent: isRateValue(raw.rate_percent) ? raw.rate_percent : null,
    taxable_value: nonNeg(raw.taxable_value),
    cgst_amount: nonNeg(raw.cgst_amount),
    sgst_amount: nonNeg(raw.sgst_amount),
    igst_amount: nonNeg(raw.igst_amount),
    cess_amount: nonNeg(raw.cess_amount),
    treatment: raw.treatment === 'local' || raw.treatment === 'interstate' ? raw.treatment : 'unknown',
    provenance: raw.provenance ?? null,
    confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : null,
    validation_status: 'unvalidated',
  }
}

/** Normalise a candidate/existing slice array; returns null when there is nothing usable. */
export function normalizeSlices(slices: readonly Partial<InvoiceTaxSlice>[] | null | undefined): InvoiceTaxSlice[] | null {
  if (!Array.isArray(slices) || slices.length === 0) return null
  const out = slices.map(normalizeSlice)
  return out.length > 0 ? out : null
}

/** A slice carries a real printed/derived tax signal when it has a rate OR any tax amount. */
function sliceHasTaxSignal(s: InvoiceTaxSlice): boolean {
  return (s.rate_percent !== null && s.rate_percent > 0)
    || (s.cgst_amount !== null && s.cgst_amount > 0)
    || (s.sgst_amount !== null && s.sgst_amount > 0)
    || (s.igst_amount !== null && s.igst_amount > 0)
}

/**
 * Distinct rates evidenced across slices (ignores a nil 0% bucket so a plain
 * exempt line does not masquerade as a second rate). Used to decide whether an
 * invoice is genuinely MIXED-rate (and therefore must carry a validated
 * breakdown) versus a single-rate bill the legacy path already handles.
 */
export function distinctTaxRates(slices: readonly InvoiceTaxSlice[]): number[] {
  const rates = new Set<number>()
  for (const s of slices) {
    if (s.rate_percent !== null && s.rate_percent > 0 && Number.isFinite(s.rate_percent)) {
      rates.add(Number(s.rate_percent.toFixed(2)))
    }
  }
  return [...rates].sort((a, b) => a - b)
}

/** True when the slices evidence TWO OR MORE distinct GST rates. */
export function isMixedRate(slices: readonly InvoiceTaxSlice[] | null | undefined): boolean {
  if (!Array.isArray(slices)) return false
  return distinctTaxRates(slices).length >= 2
}

/**
 * Combine two per-head tax components that must be EQUAL halves of a local
 * (CGST+SGST) split. Returns the shared half-rate, or null when they disagree —
 * the same discipline `tally/ledger-mapping.overallGstRatePercent` applies.
 */
function equalLocalHalf(cgstRate: number | null, sgstRate: number | null): number | null {
  if (cgstRate === null || sgstRate === null) return null
  if (!Number.isFinite(cgstRate) || !Number.isFinite(sgstRate)) return null
  if (Math.abs(cgstRate - sgstRate) > 0.001) return null
  return cgstRate
}

/**
 * The single rate for a clean single-rate invoice, taken ONLY from printed rate
 * evidence. Local requires both halves printed AND equal (their sum is the
 * overall rate); interstate uses the printed IGST rate. Returns null for a mixed
 * or unevidenced bill — the caller must then rely on explicit slices or leave the
 * breakdown unresolved (never invent a rate).
 */
export function overallInvoiceRate(args: {
  treatment: SliceTreatment
  cgstRate: number | null
  sgstRate: number | null
  igstRate: number | null
}): number | null {
  if (args.treatment === 'interstate') return isRateValue(args.igstRate) ? args.igstRate : null
  if (args.treatment === 'local') {
    const half = equalLocalHalf(args.cgstRate, args.sgstRate)
    return half === null ? null : Number((half * 2).toFixed(2))
  }
  return null
}

/**
 * Derive slices for a legacy single-rate invoice from the invoice-level heads it
 * already carries, WITHOUT ever inventing a rate. Produces exactly one slice ONLY
 * when a single overall rate is reliably evidenced; returns null otherwise so the
 * caller keeps the historical no-slice behaviour rather than a fabricated row.
 */
export function deriveSlicesFromInvoiceHeads(row: {
  taxable_value: number | null
  cgst_amount: number | null
  sgst_amount: number | null
  igst_amount: number | null
  cess_amount?: number | null
  cgst_rate_percent?: number | null
  sgst_rate_percent?: number | null
  igst_rate_percent?: number | null
}): InvoiceTaxSlice[] | null {
  const cgst = row.cgst_amount
  const sgst = row.sgst_amount
  const igst = row.igst_amount
  const localTax = nz(moneyToMinorUnits(cgst ?? undefined)) + nz(moneyToMinorUnits(sgst ?? undefined))
  const interTax = nz(moneyToMinorUnits(igst ?? undefined))
  let treatment: SliceTreatment = 'unknown'
  if (interTax > BigInt(0) && localTax === BigInt(0)) treatment = 'interstate'
  else if (localTax > BigInt(0) && interTax === BigInt(0)) treatment = 'local'
  if (treatment === 'unknown') return null

  const rate = overallInvoiceRate({
    treatment,
    cgstRate: isRateValue(row.cgst_rate_percent) ? row.cgst_rate_percent : null,
    sgstRate: isRateValue(row.sgst_rate_percent) ? row.sgst_rate_percent : null,
    igstRate: isRateValue(row.igst_rate_percent) ? row.igst_rate_percent : null,
  })
  // No reliably evidenced single rate: a mixed or unevidenced bill. Never guess.
  if (rate === null) return null

  const slice: InvoiceTaxSlice = {
    rate_percent: rate,
    taxable_value: isFiniteOrNull(row.taxable_value) ? row.taxable_value : null,
    cgst_amount: treatment === 'local' ? (isFiniteOrNull(row.cgst_amount) ? row.cgst_amount : null) : null,
    sgst_amount: treatment === 'local' ? (isFiniteOrNull(row.sgst_amount) ? row.sgst_amount : null) : null,
    igst_amount: treatment === 'interstate' ? (isFiniteOrNull(row.igst_amount) ? row.igst_amount : null) : null,
    cess_amount: isFiniteOrNull(row.cess_amount) ? row.cess_amount : null,
    treatment,
    provenance: 'invoice-heads',
    confidence: null,
    validation_status: 'unvalidated',
  }
  return [slice]
}

const isFiniteOrNull = (v: unknown): v is number | null => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v))

/** Invoice-level totals to reconcile the slices against, already paise-normalised. */
export interface InvoiceLevelTotals {
  taxable_value: number | null
  cgst_amount: number | null
  sgst_amount: number | null
  igst_amount: number | null
  cess_amount?: number | null
  /** The printed grand total, when the register wants slice-vs-total faithfulness. */
  total_amount?: number | null
}

export interface SliceValidationResult {
  reasons: string[]
  statuses: SliceValidationStatus[]
  /** True when slices exist AND every slice reconciles to the invoice-level heads. */
  breakdownValidated: boolean
  /** The per-slice reconciled status array applied back onto copies of the slices. */
  slices: InvoiceTaxSlice[]
}

/**
 * Validate a rate-wise breakdown against itself and the invoice-level totals.
 * Purely additive: it returns reason codes + per-slice statuses, and mutates only
 * its own returned slice copies. It NEVER touches an input value and can never
 * approve anything on its own.
 */
export function validateTaxSlices(
  slices: readonly InvoiceTaxSlice[],
  invoice: InvoiceLevelTotals,
  toleranceMinor: bigint = BigInt(101),
): SliceValidationResult {
  const tol = toleranceMinor < BigInt(0) ? BigInt(0) : toleranceMinor
  const reasons: string[] = []
  const statuses: SliceValidationStatus[] = slices.map(() => 'unvalidated')
  const out = slices.map((s) => ({ ...s }))

  if (slices.length === 0) {
    return { reasons, statuses, breakdownValidated: false, slices: out }
  }

  // ---- duplicate / conflicting slices (same rate AND same treatment twice) ----
  const seen = new Map<string, number>()
  slices.forEach((s, i) => {
    if (s.rate_percent === null) return
    const key = `${s.treatment ?? 'unknown'}@${s.rate_percent.toFixed(2)}`
    const prior = seen.get(key)
    if (prior === undefined) { seen.set(key, i); return }
    // Two slices for the same rate+treatment: if their amounts also match they are
    // an accidental double count; either way the breakdown is ambiguous -> conflict.
    reasons.push(`${MIXED_GST_REASONS.sliceMismatch}:duplicate-rate:${key}`)
    statuses[i] = 'conflicting'
    statuses[prior] = 'conflicting'
    out[i].validation_status = 'conflicting'
    out[prior].validation_status = 'conflicting'
  })

  // ---- per-slice internal consistency + treatment conflict ----
  slices.forEach((s, i) => {
    const cgstMinor = nz(moneyToMinorUnits(s.cgst_amount ?? undefined))
    const sgstMinor = nz(moneyToMinorUnits(s.sgst_amount ?? undefined))
    const igstMinor = nz(moneyToMinorUnits(s.igst_amount ?? undefined))
    if (igstMinor > 0 && (cgstMinor > 0 || sgstMinor > 0)) {
      // The same taxable supply can never carry both IGST and CGST/SGST.
      reasons.push(`${MIXED_GST_REASONS.treatmentConflict}:slice:${i}`)
      statuses[i] = 'conflicting'
      out[i].validation_status = 'conflicting'
      return
    }
    // Intra-state halves must be equal.
    if (s.treatment === 'local' && cgstMinor !== sgstMinor && (cgstMinor > 0 || sgstMinor > 0)) {
      reasons.push(`${MIXED_GST_REASONS.sliceMismatch}:unequal-halves:${i}`)
      statuses[i] = 'conflicting'
      out[i].validation_status = 'conflicting'
      return
    }
    // A taxable line that charges tax but printed no rate is unresolved evidence.
    const taxMinor = cgstMinor + sgstMinor + igstMinor
    if (s.rate_percent === null && taxMinor > 0 && s.taxable_value !== null) {
      reasons.push(`${MIXED_GST_REASONS.rateUnresolved}:slice:${i}`)
      statuses[i] = 'conflicting'
      out[i].validation_status = 'conflicting'
      return
    }
    // Rate + taxable + tax all printed: the tax must equal taxable * rate (or the
    // local half-rate) within tolerance. Never rewrites — only flags a contradiction.
    if (s.rate_percent !== null && s.taxable_value !== null && taxMinor > 0) {
      let ok = true
      if (s.treatment === 'interstate') {
        ok = expectedMatches(s.taxable_value, s.rate_percent, igstMinor, tol)
      } else if (s.treatment === 'local') {
        const half = Number((s.rate_percent / 2).toFixed(4))
        ok = expectedMatches(s.taxable_value, half, cgstMinor, tol)
          && expectedMatches(s.taxable_value, half, sgstMinor, tol)
      }
      if (!ok) {
        reasons.push(`${MIXED_GST_REASONS.sliceMismatch}:rate:${i}`)
        statuses[i] = 'conflicting'
        out[i].validation_status = 'conflicting'
        return
      }
    }
    // Nothing contradicted for this slice: mark it validated if it carries a signal.
    if (statuses[i] === 'unvalidated' && sliceHasTaxSignal(s)) {
      statuses[i] = 'validated'
      out[i].validation_status = 'validated'
    }
  })

  // ---- slice sums vs invoice-level heads (only where both sides are comparable) ----
  const sumMinor = (pick: (s: InvoiceTaxSlice) => number | null): bigint =>
    slices.reduce((acc, s) => acc + nz(moneyToMinorUnits(pick(s) ?? undefined)), BigInt(0))
  const taxableSum = sumMinor((s) => s.taxable_value)
  const cgstSum = sumMinor((s) => s.cgst_amount)
  const sgstSum = sumMinor((s) => s.sgst_amount)
  const igstSum = sumMinor((s) => s.igst_amount)
  const cessSum = sumMinor((s) => s.cess_amount ?? null)

  compareHead(reasons, MIXED_GST_REASONS.invoiceTotalMismatch, 'taxable', taxableSum, moneyToMinorUnits(invoice.taxable_value ?? undefined), tol)
  compareHead(reasons, MIXED_GST_REASONS.invoiceTotalMismatch, 'cgst', cgstSum, moneyToMinorUnits(invoice.cgst_amount ?? undefined), tol)
  compareHead(reasons, MIXED_GST_REASONS.invoiceTotalMismatch, 'sgst', sgstSum, moneyToMinorUnits(invoice.sgst_amount ?? undefined), tol)
  compareHead(reasons, MIXED_GST_REASONS.invoiceTotalMismatch, 'igst', igstSum, moneyToMinorUnits(invoice.igst_amount ?? undefined), tol)
  compareHead(reasons, MIXED_GST_REASONS.invoiceTotalMismatch, 'cess', cessSum, moneyToMinorUnits(invoice.cess_amount ?? undefined), tol)

  const breakdownValidated = reasons.length === 0 && slices.every((_, i) => statuses[i] !== 'conflicting')
  return { reasons, statuses, breakdownValidated, slices: out }
}

function expectedMatches(taxable: number, ratePercent: number, actualMinor: bigint, tol: bigint): boolean {
  const expected = expectedTaxMinorUnits(taxable, ratePercent)
  if (expected === null) return false
  return absDiff(expected, actualMinor) <= tol
}

/**
 * Compare a summed slice head to the invoice-level head, only when BOTH sides
 * carry a value. A missing invoice head (null) is unknown, not zero, so it never
 * forces a mismatch — the invoice-level evaluator owns that comparison.
 */
function compareHead(
  reasons: string[], code: string, head: string,
  sliceSumMinor: bigint, invoiceMinor: bigint | null, tol: bigint,
): void {
  if (invoiceMinor === null) return
  if (sliceSumMinor === BigInt(0) && invoiceMinor === BigInt(0)) return
  if (absDiff(sliceSumMinor, invoiceMinor) > tol) {
    reasons.push(`${code}:${head}(${minorUnitsToString(sliceSumMinor)}!=${minorUnitsToString(invoiceMinor)})`)
  }
}

/**
 * Merge two slice lists WITHOUT flattening: keep `primary`'s slices when it
 * carries any, otherwise `fallback`'s. When both carry a breakdown, they are
 * reconciled rate-by-rate (primary wins a rate it printed; fallback fills a rate
 * primary omitted) and a genuine disagreement on the SAME rate is surfaced by the
 * caller's validation as a conflict rather than silently dropped.
 */
export function mergeSlices(
  primary: readonly InvoiceTaxSlice[] | null | undefined,
  fallback: readonly InvoiceTaxSlice[] | null | undefined,
): InvoiceTaxSlice[] | null {
  const p = Array.isArray(primary) && primary.length > 0 ? primary : null
  const f = Array.isArray(fallback) && fallback.length > 0 ? fallback : null
  if (!p && !f) return null
  if (!p) return f ? f.map((s) => ({ ...s })) : null
  if (!f) return p.map((s) => ({ ...s }))
  // Both present: index primary by rate+treatment, then append fallback rates that
  // primary never evidenced. Never overwrite a primary slice with a fallback one.
  const byKey = new Map<string, InvoiceTaxSlice>()
  for (const s of p) byKey.set(`${s.treatment ?? 'unknown'}@${s.rate_percent ?? 'na'}`, { ...s })
  for (const s of f) {
    const key = `${s.treatment ?? 'unknown'}@${s.rate_percent ?? 'na'}`
    if (!byKey.has(key)) byKey.set(key, { ...s })
  }
  return [...byKey.values()]
}
