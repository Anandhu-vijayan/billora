// lib/tally/ledger-mapping.ts — turn an extracted invoice row into a Tally
// purchase-import LINE, WITHOUT ever inventing an accounting classification.
//
// WHY THIS IS ITS OWN MODULE (master-plan §4/§10): the internal `LedgerRow` is the
// OCR's faithful picture of the document; a Tally export profile is a SEPARATE
// concern — the target ledger name is a business/accounting choice that lives in
// the workspace's configuration, never in the invoice image. Keeping them apart
// lets a future template version change without touching extraction, and keeps
// this logic independent of any OCR provider.
//
// Non-negotiables enforced here:
//   * NEVER fabricate a ledger name. If the workspace has not CONFIGURED a ledger
//     for a row's rate-class, or the row's own GST rate/treatment is genuinely
//     unknown, we return an explicit UNRESOLVED state — the caller leaves the
//     Ledger Name cell blank and flags the batch. A tax RATE is also never a
//     ledger name; we only ever look up what the user mapped.
//   * MISSING CONFIG is distinct from EXTRACTION FAILURE. `mapping-required`
//     means "the rate is known but no ledger is configured yet"; `unresolved-rate`
//     means "we could not establish the rate/treatment from the document." Both
//     are surfaced so the operator can tell the two apart.
//   * A rate is read ONLY from printed rate evidence carried on the row; it is
//     never back-computed from the tax/taxable amounts (that could hide an OCR
//     error and would overwrite the source's own printed figure).
import type { LedgerRow } from '../ocr/ledger'

/** How a purchase invoice's tax is structured, from which heads are non-zero. */
export type TaxTreatment = 'local' | 'interstate' | 'unknown'

/** Why a ledger name could not be placed on the line — never a silent default. */
export type LedgerMappingStatus = 'mapped' | 'mapping-required' | 'unresolved-rate'

/** One configured workspace mapping: a rate-class key to its target ledger. */
export interface TallyLedgerMapping {
  rate_class_key: string
  ledger_name: string
}

/** The resolved Tally line for one approved invoice, or an explicit gap. */
export interface TallyLedgerResolution {
  /** The concrete ledger name, or null when unresolved (never a guess). */
  ledgerName: string | null
  status: LedgerMappingStatus
  /** The rate-class key used for the lookup (also what the operator configures). */
  rateClassKey: string
  /** The overall GST rate percent for the line, or null when unestablished. */
  gstRatePercent: number | null
  treatment: TaxTreatment
}

const num = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

/**
 * Local (CGST+SGST/UTGST) vs Interstate (IGST) is decided by which heads are
 * actually charged, NOT by the GSTIN state codes (which the stored row may not
 * carry). An invoice with IGST only is interstate; CGST/SGST only is local; an
 * all-zero-tax row (exempt/nil OR simply unreadable) is deliberately UNKNOWN —
 * we never classify a transaction we cannot see. A row that somehow carries both
 * IGST and CGST/SGST is contradictory and also UNKNOWN (already flagged upstream).
 */
export function resolveTaxTreatment(row: LedgerRow): TaxTreatment {
  const igst = num(row.igst_amount)
  const local = num(row.cgst_amount) + num(row.sgst_amount)
  if (igst > 0 && local === 0) return 'interstate'
  if (local > 0 && igst === 0) return 'local'
  return 'unknown'
}

/**
 * The overall GST rate percentage for the line, taken ONLY from printed rate
 * evidence. For a local invoice CGST and SGST are equal halves, so the overall
 * rate is their SUM — but ONLY when BOTH halves were actually printed; a single
 * printed half is not enough to assert the whole rate, so it stays null rather
 * than being doubled by inference. Interstate uses the printed IGST rate directly.
 */
export function overallGstRatePercent(row: LedgerRow, treatment: TaxTreatment): number | null {
  if (treatment === 'interstate') {
    return typeof row.igst_rate_percent === 'number' && Number.isFinite(row.igst_rate_percent)
      ? row.igst_rate_percent
      : null
  }
  if (treatment === 'local') {
    const c = row.cgst_rate_percent
    const s = row.sgst_rate_percent
    if (typeof c === 'number' && Number.isFinite(c) && typeof s === 'number' && Number.isFinite(s)) {
      return c + s
    }
    return null
  }
  return null
}

/** Format a rate for a stable mapping key: 18 -> "18", 2.5 -> "2.5", no noise. */
function rateLabel(rate: number | null): string {
  if (rate === null) return 'na'
  return String(Number(rate.toFixed(2)))
}

/**
 * The workspace-configurable class for a line: `<treatment>@<overall-rate>`, e.g.
 * `local@18`, `interstate@12`, `local@0` (nil-rated within a taxed structure).
 * When the treatment or rate cannot be established the key is `unresolved`, which
 * maps to NOTHING — an unresolved line is never assigned a ledger by luck.
 */
export function rateClassKey(treatment: TaxTreatment, rate: number | null): string {
  if (treatment === 'unknown' || rate === null) return 'unresolved'
  return `${treatment}@${rateLabel(rate)}`
}

/**
 * Resolve one row against the workspace's configured mappings. This is the ONLY
 * place a ledger name is chosen, and it can only ever ECHO a configured name —
 * never create one. Returns the explicit gap when no mapping applies.
 */
export function resolveLedgerName(
  row: LedgerRow,
  mappings: readonly TallyLedgerMapping[],
): TallyLedgerResolution {
  const treatment = resolveTaxTreatment(row)
  const gstRatePercent = overallGstRatePercent(row, treatment)
  const key = rateClassKey(treatment, gstRatePercent)
  if (key === 'unresolved') {
    return { ledgerName: null, status: 'unresolved-rate', rateClassKey: key, gstRatePercent, treatment }
  }
  const hit = mappings.find((m) => m.rate_class_key === key)
  if (hit) {
    return { ledgerName: hit.ledger_name, status: 'mapped', rateClassKey: key, gstRatePercent, treatment }
  }
  // Rate/treatment are known but the workspace has not mapped a ledger for them:
  // this is MISSING CONFIGURATION, not an extraction failure.
  return { ledgerName: null, status: 'mapping-required', rateClassKey: key, gstRatePercent, treatment }
}
