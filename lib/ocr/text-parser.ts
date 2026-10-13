// lib/ocr/text-parser.ts — deterministic invoice TEXT -> LedgerCandidate.
//
// This is the LOCAL parsing half of the hybrid pipeline: given the text layer a
// real PDF engine produced (lib/ocr/pdf.ts), it extracts the canonical GST
// invoice fields with labeled, day-first-aware regular expressions. It is the
// "deterministic field parser" the architecture calls for — no model, no
// network, fully reproducible.
//
// Hard rules enforced here (mirrored by tests):
//   * NEVER fabricate. A field we cannot find is OMITTED from the candidate, so
//     lib/ocr/ledger.ts sees it as missing and routes the invoice to review. We
//     never invent a date, a GSTIN or an amount, and never default a number to a
//     plausible-looking value.
//   * Per-field confidence reflects HOW the value was matched: a strong labeled
//     match scores high, a weak/contextual fallback scores low. ledger.ts treats
//     these as an upper bound it can only lower (measured confidence still owns
//     the objective checks), so a shaky text match can never auto-approve alone.
//
// Alias-free + import-only-types so the test harness (transpiles one file, no
// `@/` resolution) can exercise the REAL parser in-process.
import type { LedgerCandidate } from './ledger'

// Mirrors lib/ocr/quality.ts + ledger.ts GSTIN_RE exactly (kept in sync by test).
const GSTIN_RE = /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/

// Confidence tiers: what we are willing to claim for a given match strength.
const CONF_STRONG = 0.9 // value sat next to its own explicit label
const CONF_WEAK = 0.6 // inferred positionally / contextually

const DATE_TOKEN = '(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|\\d{4}-\\d{2}-\\d{2})'
// A money token: optional ₹, grouped digits, optional decimals. Keeps the raw
// text so we can normalize; ledger re-validates finiteness + non-negativity.
const MONEY_TOKEN = '([0-9][0-9,]*(?:\\.[0-9]{1,2})?)'

/** Turn a captured money string into a finite number, or null when not clean. */
function toAmount(raw: string | undefined): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/[,\s]/g, '').replace(/₹/g, '')
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * Find a money value that follows one of `labels` within the same small window
 * (label + number on one line, or a short gap). Returns the value + match
 * strength, or null. We bound the gap so a label on one line cannot steal a
 * number from an unrelated far-away line.
 */
function findLabeledAmount(
  text: string,
  labels: RegExp,
): { value: number; confidence: number } | null {
  // The label is itself an alternation (cgst|central tax|...); it MUST be
  // wrapped in a non-capturing group or the top-level `|` would leave the
  // earlier alternatives without their money-capture suffix.
  const re = new RegExp(`(?:${labels.source})[^0-9₹\\n]{0,24}₹?\\s*${MONEY_TOKEN}`, 'i')
  const m = re.exec(text)
  if (!m) return null
  const value = toAmount(m[1])
  if (value === null) return null
  return { value, confidence: CONF_STRONG }
}

/** First date-looking token in the text, preferring one near a "date" label. */
function findDate(text: string): { value: string; confidence: number } | null {
  const labeled = new RegExp(`(?:invoice|bill|doc|inv)?\\s*date[^0-9\\n]{0,6}${DATE_TOKEN}`, 'i')
  const lm = labeled.exec(text)
  if (lm) return { value: lm[1], confidence: CONF_STRONG }
  const any = new RegExp(DATE_TOKEN).exec(text)
  if (any) return { value: any[1], confidence: CONF_WEAK }
  return null
}

