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
import { pickSupplierGstin } from './gstin'
import { parseIndianAmountWords } from './validators/amount-words'

// Confidence tiers: what we are willing to claim for a given match strength.
const CONF_STRONG = 0.9 // value sat next to its own explicit label
const CONF_WEAK = 0.6 // inferred positionally / contextually

// One capturing group so downstream `sm[1] ?? sm[2] ?? sm[3]` indexing is stable.
// Numeric day-first + ISO (as before), plus UNAMBIGUOUS month-name forms
// ("5 Sep 2026", "Sep 5, 2026"); every form is anchored to a 4-digit year so an
// ordinary word is never mistaken for a date. ledger.parseInvoiceDate normalizes
// whatever this captures, and refuses any ambiguous / unknown-month reading.
const DATE_TOKEN =
  '(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[ .-]+[A-Za-z]{3,9}[ .-]+\\d{2,4}|[A-Za-z]{3,9}[ .]+\\d{1,2},?[ .]+\\d{2,4})'

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
  confidence: number = CONF_STRONG,
): { value: number; confidence: number } | null {
  for (const line of text.split('\n')) {
    const labelMatch = labels.exec(line)
    if (!labelMatch) continue
    const tail = line.slice(labelMatch.index + labelMatch[0].length)
    const afterRate = tail.replace(
      /^[^0-9₹]{0,24}(?:\d{1,3}(?:\.\d{1,2})?\s*%\s*)?/,
      '',
    )
    const amountMatch = /^[\s:=-]*₹?\s*([0-9][0-9,]*(?:\.\d{1,2})?)(?!\s*%)/.exec(afterRate)
    const value = toAmount(amountMatch?.[1])
    if (value !== null) return { value, confidence }
  }
  return null
}

function findLabeledRate(text: string, labels: RegExp): number | null {
  const re = new RegExp(`(?:${labels.source})[^0-9\\n]{0,16}(\\d{1,3}(?:\\.\\d{1,2})?)\\s*%`, 'i')
  const match = re.exec(text)
  if (!match) return null
  const rate = Number(match[1])
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : null
}

function findAmountInWords(text: string): string | null {
  for (const line of text.split('\n')) {
    const labeled = /(?:amount|total)\s+in\s+words?\s*[:=-]?\s*(.+)/i.exec(line)
    const candidate = labeled?.[1]?.trim()
      ?? (/\b(?:rupees?|inr|rs\.?)\b/i.test(line) && /\bonly\b/i.test(line) ? line.trim() : null)
    if (candidate && parseIndianAmountWords(candidate) !== null) return candidate
  }
  return null
}

/**
 * The invoice date. Strict "invoice/bill/document date" labels win; a bare
 * "Date" label is accepted next, but a date that sits on a due / order /
 * delivery / PO / vehicle line is NEVER taken (those are different documents'
 * dates and would silently mis-batch the invoice). A date with no label at all
 * is a weak hit that ledger.ts cannot auto-approve.
 */
function findDate(text: string): { value: string; confidence: number } | null {
  const strict = new RegExp(
    `(?:invoice|bill|document|doc|inv|tax\\s+invoice)\\s*(?:date|dt)[^0-9\\n]{0,8}${DATE_TOKEN}|date\\s+of\\s+(?:invoice|issue)[^0-9\\n]{0,8}${DATE_TOKEN}|\\bdated\\b[^0-9\\n]{0,4}${DATE_TOKEN}`,
    'i',
  )
  const sm = strict.exec(text)
  if (sm) return { value: sm[1] ?? sm[2] ?? sm[3], confidence: CONF_STRONG }

  const NOT_INVOICE_DATE = /\b(due|order|delivery|dispatch|ship(?:ping)?|po|p\.o\.|purchase\s+order|lr|vehicle|e-?way|payment|valid(?:ity)?)\b/i
  for (const line of text.split('\n')) {
    if (NOT_INVOICE_DATE.test(line)) continue
    const bare = new RegExp(`\\bdate[^0-9\\n]{0,6}${DATE_TOKEN}`, 'i').exec(line)
    if (bare) return { value: bare[1], confidence: CONF_STRONG }
  }
  for (const line of text.split('\n')) {
    if (NOT_INVOICE_DATE.test(line)) continue
    const any = new RegExp(DATE_TOKEN).exec(line)
    if (any) return { value: any[1], confidence: CONF_WEAK }
  }
  return null
}

