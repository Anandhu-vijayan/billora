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
import type { InvoiceTaxSlice } from './tax-slices'
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
/**
 * A WEAKER second tier of trading-house words that appear in a firm name but also
 * in ordinary item prose ("office supplies", "freight agencies"). Used ONLY when
 * no strong suffix matched, and only for a line shaped like a NAME — no digits (an
 * item / amount row always carries numbers) and no tax-table vocabulary — so
 * widening the vocabulary cannot turn a table row into a supplier name.
 */
const VENDOR_SUFFIX_WEAK =
  /\b(supplies|associates|agencies|merchants|distributors|ventures|industries)\b/i
const VENDOR_LABEL = /\b(supplier|seller|vendor|from|billed by|invoice from|sold by)\b/i
// Footer/signatory declarations are not supplier names. Examples: "For Supplier",
// "For Seller", "For and on behalf of Blue Ridge Industries", and signature lines.
const FOOTER_DECLARATION =
  /^for\s+(?:(?:and\s+on\s+behalf\s+of)\s+)?(?:the\s+)?(?:supplier|seller|vendor)\s*:?$/i
const SIGNATORY_FOOTER =
  /^(?:authori[sz]ed\s+signatory|authori[sz]ed\s+representative|signature|declaration)\b/i
// §supplier/recipient: the BUYER block is never the supplier. A registered-firm
// suffix (Enterprises / Traders / Pvt Ltd) is carried by the CUSTOMER's name just
// as often as the supplier's, so a suffix match alone cannot decide the party —
// it must first be outside the "Bill To" region. Taking the buyer's line as the
// supplier name silently mislabels every row of the purchase register.
const BUYER_LABEL = /\b(bill(?:ed)?\s*to|buyer|purchaser|customer|recipient|consignee|ship(?:ped)?\s*to|delivered\s*to|sold\s*to)\b/i
/** A buyer region BEGINS at its own heading line ("Bill To:", "Buyer", "To:"). */
const BUYER_HEADING = /^[^A-Za-z]*\b(bill(?:ed)?\s*to|buyer|purchaser|customer|recipient|consignee|ship(?:ped)?\s*to|delivered\s*to|to)\b/i
/** ...and ENDS at a supplier heading or the tax/item table section. */
const TAX_TABLE_SECTION = /\b(hsn|sac|sl\.?\s*(?:no|no\.)|description|quantity|qty|taxable\s*(?:value|amount|qty)?|assessable|cgst|sgst|igst|cess|discount|round\s*off|grand\s*total|total\b|net\s+(?:payable|amount)|amount\s+(?:in\s+)?(?:words|due)|freight|carriage)\b/i
const BUYER_REGION_END = /\b(invoice\s*(?:no|number|date)|items?\s+details|particulars|hsn|sac|description|taxable|cgst|sgst|igst|grand\s+total|net\s+payable|supplier|sold\s+by|invoice\s+from)\b/i

function normalizeVendorDisplay(value: string): string {
  return value.replace(/\bPVT\.?\s*LTD\.?\b/gi, 'PVT LTD')
    .replace(/\bPVTLTD\.?(?=\s|$)/gi, 'PVT LTD')
    .replace(/\s+/g, ' ').trim()
}

/** Capture company-like names explicitly inside buyer blocks for cross-source exclusion. */
function findBuyerRegionNames(text: string): string[] {
  const names: string[] = []
  let inBuyer = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (BUYER_HEADING.test(line)) {
      inBuyer = true
      const inline = line.replace(BUYER_HEADING, '').replace(/^\s*[:=-]\s*/, '').trim()
      if (inline && /[A-Za-z]/.test(inline) && !/\b(?:gstin|address|date)\b/i.test(inline)) names.push(normalizeVendorDisplay(inline))
      continue
    }
    if (inBuyer && BUYER_REGION_END.test(line)) { inBuyer = false; continue }
    if (!inBuyer || /\b(?:gstin|state|phone|mobile|email|address|pin(?:code)?)\b/i.test(line)) continue
    const cleaned = line.replace(/\s{2,}/g, ' ').trim()
    if (cleaned.length >= 3 && cleaned.length <= 80 && /[A-Za-z]/.test(cleaned)
      && !/\d/.test(cleaned) && !TAX_TABLE_SECTION.test(cleaned)) {
      names.push(normalizeVendorDisplay(cleaned))
    }
  }
  return [...new Set(names)]
}