function findInvoiceNumber(text: string): { value: string; confidence: number } | null {
  const re = /(?:invoice|inv|bill|document|doc)[\s.#/-]*(?:no|number|#)[^\w]{0,3}([A-Za-z0-9][A-Za-z0-9\-/]{2,30})/i
  const m = re.exec(text)
  if (m) return { value: m[1], confidence: CONF_STRONG }
  return null
}

function findGstin(text: string): { value: string; confidence: number } | null {
  const upper = text.toUpperCase()
  const m = GSTIN_RE.exec(upper)
  if (m) return { value: m[1], confidence: CONF_STRONG }
  return null
}

const VENDOR_SUFFIX =
  /\b(pvt\.?\s*ltd\.?|private limited|limited|ltd\.?|llp|traders|company|co\.|corp(?:oration)?|enterprises|solutions|services|stores|works|mills|firm|trust)\b/i
const VENDOR_LABEL = /\b(supplier|seller|vendor|from|billed by|invoice from)\b/i

/**
 * Pick the supplier name. We work LINE BY LINE so a name can never swallow a
 * newline (PDF text items are joined with \n). A line that reads like a
 * registered-firm name (carries a legal suffix) is a strong hit; a line that is
 * just "Supplier: <text>" is a weaker one. Never fabricate: no line matches ->
 * the field stays absent and ledger.ts routes to review.
 */
function findVendor(text: string): { value: string; confidence: number } | null {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  let labelled: { value: string; confidence: number } | null = null
  for (const line of lines) {
    if (line.toUpperCase().includes('GSTIN') || line.toUpperCase().includes('UIN')) continue
    if (VENDOR_SUFFIX.test(line) && line.length <= 80) {
      // Prefer the labeled supplier line when it also carries the suffix.
      if (VENDOR_LABEL.test(line)) return { value: line, confidence: CONF_STRONG }
      if (!labelled) labelled = { value: line, confidence: CONF_STRONG }
    }
    if (!labelled && VENDOR_LABEL.test(line)) {
      const after = line.replace(VENDOR_LABEL, '').replace(/[:\s]+/g, ' ').replace(/(GSTIN|GST|UIN|Address|Date).*/i, '').trim()
      if (after.length >= 2 && after.length <= 80) labelled = { value: after, confidence: CONF_WEAK }
    }
  }
  return labelled
}

/**
 * Parse an invoice text layer into a candidate. Every field is optional: only
 * values we can actually locate are populated. When nothing usable is present
 * (e.g. a scanned PDF with no text layer) the caller gets an essentially empty
 * candidate, which ledger.ts routes to needs_review — never a fabricated row.
 */
export function parseInvoiceText(text: string): LedgerCandidate {
  const normalized = (text ?? '').replace(/\r/g, '')
  const candidate: LedgerCandidate & { confidence: Record<string, number> } = { confidence: {} }

  const number = findInvoiceNumber(normalized)
  if (number) {
    candidate.invoice_number = number.value
    candidate.confidence.invoice_number = number.confidence
  }

  const date = findDate(normalized)
  if (date) {
    candidate.invoice_date = date.value
    candidate.confidence.invoice_date = date.confidence
  }

  const gstin = findGstin(normalized)
  if (gstin) {
    candidate.supplier_gstin = gstin.value
    candidate.confidence.supplier_gstin = gstin.confidence
  }

  const vendor = findVendor(normalized)
  if (vendor) {
    candidate.vendor_name = vendor.value
    candidate.confidence.vendor_name = vendor.confidence
  }

  const taxable = findLabeledAmount(normalized, /taxable(?:\s+(?:value|amount|amt))?|assessable(?:\s+value)?|net\s+amount/i)
  if (taxable) {
    candidate.taxable_value = taxable.value
    candidate.confidence.taxable_value = taxable.confidence
  }
  const cgst = findLabeledAmount(normalized, /cgst(?:\s+(?:amount|tax))?|central\s+tax/i)
  if (cgst) {
    candidate.cgst_amount = cgst.value
    candidate.confidence.cgst_amount = cgst.confidence
  }
  const sgst = findLabeledAmount(normalized, /sgst(?:\s+(?:amount|tax))?|state\s+tax/i)
  if (sgst) {
    candidate.sgst_amount = sgst.value
    candidate.confidence.sgst_amount = sgst.confidence
  }
  const igst = findLabeledAmount(normalized, /igst(?:\s+(?:amount|tax))?|integrated\s+tax/i)
  if (igst) {
    candidate.igst_amount = igst.value
    candidate.confidence.igst_amount = igst.confidence
  }
  const total =
    findLabeledAmount(normalized, /grand\s+total|invoice\s+total|total\s+(?:amount|payable)|amount\s+due|net\s+payable/i)
    ?? findLabeledAmount(normalized, /\btotal\b/i)
  if (total) {
    candidate.total_amount = total.value
    candidate.confidence.total_amount = total.confidence
  }

  return candidate
}

/**
 * Whether a PDF text layer is rich enough to attempt deterministic parsing.
 * A scanned/image PDF yields almost nothing here, so the caller can fall back
 * to rasterization + (gated) AI instead of pretending the empty layer is a
 * candidate. Purely a heuristic threshold — it never invents fields.
 */
export function hasMeaningfulText(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length < 40) return false
  const digits = (t.match(/\d/g) ?? []).length
  return digits >= 8 && /[A-Za-z]/.test(t)
}