function findInvoiceNumber(text: string): { value: string; confidence: number } | null {
  // A number that sits on a purchase-order / e-way-bill / delivery / vehicle /
  // consignment / challan line belongs to a DIFFERENT document and must never
  // become the register's invoice key. Those are matched only on their own line
  // so an unrelated "Invoice No" line elsewhere still wins.
  for (const line of text.split('\n')) {
    const m = INVOICE_NO_STRONG.exec(line) ?? DOC_NO.exec(line)
    if (m) return { value: m[1], confidence: CONF_STRONG }
  }
  // An "INV-xxxx" style token needs no label at all (very common in Indian GST).
  const bare = BARE_INV_TOKEN.exec(text)
  if (bare) return { value: bare[1], confidence: CONF_STRONG }
  // A bare "Bill No" is only the invoice number when its own line carries none
  // of the disqualifying prefixes; scored WEAK so it cannot auto-approve alone.
  for (const line of text.split('\n')) {
    if (NOT_INVOICE_NUMBER.test(line)) continue
    const m = BILL_NO.exec(line)
    if (m) return { value: m[1], confidence: CONF_WEAK }
  }
  return null
}

/**
 * Invoice-number patterns. `INVOICE_NO_STRONG` / `DOC_NO` sit next to their own
 * label; `BARE_INV_TOKEN` catches an unlabelled "INV-000125"; `BILL_NO` is the
 * ambiguous plain "Bill No" accepted only on a line free of the disqualifying
 * `NOT_INVOICE_NUMBER` context (PO / purchase order / e-way / delivery / vehicle
 * / consignment / LR / challan), because those are other documents' numbers.
 */