/**
 * The NAME a supplier label carries, with the label (and any trailing GSTIN/
 * address tail) removed: `Sold By: Acme Traders Pvt Ltd` -> `Acme Traders Pvt
 * Ltd`. A label standing on its own with nothing usable after it returns null,
 * so the caller keeps the raw line rather than shipping an empty name.
 */
function stripVendorLabel(line: string): string | null {
  const after = line
    .replace(VENDOR_LABEL, '')
    .replace(/[:\s]+/g, ' ')
    .replace(/(GSTIN|GST|UIN|Address|Date).*/i, '')
    .trim()
  return after.length >= 2 && after.length <= 80 ? after : null
}

/**
 * Pick the supplier name. We work LINE BY LINE so a name can never swallow a
 * newline (PDF text items are joined with \n). A line that reads like a
 * registered-firm name (carries a legal suffix) is a strong hit; a line that is
 * just "Supplier: <text>" is a weaker one. Lines inside the buyer ("Bill To")
 * region are refused outright — a buyer name is never a supplier name. Never
 * fabricate: no line matches -> the field stays absent and ledger.ts routes to
 * review (a missing supplier is recoverable by one chat correction, a swapped
 * one ships silently in the register).
 */
function findVendor(text: string): { value: string; confidence: number } | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  let labelled: { value: string; confidence: number } | null = null
  let tradingHouse: string | null = null
  let inBuyerBlock = false
  let inFooter = false

  for (const line of lines) {
    if (line.toUpperCase().includes('GSTIN') || line.toUpperCase().includes('UIN')) continue

    if (SIGNATORY_FOOTER.test(line)) {
      inFooter = true
      continue
    }

    if (inFooter) continue
    if (FOOTER_DECLARATION.test(line)) continue

    if (BUYER_HEADING.test(line)) {
      inBuyerBlock = true
      continue
    }
    if (inBuyerBlock) {
      if (VENDOR_LABEL.test(line) || TAX_TABLE_SECTION.test(line)) inBuyerBlock = false
      else continue
    }

    if (BUYER_LABEL.test(line)) continue
    if (VENDOR_SUFFIX.test(line) && line.length <= 80) {
      if (VENDOR_LABEL.test(line)) {
        const value = stripVendorLabel(line)
        if (value) return { value, confidence: CONF_STRONG }
      }
      if (!labelled) labelled = { value: line, confidence: CONF_STRONG }
    }
    if (!labelled && VENDOR_LABEL.test(line)) {
      const value = stripVendorLabel(line)
      if (value && !/^for$/i.test(value)) {
        labelled = { value, confidence: CONF_WEAK }
      }
    }
    if (!tradingHouse && line.length <= 80 && !/\d/.test(line)
      && !TAX_TABLE_SECTION.test(line) && VENDOR_SUFFIX_WEAK.test(line)) {
      tradingHouse = line
    }
  }

  return labelled ?? (tradingHouse ? { value: tradingHouse, confidence: CONF_WEAK } : null)
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
 * §multi-rate: parse a printed RATE-WISE TAX SUMMARY into slices, conservatively.
 *
 * Many Indian GST invoices print a summary table that groups the taxable value and
 * the tax amounts BY rate, e.g.
 *     5.00%    10,000.00     250.00     250.00
 *     18.00%   20,000.00   1,800.00   1,800.00
 * We read ONLY lines that LEAD with a `NN%` rate token and then capture the numbers
 * that follow on the SAME line. This is deliberately narrow so a lone "CGST @ 9%"
 * header or a single-rate bill never gains a spurious breakdown:
 *   * a row with THREE following amounts is intra-state (taxable, CGST, SGST);
 *   * a row with TWO following amounts is interstate (taxable, IGST);
 *   * any other shape is ignored (never guessed).
 * Rows sharing a rate are summed. A breakdown is returned ONLY when TWO OR MORE
 * distinct rates were evidenced — a single-rate invoice keeps the historical
 * no-slice path untouched. The slices are then validated/reconciled downstream in
 * ledger.ts; a bad parse can only force review, never fabricate a value here.
 */
