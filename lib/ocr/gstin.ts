// lib/ocr/gstin.ts — GSTIN validation + supplier/recipient disambiguation.
//
// Pure and dependency-free (no aliases, no I/O) so the real module is exercised
// by the in-process test harness. Three jobs:
//
//   1. gstinChecksumOk   — the 15th character is a mod-36 check digit. A
//      regex-valid GSTIN that fails it is almost always an OCR / transcription
//      error (O/0, I/1, S/5, B/8), so it must never be auto-approved.
//   2. gstinStateCodeValid — the first two digits are a GST state/UT code.
//   3. pickSupplierGstin — a B2B invoice prints TWO GSTINs (seller and buyer).
//      Taking "the first match" captures the buyer often enough to corrupt a
//      purchase register. We classify each GSTIN by the label around it and by
//      position, and the caller can name the recipient (the workspace client's
//      own GSTIN) to exclude it outright.
//
// NEVER fabricate: when no GSTIN is clearly the supplier's, the picker returns a
// low-confidence result (or null) and ledger.ts routes the invoice to review.

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Same shape as ledger.ts / quality.ts GSTIN_RE (kept in sync by a test). */
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

// GST state / UT codes (01-38 plus 97 "Other Territory" and 99 centre
// jurisdiction). 28 (Andhra Pradesh, pre-bifurcation) is kept so a legacy
// registration is never rejected on the state digits alone — the checksum
// already covers those digits, so this check cannot let a typo through.
const STATE_CODES = new Set([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13',
  '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26',
  '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38', '97', '99',
])

/** True when the 15th character matches the GSTIN mod-36 check digit. */
export function gstinChecksumOk(value: string): boolean {
  const s = String(value ?? '').trim().toUpperCase()
  if (!GSTIN_SHAPE.test(s)) return false
  let sum = 0
  for (let i = 0; i < 14; i += 1) {
    const product = CHARSET.indexOf(s[i]) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return CHARSET[(36 - (sum % 36)) % 36] === s[14]
}

/** True when the first two digits are an issued GST state/UT code. */
export function gstinStateCodeValid(value: string): boolean {
  return STATE_CODES.has(String(value ?? '').trim().slice(0, 2))
}

/** Shape + state code + checksum: the full validity bar for a supplier GSTIN. */
export function gstinFullyValid(value: string): boolean {
  const s = String(value ?? '').trim().toUpperCase()
  return GSTIN_SHAPE.test(s) && gstinStateCodeValid(s) && gstinChecksumOk(s)
}

export interface GstinHit {
  value: string
  /** Index of the token in the searched text. */
  index: number
  /** Passes shape + state code + checksum. */
  valid: boolean
}

/** Every GSTIN-shaped token in the text, in reading order, de-duplicated. */
export function findAllGstins(text: string): GstinHit[] {
  const upper = String(text ?? '').toUpperCase()
  // Printed GSTINs often carry a space after the 2-digit state code
  // ("GSTIN: 32 ADRPJ8730C1ZN"); without tolerating it the letterhead GSTIN is
  // invisible and the buyer's GSTIN becomes the only ("clean") survivor.
  const re = /\b([0-9]{2})[ \t]?([A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g
  const seen = new Set<string>()
  const hits: GstinHit[] = []
  for (let m = re.exec(upper); m; m = re.exec(upper)) {
    const value = `${m[1]}${m[2]}`
    if (seen.has(value)) continue
    seen.add(value)
    hits.push({ value, index: m.index, valid: gstinFullyValid(value) })
  }
  return hits
}

// Labels that mark the party a GSTIN belongs to.
const SUPPLIER_LABEL = /\b(supplier|seller|sold\s+by|vendor|billed\s+by|invoice\s+from|from|consignor|registered\s+office|our\s+gstin)\b/i
const RECIPIENT_LABEL = /\b(bill(?:ed)?\s+to|ship(?:ped)?\s+to|buyer|customer|consignee|recipient|receiver|purchaser|sold\s+to|deliver(?:y)?\s+to|party\s+details|place\s+of\s+supply)\b/i

export interface SupplierPick {
  value: string
  /** Strong only when exactly one valid, non-recipient GSTIN survives or a supplier label is adjacent. */
  confidence: number
  /** Every other GSTIN seen (the likely recipient), for cross-checks. */
  others: string[]
}

/**
 * Choose the supplier's GSTIN from an invoice text.
 *
 *   * `recipientGstin` (when the caller knows it) is excluded outright.
 *   * Each remaining GSTIN is scored from the labels on its own line and the
 *     line above (supplier +3, recipient -4), a checksum-valid GSTIN +2 over an
 *     invalid one, and an earlier position as a weak tiebreaker.
 *   * A single clean survivor, or a clear score margin, is a strong pick (0.9).
 *     An unresolved tie is a weak pick (0.6), which ledger.ts cannot auto-approve.
 */
export function pickSupplierGstin(
  text: string,
  opts?: { recipientGstin?: string | null },
): SupplierPick | null {
  const recipient = (opts?.recipientGstin ?? '').trim().toUpperCase()
  const all = findAllGstins(text)
  if (all.length === 0) return null

  const pool = all.filter((h) => h.value !== recipient)
  if (pool.length === 0) return null

  const lines = String(text ?? '').toUpperCase().split('\n')
  // Map a character index to its line number.
  const lineStarts: number[] = []
  let offset = 0
  for (const line of lines) { lineStarts.push(offset); offset += line.length + 1 }
  const lineOf = (index: number): number => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const scored = pool.map((hit, order) => {
    const ln = lineOf(hit.index)
    const context = `${lines[ln - 1] ?? ''}\n${lines[ln] ?? ''}`
    let score = 0
    if (SUPPLIER_LABEL.test(context)) score += 3
    if (RECIPIENT_LABEL.test(context)) score -= 4
    if (hit.valid) score += 2
    score -= order * 0.1
    return { hit, score }
  })
  scored.sort((a, b) => b.score - a.score)

  const best = scored[0]
  const runnerUp = scored[1]
  const margin = runnerUp ? best.score - runnerUp.score : Infinity
  const others = all.filter((h) => h.value !== best.hit.value).map((h) => h.value)
  const strong = best.hit.valid && (pool.length === 1 || margin >= 2)
  return { value: best.hit.value, confidence: strong ? 0.9 : 0.6, others }
}