const INVOICE_NO_STRONG = /(?:tax\s+invoice|invoice|inv)[\s.#/-]*(?:no\.?|number|#)[^\w]{0,3}([A-Za-z0-9][A-Za-z0-9\-/]{2,30})/i
const DOC_NO = /(?:document|doc)[\s.#/-]*(?:no\.?|number|#)[^\w]{0,3}([A-Za-z0-9][A-Za-z0-9\-/]{2,30})/i
const BARE_INV_TOKEN = /\b(INV[-_/][A-Za-z0-9][A-Za-z0-9\-/]{2,28})\b/i
const NOT_INVOICE_NUMBER = /\b(po|p\.o\.|purchase\s+order|e-?way|way\s*bill|delivery|consign|vehicle|\blr\b|\bdo\b|\bgrn\b|challan)\b/i
const BILL_NO = /(?:^|[\s(;])bill[\s.#/-]*(?:no\.?|number|#)[^\w]{0,3}([A-Za-z0-9][A-Za-z0-9\-/]{2,30})/i

function findGstin(
  text: string,
  recipientGstin?: string | null,
): { value: string; confidence: number; recipient?: string } | null {
  const pick = pickSupplierGstin(text, { recipientGstin })
  if (!pick) return null
  return { value: pick.value, confidence: pick.confidence === 0.9 ? CONF_STRONG : CONF_WEAK, recipient: pick.others[0] }
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
 * §P3-16 Detect a CREDIT / DEBIT NOTE from the document TITLE only (never from an
 * amount). These are correction documents that reverse part of an earlier invoice,
 * so they carry the opposite sign and must be handled by a human — ledger.ts forces
 * review whenever this returns a note. Matching the two-word phrase (not a bare
 * "credit") avoids false positives from payment terms like "on credit" / "credit
 * period". A combined "Credit/Debit Note" heading is ambiguous, so we take whichever
 * token appears first (nearest the title position); the choice is informational and
 * never financially load-bearing because a note is always sent to review anyway.
 */
const CREDIT_NOTE_RE = /\bcredit\s*[/ ]?\s*note\b/i
const DEBIT_NOTE_RE = /\bdebit\s*[/ ]?\s*note\b/i
// A combined "CREDIT/DEBIT NOTE" heading prints both words around a slash; the two
// single-head regexes above need contiguity and miss it, so match the combined form
// explicitly and classify by the FIRST word (the issuer's usual emphasis).
const COMBINED_CREDIT_FIRST = /\bcredit\s*\/\s*debit\s+note\b/i
const COMBINED_DEBIT_FIRST = /\bdebit\s*\/\s*credit\s+note\b/i
export function detectDocumentType(
  text: string,
): 'invoice' | 'credit_note' | 'debit_note' {
  const t = (text ?? '').replace(/\r/g, '')
  if (COMBINED_CREDIT_FIRST.test(t)) return 'credit_note'
  if (COMBINED_DEBIT_FIRST.test(t)) return 'debit_note'
  const credit = CREDIT_NOTE_RE.test(t)
  const debit = DEBIT_NOTE_RE.test(t)
  if (credit && debit) {
    return t.search(CREDIT_NOTE_RE) <= t.search(DEBIT_NOTE_RE) ? 'credit_note' : 'debit_note'
  }
  if (credit) return 'credit_note'
  if (debit) return 'debit_note'
  return 'invoice'
}

/**
 * Parse an invoice text layer into a candidate. Every field is optional: only
 * values we can actually locate are populated. When nothing usable is present
 * (e.g. a scanned PDF with no text layer) the caller gets an essentially empty
 * candidate, which ledger.ts routes to needs_review — never a fabricated row.
 */
export function parseInvoiceText(
  text: string,
  opts?: { /** The workspace client's own GSTIN (the invoice's buyer), when known. */ recipientGstin?: string | null },
): LedgerCandidate {
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

  const gstin = findGstin(normalized, opts?.recipientGstin)
  if (gstin) {
    candidate.supplier_gstin = gstin.value
    candidate.confidence.supplier_gstin = gstin.confidence
    // The other GSTIN printed on the page is the buyer's; kept only so the
    // ledger can cross-check the tax head against the two state codes.
    const buyer = (opts?.recipientGstin ?? '').trim().toUpperCase() || gstin.recipient
    if (buyer) candidate.recipient_gstin = buyer
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
  // Optional structural components the fixed total equation could not carry.
  // Only folded into reconciliation when actually printed AND needed to tie the
  // total (the shared engine tries the canonical reading first), so an imperfect
  // local label match here can never, on its own, approve or falsely fail a row.
  const cess = findLabeledAmount(normalized, /\bcess\b/i)
  if (cess) candidate.cess_amount = cess.value
  const discount = findLabeledAmount(normalized, /(?:total\s+)?discount(?:\s+(?:amount|value|amt))?/i)
  if (discount) candidate.discount_amount = discount.value
  const shipping = findLabeledAmount(normalized, /shipping|freight|carriage|packaging|handling|forwarding|other\s+charges?/i)
  if (shipping) candidate.shipping_amount = shipping.value
  const deduction = findLabeledAmount(normalized, /deduction(?:s)?|tds\s+on\s+payment|advance\s+(?:received|adjusted)/i)
  if (deduction) candidate.deduction_amount = deduction.value
  const roundOff = findLabeledAmount(normalized, /round\s*off|rounding(?:\s+off)?/i)
  if (roundOff) candidate.round_off = roundOff.value
  const cgstRate = findLabeledRate(normalized, /cgst|central\s+tax/i)
  const sgstRate = findLabeledRate(normalized, /sgst|state\s+tax/i)
  const igstRate = findLabeledRate(normalized, /igst|integrated\s+tax/i)
  if (cgstRate !== null) candidate.cgst_rate_percent = cgstRate
  if (sgstRate !== null) candidate.sgst_rate_percent = sgstRate
  if (igstRate !== null) candidate.igst_rate_percent = igstRate
  const amountInWords = findAmountInWords(normalized)
  if (amountInWords) candidate.total_amount_in_words = amountInWords
  const total =
    findLabeledAmount(normalized, /grand\s+total|invoice\s+total|total\s+(?:amount|payable)|amount\s+due|net\s+payable/i)
    // A bare "Total" is a WEAK hit (it can be a quantity or a subtotal), so it
    // can never auto-approve on its own; quantity/discount/tax totals are skipped.
    ?? findLabeledAmount(
      normalized,
      /\btotal\b(?!\s*(?:qty|quantity|items?|pcs|units?|weight|discount|tax|gst|cgst|sgst|igst|in\s+words))/i,
      CONF_WEAK,
    )
  if (total) {
    candidate.total_amount = total.value
    candidate.confidence.total_amount = total.confidence
  }

  // §P3-16 Only tag a NON-invoice document type; a plain invoice leaves the field
  // unset so stored payloads stay as lean as before for the common case.
  const docType = detectDocumentType(normalized)
  if (docType !== 'invoice') candidate.document_type = docType

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