export function parseRateWiseSummary(text: string): InvoiceTaxSlice[] | null {
  const numTokens = (s: string): number[] =>
    (s.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? [])
      .map((t) => Number(t.replace(/[\s,]/g, '')))
      .filter((n) => Number.isFinite(n) && n >= 0)
  const rateLead = /^\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i

  interface Agg { rate: number; taxable: number; cgst: number; sgst: number; igst: number; treatment: 'local' | 'interstate' }
  const byRate = new Map<number, Agg>()
  for (const rawLine of (text ?? '').replace(/\r/g, '').split('\n')) {
    const m = rateLead.exec(rawLine)
    if (!m) continue
    const rate = Number(m[1])
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) continue
    const nums = numTokens(rawLine.slice(m[0].length))
    let treatment: 'local' | 'interstate'
    let taxable: number; let a: number; let b: number; let igst: number
    if (nums.length >= 3) { treatment = 'local'; taxable = nums[0]; a = nums[1]; b = nums[2]; igst = 0 }
    else if (nums.length === 2) { treatment = 'interstate'; taxable = nums[0]; a = 0; b = 0; igst = nums[1] }
    else continue
    const key = Number(rate.toFixed(2))
    const agg = byRate.get(key) ?? { rate: key, taxable: 0, cgst: 0, sgst: 0, igst: 0, treatment }
    agg.taxable += taxable
    agg.cgst += a
    agg.sgst += b
    agg.igst += igst
    // A later row for the same rate with a different treatment means the summary is
    // ambiguous; keep the FIRST reading (deterministic) rather than blend heads.
    byRate.set(key, agg)
  }

  if (byRate.size < 2) return null
  const slices: InvoiceTaxSlice[] = [...byRate.values()]
    .sort((x, y) => x.rate - y.rate)
    .map((agg): InvoiceTaxSlice => ({
      rate_percent: agg.rate,
      taxable_value: round2(agg.taxable),
      cgst_amount: agg.treatment === 'local' ? round2(agg.cgst) : null,
      sgst_amount: agg.treatment === 'local' ? round2(agg.sgst) : null,
      igst_amount: agg.treatment === 'interstate' ? round2(agg.igst) : null,
      cess_amount: null,
      treatment: agg.treatment,
      provenance: 'printed-summary',
      confidence: CONF_STRONG,
      validation_status: 'unvalidated',
    }))
  return slices
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

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
    candidate.vendor_name = normalizeVendorDisplay(vendor.value)
    candidate.confidence.vendor_name = vendor.confidence
  }
  const buyerRegionNames = findBuyerRegionNames(normalized)
  if (buyerRegionNames.length > 0) candidate.buyer_region_names = buyerRegionNames
  const normalizedBuyerNames = new Set(buyerRegionNames.map((name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()))
  if (candidate.vendor_name && normalizedBuyerNames.has(candidate.vendor_name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim())) {
    candidate.vendor_name = null
    candidate.vendor_ambiguous = true
  } else if (!candidate.vendor_name && buyerRegionNames.length > 0) {
    candidate.vendor_ambiguous = true
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
  if (amountInWords) {
    candidate.total_amount_in_words = amountInWords
    candidate.total_amount_in_words_source = 'local-ocr'
  }
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

  // §multi-rate: attach a printed rate-wise breakdown ONLY when the summary clearly
  // evidenced two or more distinct rates. A single-rate bill yields null here and
  // behaves exactly as before.
  const summarySlices = parseRateWiseSummary(normalized)
  if (summarySlices) candidate.tax_slices = summarySlices

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
