// lib/invoices/own-gstin-tally.ts — pure recipient-GSTIN tally for §P0-1c.
//
// Split out from own-gstin-suggest.ts (which touches Supabase + envelope
// crypto) so the REAL plurality decision is unit-testable in-process with no
// aliases and no provider imports — the same split used for ledger.ts vs the
// job handlers. A machine must never silently rewrite the buyer fact, so the
// only judgement here is "is one VALID recipient GSTIN the clear, recurring
// plurality?" — the caller decides what (if anything) to suggest.
import { gstinFullyValid } from '../ocr/gstin'

export interface RecipientTally {
  value: string | null
  /** How many of the client's invoices printed this recipient GSTIN. */
  count: number
}

/**
 * Given the recipient GSTIN read from each of a client's invoices (one entry
 * per invoice; blanks/nulls ignored), return the dominant VALID GSTIN when it
 * appears on at least `minCount` invoices AND is a STRICT plurality. Ties at the
 * top, or a winner that is not a fully-valid GSTIN, yield `{ value: null, count: 0 }`
 * — we never suggest a figure we are unsure of.
 */
export function tallyRecipientGstins(
  perInvoice: readonly (string | null | undefined)[],
  minCount: number,
): RecipientTally {
  const counts = new Map<string, number>()
  for (const raw of perInvoice) {
    const g = (raw ?? '').trim().toUpperCase()
    if (!g) continue
    counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  let tie = false
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count; tie = false }
    else if (count === bestCount) { tie = true }
  }
  if (!best || tie || bestCount < minCount) return { value: null, count: 0 }
  if (!gstinFullyValid(best)) return { value: null, count: 0 }
  return { value: best, count: bestCount }
}
