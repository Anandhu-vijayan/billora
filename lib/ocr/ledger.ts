// lib/ocr/ledger.ts — pure extraction-result evaluation (no I/O, no aliases).
//
// This is the single decision point for "is this extracted invoice trustworthy
// enough to auto-approve, or must a human review it?" It is deliberately free
// of any Supabase / provider / crypto imports so it can be exercised in-process
// (tests run the REAL module), and so the safety rules below can never be
// bypassed by a caller that "just wants to store the row":
//
//   * NEVER fabricate: a missing or unparseable invoice_date is flagged and the
//     original text is preserved — no date is invented.
//   * NEVER silently approve: any anomaly, an invalid GSTIN, or a low field
//     confidence routes to `needs_review`. Only a fully clean, confident, and
//     date-resolved row is `approved`.
//   * The shape matches lib/excel/generator.ts `IndianLedgerRowInput` exactly
//     (structural typing keeps the two in sync without a runtime import).
import { gstinChecksumOk, gstinFullyValid, gstinStateCodeValid } from './gstin';
import { parseIndianAmountWords, validateInvoiceCrossChecks } from './validators'
import { minorUnitsToNumber, moneyToMinorUnits } from './validators/money'
import { reconcileInvoiceTotal } from './calc/reconcile'
import {
  MIXED_GST_REASONS,
  deriveSlicesFromInvoiceHeads,
  distinctTaxRates,
  mergeSlices,
  normalizeSlices,
  validateTaxSlices,
  type InvoiceTaxSlice,
} from './tax-slices'

/**
 * §P3-16 The kind of source document, read from its printed TITLE (never from an
 * amount). A CREDIT/DEBIT NOTE is a correction to an earlier invoice and carries
 * the opposite sign, so it is ALWAYS routed to human review — a machine never
 * auto-approves one. This is informational: it does not relax any amount validator
 * (a negative total on a note is STILL a hard review trigger), it only ADDS context
 * and forces review.
 */
export type DocumentType = 'invoice' | 'credit_note' | 'debit_note'

export interface LedgerRow {
  invoice_date: string;
  invoice_number: string;
  vendor_name: string;
  supplier_gstin: string;
  taxable_value: number | null;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  total_amount: number | null;
  // --- Added for the Tally purchase-import profile -------------------------
  // All OPTIONAL so previously-stored 9-field payloads stay readable (an absent
  // field is `undefined`, which the readers below treat as UNKNOWN, never 0).
  // Printed round-off when the source carried it; null means NOT printed.
  round_off?: number | null;
  // Printed per-head GST rate percentages exactly as extracted (never derived
  // from the amounts): we keep the source rate separate from any computed total
  // so the export never overwrites a printed rate with a calculated one.
  cgst_rate_percent?: number | null;
  sgst_rate_percent?: number | null;
  igst_rate_percent?: number | null;
  /**
   * §P3-16 the printed document type. Absent on a previously-stored payload means
   * 'invoice' (backward compatible). A credit/debit note can never be auto-approved.
   */
  document_type?: DocumentType;
  /**
   * The optional rate-wise tax breakdown. ABSENT on every legacy payload and on a
   * invoice the source gave no multi-rate evidence for, which is read as "no
   * breakdown", never "zero". When present each slice is one GST rate/treatment
   * line. The invoice stays ONE register row; this only carries its detail.
   */
  tax_slices?: InvoiceTaxSlice[] | null;
}

/** A raw extraction candidate: values plus an optional per-field confidence. */
export interface LedgerCandidate {
  invoice_date?: string | null;
  invoice_number?: string | null;
  vendor_name?: string | null;
  supplier_gstin?: string | null;
  /**
   * The BUYER's GSTIN when the source could read it. Never written to the row;
   * used only to cross-check the supplier (different party) and the tax head
   * (IGST vs CGST+SGST follows whether the two state codes differ).
   */
  recipient_gstin?: string | null;
  taxable_value?: number | string | null;
  cgst_amount?: number | string | null;
  sgst_amount?: number | string | null;
  igst_amount?: number | string | null;
  total_amount?: number | string | null;
  /**
   * Optional structural components a fixed `taxable+tax=total` equation cannot
   * represent. Absent (undefined/null) means "not printed on the document", NOT
   * zero — the shared reconciliation engine in ./calc/reconcile only folds them
   * in when actually present, so a plain invoice behaves exactly as before while
   * a discounted / freighted / cess / round-off invoice can finally tie out.
   * They are validation inputs only; they never overwrite a canonical field.
   */
  cess_amount?: number | string | null;
  shipping_amount?: number | string | null;
  discount_amount?: number | string | null;
  deduction_amount?: number | string | null;
  round_off?: number | string | null;
  cgst_rate_percent?: number | string | null;
  sgst_rate_percent?: number | string | null;
  igst_rate_percent?: number | string | null;
  total_amount_in_words?: string | null;
  /**
   * §P3-16 the printed document type detected from the document TITLE. The AI
   * schema never returns it, so only the local parser sets it; it survives the
   * local/AI merge and forces human review for a credit/debit note.
   */
  document_type?: DocumentType;
  /**
   * Rate-wise tax slices a source (a printed rate-wise summary, an item-level read
   * or a human correction) produced. Optional; absence means NO breakdown was
   * evidenced, which is never coerced to zero. `evaluateLedger` validates these
   * and only then attaches a reliable breakdown to the canonical row.
   */
  tax_slices?: InvoiceTaxSlice[] | null;
  confidence?: Record<string, number> | null;
}

export type LedgerReview = 'approved' | 'needs_review';

export interface LedgerEvaluation {
  row: LedgerRow;
  review: LedgerReview;
  reasons: string[];
  /**
   * The gate value: our OWN measured confidence from the deterministic checks,
   * downgraded (never raised) by the model's self-reported per-field confidence
   * when it supplied any. This is deliberately NOT the model's number alone.
   */
  confidence: number;
  /** Confidence computed purely from objective validity of the row (0..1). */
  measuredConfidence: number;
  /** True only when a real invoice date was parsed (never fabricated). */
  invoiceDateResolved: boolean;
  /**
   * Deterministic repairs applied to the candidate before scoring (e.g.
   * `total-from-words`). Empty when the candidate was scored exactly as given.
   */
  repairs?: string[];
  /**
   * True only when the invoice evidenced a MULTI-rate breakdown AND every slice
   * reconciled to the invoice-level heads. A single-rate invoice is `null` (no
   * separate breakdown to validate), distinguishing "extraction succeeded" from
   * "the rate-wise tax breakdown actually passed validation".
   */
  breakdownValidated?: boolean | null;
}

/**
 * §clean-row rule: the model's self-report only vetoes an otherwise-valid row
 * when it expresses GENUINE doubt on a field it actually filled. We literally tell
 * the vision model to "never default to high", so a modest 0.6-0.79 is normal for
 * a perfectly clean read and must NOT force a human review on its own; only belief
 * below this floor is a real "the source guessed here" signal.
 */
const AI_SELF_CONFIDENCE_FLOOR = 0.6;

// Mirrors lib/ocr/quality.ts GSTIN_RE exactly (kept in sync by a test).
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const REQUIRED_FIELDS = [
  'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
  'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
] as const;

// First day of GST (1 July 2017): no valid GST invoice predates it.
const GST_EPOCH = '2017-07-01';

const money = (n: number): number | null => Number.isFinite(n) ? n : null

/**
 * Parse a printed tax-rate PERCENTAGE (0..100) to a finite number, or null when
 * the source never printed one. This is deliberately separate from money(): a
 * rate is a percentage, not a currency amount, and an absent rate must stay
 * UNKNOWN (null) — it is never inferred from the amounts, per the rule that a
 * printed rate is preserved and an unprinted one is not calculated in.
 */
function ratePercent(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v.replace(/%/g, '').trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

const PLACEHOLDER_TEXT = /^(?:n\/?a|na|tbd|unknown|placeholder|sample|test|(?:add|enter|insert|your|company|vendor|supplier|invoice)\s+(?:company\s+)?(?:name|number|no\.?|details|here)|(?:company|vendor|supplier|invoice)\s+(?:name|number|no\.?))$/i

function isPlaceholderText(value: string): boolean {
  return PLACEHOLDER_TEXT.test(value.trim().replace(/[:._-]+/g, ' ').replace(/\s+/g, ' '))
}

/**
 * Month names accepted for textual invoice dates. ONLY an exact 3-letter
 * abbreviation, the common `sept`, or a full English name — never a fuzzy
 * prefix, so ambiguous fragments ("J", "Ma", "Ju") are refused and the date
 * stays unresolved instead of being guessed.
 */
const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
}

function monthFromName(token: string): number | null {
  return MONTH_NAMES[token.toLowerCase()] ?? null
}

/**
 * Expand a printed year to a full 4-digit year. A 2-digit year ("23") uses a
 * POSIX-style pivot (00..69 -> 2000s, 70..99 -> 1900s). This is safe for GST
 * invoices because the GST-epoch and future-date guards in evaluateLedger still
 * reject anything that cannot be a real invoice date, so a 2-digit year can
 * never smuggle in an implausible date — it only lets a legible "22-Apr-23"
 * resolve to 2023-04-22 instead of being dropped as unresolved.
 */
function expandYear(rawYear: string): number {
  const y = Number(rawYear)
  if (rawYear.length === 4) return y
  return y <= 69 ? 2000 + y : 1900 + y
}

/** Parse the common Indian + ISO invoice date spellings to `YYYY-MM-DD`. */
function parseInvoiceDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // ISO first (already canonical).
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    return validateParts(Number(y), Number(m), Number(d)) ? `${y}-${m}-${d}` : null;
  }
  // Day-first: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (Indian convention); a
  // 2-digit year is expanded via expandYear.
  const dmy = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(s);
  if (dmy) {
    const day = Number(dmy[1]), mon = Number(dmy[2]), year = expandYear(dmy[3]);
    if (validateParts(year, mon, day)) {
      return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }
  // Month-name forms are UNAMBIGUOUS because the month is spelled out, so they
  // are safe to accept: "5 Sep 2026", "05-Sep-2026", "22-Apr-23".
  const dMonthY = /^(\d{1,2})[ .\-]+([A-Za-z]{3,9})[ .\-]*(\d{2}|\d{4})$/.exec(s);
  if (dMonthY) {
    const mon = monthFromName(dMonthY[2]);
    const day = Number(dMonthY[1]), year = expandYear(dMonthY[3]);
    if (mon !== null && validateParts(year, mon, day)) {
      return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }
  // Month-first with a spelled month: "Sep 5, 2026", "September 5 2026".
  const monthDY = /^([A-Za-z]{3,9})[ .]+(\d{1,2}),?[ .]+(\d{2}|\d{4})$/.exec(s);
  if (monthDY) {
    const mon = monthFromName(monthDY[1]);
    const day = Number(monthDY[2]), year = expandYear(monthDY[3]);
    if (mon !== null && validateParts(year, mon, day)) {
      return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }
  return null;
}

function validateParts(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function toNumber(v: number | string | null | undefined): number {
  const minor = moneyToMinorUnits(v)
  return minor === null ? Number.NaN : minorUnitsToNumber(minor)
}

/** Does a candidate field actually carry a value? Blank text / absent amount = no. */
function fieldHasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return Number.isFinite(value)
  return true
}

/**
 * The model's own lowest confidence over the required fields it ACTUALLY filled,
 * or null when it gave none. Absent/blank values are skipped: vision stamps a 0
 * self-score on a null amount ("no belief because nothing there"), which the
 * objective checks already judge — letting it drag the whole row down would flag a
 * legitimate local bill that simply carries no IGST (§clean-row rule).
 */
function selfConfidence(candidate: LedgerCandidate): number | null {
  const c = candidate.confidence;
  if (!c || typeof c !== 'object') return null;
  let min = 1;
  let seen = false;
  for (const field of REQUIRED_FIELDS) {
    if (!fieldHasValue(candidate[field])) continue;
    const value = c[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      seen = true;
      if (value < min) min = value;
    }
  }
  return seen ? min : null;
}

/**
 * Independently measured confidence from objective quality of the parsed row:
 * completeness, GSTIN validity, a resolvable date, finite/non-negative amounts
 * and tax-arithmetic consistency. We do NOT trust the model's self-report as
 * the gate. Each unmet signal subtracts; a fully clean row scores 1.0. This is
 * calibration-free and deterministic, so the same input always scores the same.
 */
function computeMeasured(parts: {
  dateResolved: boolean;
  gstinValid: boolean;
  invoiceNumberPresent: boolean;
  vendorNamePresent: boolean;
  amountsFinite: boolean;
  amountsNonNegative: boolean;
  arithmeticConsistent: boolean;
  /** Tax-head / total structure is coherent (see evaluateLedger). */
  structureConsistent: boolean;
}): number {
  let m = 1;
  if (!parts.dateResolved) m -= 0.5;
  if (!parts.gstinValid) m -= 0.35;
  if (!parts.invoiceNumberPresent) m -= 0.3;
  if (!parts.vendorNamePresent) m -= 0.3;
  if (!parts.amountsFinite) m -= 0.5;
  if (!parts.amountsNonNegative) m -= 0.4;
  if (!parts.arithmeticConsistent) m -= 0.4;
  if (!parts.structureConsistent) m -= 0.4;
  return Math.max(0, Math.min(1, m));
}

/**
 * Merge two candidates field-by-field, preferring `primary` (the LOCAL result)
 * for every field it produced that is INDEPENDENTLY VALID, and taking
 * `fallback` (the AI result) only to fill a field local left missing or invalid.
 * This is what lets AI *assist* the local parser without ever *overruling* a
 * valid local value: a good local GSTIN/date/amount is kept, a gap is filled.
 * The merged candidate is still handed to `evaluateLedger`, so the combination
 * is validated independently afterwards (no blind trust in either source).
 */
export function mergeCandidates(
  primary: LedgerCandidate,
  fallback: LedgerCandidate,
): LedgerCandidate {
  const merged: LedgerCandidate = { ...(fallback ?? {}) }
  const confidence: Record<string, number> = { ...(fallback?.confidence ?? {}) }
  const isTextValid = (raw: string | null | undefined): boolean => (raw ?? '').trim() !== ''
  // Full validity (shape + state code + checksum): a local GSTIN that fails the
  // checksum is an OCR/parse error and must be replaceable by the AI's read.
  const isGstinValid = (raw: string | null | undefined): boolean => gstinFullyValid(raw ?? '')
  const isDateValid = (raw: string | null | undefined): boolean => parseInvoiceDate(raw) !== null
  const isAmountValid = (raw: number | string | null | undefined): boolean => {
    const n = toNumber(raw)
    return Number.isFinite(n) && n >= 0
  }

  const copyText = (field: 'invoice_number' | 'vendor_name', valid: (v: string | null | undefined) => boolean) => {
    const pv = primary[field]
    if (typeof pv === 'string' && valid(pv)) {
      ;(merged as Record<string, unknown>)[field] = pv.trim()
      if (primary.confidence?.[field] !== undefined) confidence[field] = primary.confidence[field]
    }
  }
  copyText('invoice_number', isTextValid)
  copyText('vendor_name', isTextValid)

  if (isDateValid(primary.invoice_date)) {
    merged.invoice_date = (primary.invoice_date ?? '').trim()
    if (primary.confidence?.invoice_date !== undefined) confidence.invoice_date = primary.confidence.invoice_date
  }
  if (isGstinValid(primary.supplier_gstin)) {
    merged.supplier_gstin = (primary.supplier_gstin ?? '').trim().toUpperCase()
    if (primary.confidence?.supplier_gstin !== undefined) confidence.supplier_gstin = primary.confidence.supplier_gstin
  }
  for (const field of ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount'] as const) {
    if (isAmountValid(primary[field])) {
      ;(merged as Record<string, unknown>)[field] = primary[field]
      if (primary.confidence?.[field] !== undefined) confidence[field] = primary.confidence[field]
    }
  }
  // Optional structural components: keep whichever source printed a parseable
  // value (primary/local preferred), preserving provenance. Unlike the canonical
  // heads these are legitimately absent, and `round_off` may be negative, so the
  // bar here is simply "carries a finite amount", not the >= 0 amount-validity.
  const carriesAmount = (raw: number | string | null | undefined): boolean =>
    moneyToMinorUnits(raw) !== null
  for (const field of ['cess_amount', 'shipping_amount', 'discount_amount', 'deduction_amount', 'round_off'] as const) {
    if (carriesAmount(primary[field])) {
      ;(merged as Record<string, unknown>)[field] = primary[field]
    }
  }
  if (!(merged.recipient_gstin ?? '').trim() && (primary.recipient_gstin ?? '').trim()) {
    merged.recipient_gstin = primary.recipient_gstin
  }
  for (const field of ['cgst_rate_percent', 'sgst_rate_percent', 'igst_rate_percent', 'total_amount_in_words'] as const) {
    const primaryValue = primary[field]
    const fallbackValue = fallback?.[field]
    if (primaryValue !== undefined && primaryValue !== null && primaryValue !== '') {
      ;(merged as Record<string, unknown>)[field] = primaryValue
    } else if (fallbackValue !== undefined) {
      ;(merged as Record<string, unknown>)[field] = fallbackValue
    }
  }
  // §P3-16 document type is a LOCAL structural signal (a printed Credit/Debit Note
  // title). The AI schema never returns it, so a note read locally must survive a
  // merge with an AI candidate that reports nothing. Prefer the primary (local) read.
  const docType = primary.document_type ?? fallback?.document_type
  if (docType) merged.document_type = docType
  // Rate-wise slices are preserved WITHOUT flattening: the primary (local/human)
  // breakdown wins, and the merge never silently discards a slice either side
  // printed. A conflicting rate is left for evaluateLedger's validation to flag.
  const mergedSlices = mergeSlices(primary.tax_slices, fallback?.tax_slices)
  if (mergedSlices) merged.tax_slices = mergedSlices
  merged.confidence = confidence
  return merged
}


/**
 * A vision model can misread the numeric grand total while the amount-in-words
 * line (a second, independently printed rendering of the same figure) is read
 * correctly. If the words disagree with the numeric total AND the words figure
 * reconciles against the printed taxable value + tax heads (+ any printed
 * round-off / discount / freight), the numeric total is the misread one: two
 * independent printed values agree against one. We then take the printed words
 * figure. Nothing is invented — if the words do not tie out either, the
 * candidate is returned untouched and the mismatch routes to review as before.
 */
function repairTotalFromWords(
  candidate: LedgerCandidate,
  toleranceMinor: bigint,
  repairs: string[],
): LedgerCandidate {
  const words = (candidate.total_amount_in_words ?? '').trim()
  if (!words) return candidate
  const wordsMinor = parseIndianAmountWords(words)
  if (wordsMinor === null) return candidate
  const printedMinor = moneyToMinorUnits(candidate.total_amount)
  const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a)
  if (printedMinor !== null && absDiff(printedMinor, wordsMinor) <= toleranceMinor) return candidate

  const taxable = moneyToMinorUnits(candidate.taxable_value)
  if (taxable === null) return candidate
  const components = {
    taxable,
    cgst: moneyToMinorUnits(candidate.cgst_amount),
    sgst: moneyToMinorUnits(candidate.sgst_amount),
    igst: moneyToMinorUnits(candidate.igst_amount),
    cess: moneyToMinorUnits(candidate.cess_amount),
    shipping: moneyToMinorUnits(candidate.shipping_amount),
    discount: moneyToMinorUnits(candidate.discount_amount),
    deduction: moneyToMinorUnits(candidate.deduction_amount),
    roundOff: moneyToMinorUnits(candidate.round_off),
  }
  // The numeric total must itself FAIL to tie (otherwise the words are the odd
  // one out and the existing amount-words-total-mismatch review flag applies).
  if (printedMinor !== null
    && reconcileInvoiceTotal({ ...components, printedTotal: printedMinor }, toleranceMinor).status === 'reconciles') {
    return candidate
  }
  const viaWords = reconcileInvoiceTotal({ ...components, printedTotal: wordsMinor }, toleranceMinor)
  if (viaWords.status !== 'reconciles') return candidate
  repairs.push('total-from-words')
  return { ...candidate, total_amount: minorUnitsToNumber(wordsMinor) }
}

/**
 * Evaluate a raw extraction candidate into a safe, review-routed ledger row.
 * `minConfidence` (0..1) is the auto-approve bar; below it the row is stored but
 * always flagged for human review.
 */
export function evaluateLedger(
  rawCandidate: LedgerCandidate,
  opts: {
    minConfidence: number
    amountToleranceMinorUnits?: number
    /** Injectable clock (tests). */ now?: Date
    /**
     * The workspace client's OWN GSTIN (the buyer on this purchase bill), when
     * known. A GSTIN equal to it can NEVER be the supplier, so the evaluator
     * rejects that assignment even when the invoice printed no separate recipient
     * token — the common AI-path gap that let a buyer GSTIN ship as the supplier.
     */
    buyerGstin?: string | null
  },
): LedgerEvaluation {
  const reasons: string[] = [];
  const repairs: string[] = [];
  const candidate = repairTotalFromWords(
    rawCandidate,
    BigInt(Math.max(0, Math.trunc(opts.amountToleranceMinorUnits ?? 101))),
    repairs,
  );

  const parsedDate = parseInvoiceDate(candidate.invoice_date);
  if (!parsedDate) reasons.push('invoice-date-unresolved');
  // A date that parses but cannot be a real invoice date (in the future, or
  // before GST existed) is almost always a misread digit. It is flagged and is
  // NOT treated as resolved, so the invoice is never batched into a wrong month.
  let iso: string | null = parsedDate;
  if (parsedDate) {
    const now = opts.now ?? new Date();
    const latestOk = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (parsedDate > latestOk) { reasons.push('invoice-date-future'); iso = null; }
    else if (parsedDate < GST_EPOCH) { reasons.push('invoice-date-before-gst'); iso = null; }
  }

  const invoiceNumber = (candidate.invoice_number ?? '').trim();
  const invoiceNumberValid = invoiceNumber !== '' && !isPlaceholderText(invoiceNumber)
  if (!invoiceNumber) reasons.push('invoice-number-missing')
  else if (!invoiceNumberValid) reasons.push('invoice-number-placeholder')

  const vendorName = (candidate.vendor_name ?? '').trim();
  const vendorNameValid = vendorName !== '' && !isPlaceholderText(vendorName)
  if (!vendorName) reasons.push('vendor-name-missing')
  else if (!vendorNameValid) reasons.push('vendor-name-placeholder')

  const gstin = (candidate.supplier_gstin ?? '').trim().toUpperCase();
  let gstinOk = false;
  if (!gstin) reasons.push('gstin-missing');
  else if (!GSTIN_RE.test(gstin)) reasons.push('gstin-invalid');
  else if (!gstinStateCodeValid(gstin)) reasons.push('gstin-state-invalid');
  else if (!gstinChecksumOk(gstin)) reasons.push('gstin-checksum-failed');
  else gstinOk = true;

  const taxable = toNumber(candidate.taxable_value);
  const total = toNumber(candidate.total_amount);
  // Unknown tax heads remain unknown. Zero is accepted only when the extractor
  // explicitly returned numeric/string zero; absence cannot be inferred from the
  // arithmetic or the invoice's apparent tax structure.
  const cgst = toNumber(candidate.cgst_amount);
  const sgst = toNumber(candidate.sgst_amount);
  const igst = toNumber(candidate.igst_amount);
  const amounts = [taxable, cgst, sgst, igst, total];
  const amountMinorUnits = [
    moneyToMinorUnits(candidate.taxable_value),
    moneyToMinorUnits(candidate.cgst_amount),
    moneyToMinorUnits(candidate.sgst_amount),
    moneyToMinorUnits(candidate.igst_amount),
    moneyToMinorUnits(candidate.total_amount),
  ];
  const amountsFinite = amountMinorUnits.every((value) => value !== null);
  const amountsNonNegative = amounts.every((n) => Number.isFinite(n) && n >= 0);
  let arithmeticConsistent = true;
  let structureConsistent = true;
  if (!amountsFinite) reasons.push('non-finite-amount');
  if (amounts.some((n) => Number.isFinite(n) && n < 0)) reasons.push('negative-amount');
  if (amountsFinite) {
    const [taxableMinor, cgstMinor, sgstMinor, igstMinor, totalMinor] = amountMinorUnits as bigint[];
    // Single, shared calculation engine (see ./calc/reconcile). The old code
    // hard-coded `taxable + cgst + sgst + igst === total`, which wrongly flagged
    // every invoice that prints a discount, freight, cess, deduction or round-off
    // (the Zetran sample false `total-mismatch`). We now reconcile the printed
    // total against all components the source actually carried.
    const toleranceMinorUnits = BigInt(Math.max(0, Math.trunc(opts.amountToleranceMinorUnits ?? 101)))
    const reconciliation = reconcileInvoiceTotal({
      taxable: taxableMinor,
      cgst: cgstMinor,
      sgst: sgstMinor,
      igst: igstMinor,
      cess: moneyToMinorUnits(candidate.cess_amount),
      shipping: moneyToMinorUnits(candidate.shipping_amount),
      discount: moneyToMinorUnits(candidate.discount_amount),
      deduction: moneyToMinorUnits(candidate.deduction_amount),
      roundOff: moneyToMinorUnits(candidate.round_off),
      printedTotal: totalMinor,
    }, toleranceMinorUnits)
    if (reconciliation.status !== 'reconciles') {
      arithmeticConsistent = false;
      reasons.push(...reconciliation.reasons);
    }
    // Structure checks. Extractors return 0 for "not found", so an all-zero
    // total is a miss, not an invoice; and the tax heads must be coherent.
    if (total === 0) { structureConsistent = false; reasons.push('total-zero'); }
    if (igst > 0 && (cgst > 0 || sgst > 0)) {
      structureConsistent = false;
      reasons.push('igst-with-cgst-sgst');
    } else if (amountMinorUnits[1] !== null && amountMinorUnits[2] !== null
      && (amountMinorUnits[1] > amountMinorUnits[2]
        ? amountMinorUnits[1] - amountMinorUnits[2]
        : amountMinorUnits[2] - amountMinorUnits[1]) > BigInt(5)) {
      // Intra-state CGST and SGST are always charged at equal rates.
      structureConsistent = false;
      reasons.push('cgst-sgst-unequal');
    }
    // The client's OWN GSTIN is the buyer. Placing it in the supplier slot is a
    // hard data-integrity error: the seller issued the bill, not the customer.
    // Caught even when no recipient token was independently parsed (the AI-path
    // gap). Never auto-approved; forces a targeted supplier re-read.
    const buyer = (opts.buyerGstin ?? '').trim().toUpperCase();
    if (buyer && gstin && gstin === buyer) {
      structureConsistent = false;
      reasons.push('supplier-equals-buyer');
    }
    // Tax head vs state: same supplier/recipient state => CGST+SGST; different
    // => IGST. Checked only when both GSTINs were actually read. The known own
    // GSTIN stands in as the recipient when the page printed no separate one.
    const printedRecipient = (candidate.recipient_gstin ?? '').trim().toUpperCase();
    const recipient = printedRecipient || buyer;
    if (gstinOk && GSTIN_RE.test(recipient)) {
      const sameState = gstin.slice(0, 2) === recipient.slice(0, 2);
      if (gstin === recipient) {
        // Identical only flags the READER's own confusion when the invoice itself
        // printed the duplicate; the own-vs-supplier case is flagged above as
        // 'supplier-equals-buyer' so a re-read hint names the buyer exactly.
        if (printedRecipient) {
          structureConsistent = false;
          reasons.push('supplier-equals-recipient');
        }
      } else if (sameState && igst > 0) {
        structureConsistent = false;
        reasons.push('igst-on-intrastate');
      } else if (!sameState && igst === 0 && (cgst > 0 || sgst > 0)) {
        structureConsistent = false;
        reasons.push('cgst-sgst-on-interstate');
      }
    }
  }

  // §P3-16 resolve the printed document type for the stored row. NOTE: this is
  // INFORMATIONAL here — it deliberately does NOT push a review reason. Forcing a
  // credit/debit note to review is done in the extraction HANDLER (mirroring the
  // conflict / image-quality / multi-invoice gates), so the auto-approve path is
  // blocked for a note while a HUMAN reviewing it in applyInvoiceReview is never
  // permanently stuck on a reason the shared re-scorer keeps re-adding. A negative
  // total on a note is STILL a hard review trigger regardless of type.
  const documentType: DocumentType =
    candidate.document_type === 'credit_note' || candidate.document_type === 'debit_note'
      ? candidate.document_type
      : 'invoice'

  // §UX multi-rate: an EXPLICIT multi-slab bill (two or more distinct printed
  // rates) cannot be checked with one flat per-head rate, so flag it here and skip
  // the single-rate cross-check below. Only explicit slices count — the vision
  // schema is flat, so an ordinary single-rate bill still runs the check. The
  // mixed-slice breakdown validator + the total invariant still guard its amounts.
  const rateCheckSlices = normalizeSlices(candidate.tax_slices)
  const multiRate = rateCheckSlices !== null && distinctTaxRates(rateCheckSlices).length >= 2

  const crossChecks = validateInvoiceCrossChecks({
    taxableValue: candidate.taxable_value,
    cgstAmount: candidate.cgst_amount,
    sgstAmount: candidate.sgst_amount,
    igstAmount: candidate.igst_amount,
    totalAmount: candidate.total_amount,
    toleranceMinorUnits: BigInt(Math.max(0, Math.trunc(opts.amountToleranceMinorUnits ?? 101))),
    // §UX: a rate/amount disagreement on a bill whose printed TOTAL already ties is
    // a SOFT advisory (a human may one-tap approve); if the total does NOT tie it
    // stays a HARD integrity break. The amounts themselves are never rewritten.
    totalReconciles: amountsFinite && arithmeticConsistent,
    multiRate,
    taxRates: {
      ...(candidate.cgst_rate_percent == null ? {} : { cgst: candidate.cgst_rate_percent }),
      ...(candidate.sgst_rate_percent == null ? {} : { sgst: candidate.sgst_rate_percent }),
      ...(candidate.igst_rate_percent == null ? {} : { igst: candidate.igst_rate_percent }),
    },
    totalAmountInWords: candidate.total_amount_in_words,
  });
  reasons.push(...crossChecks.reasons);

  // Measured confidence is our OWN signal; the model's self-report can only
  // lower it (a source that is unsure of a field must not be auto-approved just
  // because the deterministic shape looked clean).
  const measuredConfidence = Math.max(0, computeMeasured({
    dateResolved: iso !== null,
    gstinValid: gstinOk,
    invoiceNumberPresent: invoiceNumberValid,
    vendorNamePresent: vendorNameValid,
    amountsFinite,
    amountsNonNegative,
    arithmeticConsistent,
    structureConsistent,
  }) - crossChecks.measuredConfidencePenalty);
  const self = selfConfidence(candidate);
  // The reported gate value is unchanged: our objective measure, conservatively
  // downgraded by any genuine source doubt (never raised by it).
  const confidence = self === null ? measuredConfidence : Math.min(measuredConfidence, self);
  // §clean-row rule (user #1): a deterministically-valid row is auto-approved. We
  // flag for review only when OUR OWN objective checks fall below the bar, OR the
  // model reports genuine doubt (below AI_SELF_CONFIDENCE_FLOOR) on a field it
  // actually filled. A merely-modest self-report no longer vetoes a clean bill.
  // Every hard integrity trigger (invalid/missing GSTIN, negative or unreconciled
  // amounts, buyer/supplier swap, conflicts, credit notes, multi-invoice) is pushed
  // as a reason earlier and is untouched — precision is preserved, recall improves.
  if (measuredConfidence < opts.minConfidence) {
    reasons.push(`low-confidence:${measuredConfidence.toFixed(2)}`);
  } else if (self !== null && self < AI_SELF_CONFIDENCE_FLOOR) {
    reasons.push(`low-confidence:source:${self.toFixed(2)}`);
  }

  const row: LedgerRow = {
    invoice_date: parsedDate ?? (candidate.invoice_date ?? '').trim(),
    invoice_number: invoiceNumber,
    vendor_name: vendorName,
    supplier_gstin: gstin,
    taxable_value: money(taxable),
    cgst_amount: money(cgst),
    sgst_amount: money(sgst),
    igst_amount: money(igst),
    total_amount: money(total),
    // Carry-forward the printed structural fields the Tally import needs. These
    // are taken ONLY from what the source printed (via mergeCandidates they
    // survive local/AI blending); an absent value stays null, never a zero and
    // never back-computed from the amounts. round_off may legitimately be < 0.
    round_off: money(toNumber(candidate.round_off)),
    cgst_rate_percent: ratePercent(candidate.cgst_rate_percent),
    sgst_rate_percent: ratePercent(candidate.sgst_rate_percent),
    igst_rate_percent: ratePercent(candidate.igst_rate_percent),
    // §P3-16 always set (defaults to 'invoice'), so a stored row is self-describing.
    document_type: documentType,
  };

  // ---- rate-wise tax breakdown (multi-GST-rate) ------------------------------
  // ADDITIVE ONLY: this block can attach slices and raise `mixed-gst-*` review
  // reasons, but it NEVER clears a reason raised above and NEVER approves a row on
  // its own. A single-rate invoice carries no explicit multi-rate evidence, so it
  // is left exactly as before (one derived slice at most, no new reasons) — every
  // pre-existing test keeps its outcome. Only a genuine MULTI-rate bill (two or
  // more distinct rates in explicit parsed/human slices) is validated here.
  const explicitSlices = normalizeSlices(candidate.tax_slices)
  const derivedSlices = deriveSlicesFromInvoiceHeads(row)
  const candidateSlices = explicitSlices ?? derivedSlices
  let breakdownValidated: boolean | null = null
  if (candidateSlices && candidateSlices.length > 0) {
    const tolMinor = BigInt(Math.max(0, Math.trunc(opts.amountToleranceMinorUnits ?? 101)))
    const mixed = explicitSlices !== null && distinctTaxRates(explicitSlices).length >= 2
    if (mixed) {
      const result = validateTaxSlices(explicitSlices, {
        taxable_value: row.taxable_value,
        cgst_amount: row.cgst_amount,
        sgst_amount: row.sgst_amount,
        igst_amount: row.igst_amount,
        total_amount: row.total_amount,
      }, tolMinor)
      breakdownValidated = result.breakdownValidated
      row.tax_slices = result.slices
      if (!result.breakdownValidated) {
        // A mixed-rate bill whose breakdown is incomplete or self-contradictory can
        // never be silently approved: name every gap and force review.
        for (const r of result.reasons) reasons.push(r)
        if (!reasons.includes(MIXED_GST_REASONS.breakdownMissing)) {
          reasons.push(MIXED_GST_REASONS.breakdownMissing)
        }
      }
    } else {
      // Single (or zero) rate: keep a reliable slice for the breakdown sheet, but
      // run no additional gating so historical single-rate behaviour is untouched.
      row.tax_slices = candidateSlices
      breakdownValidated = null
    }
  }

  return {
    row,
    review: reasons.length === 0 ? 'approved' : 'needs_review',
    reasons,
    confidence,
    measuredConfidence,
    invoiceDateResolved: iso !== null,
    repairs,
    breakdownValidated,
  };
}

/**
 * The fields on which two sources disagreeing is a RELIABILITY signal worth
 * human review (not a mere optional-field gap). A difference is only a conflict
 * when BOTH sources produced an independently VALID, materially different value —
 * a repair of a value one source left missing/garbage is NOT a conflict.
 */
const CRITICAL_CONFLICT_FIELDS = ['invoice_date', 'invoice_number', 'supplier_gstin', 'total_amount'] as const

const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

function fieldIndependentlyValid(field: string, raw: unknown): boolean {
  switch (field) {
    case 'invoice_date': return parseInvoiceDate(asText(raw)) !== null
    case 'supplier_gstin': return gstinFullyValid(asText(raw).trim().toUpperCase())
    case 'invoice_number': { const s = asText(raw).trim(); return s !== '' && !isPlaceholderText(s) }
    case 'total_amount': return moneyToMinorUnits(raw as number | string | null | undefined) !== null
    default: return asText(raw).trim() !== ''
  }
}

/** Canonicalise a value so a formatting difference is never read as a conflict. */
function normalizeForCompare(field: string, raw: unknown): string {
  switch (field) {
    case 'invoice_date': return parseInvoiceDate(asText(raw)) ?? ''
    case 'supplier_gstin': return asText(raw).trim().toUpperCase()
    case 'invoice_number': return asText(raw).trim().toLowerCase().replace(/\s+/g, '')
    case 'total_amount': {
      const minor = moneyToMinorUnits(raw as number | string | null | undefined)
      return minor === null ? '' : minor.toString()
    }
    default: return asText(raw).trim().toLowerCase()
  }
}

/**
 * Names of the critical fields on which two raw candidates both give a valid
 * but different answer. Used to record provenance and to refuse a silent
 * auto-approve over unreconciled disagreement (a machine must not pick a
 * winner between two credible, contradictory human-visible readings).
 *
 * `credibility` gates WHICH pairings actually count. The safety intent is to
 * stop a machine silently choosing between two TRUSTWORTHY but contradictory
 * readings — so a conflict is only recorded when BOTH sides are credible. If
 * one reading is itself disqualified (its evaluation was not approved, or it
 * carries hard validation failures — e.g. a zero-confidence scanned-OCR mis
 * read), its disagreement is noise, not a genuine contradiction, and must not
 * veto the credible reading. The independent per-row validation still guards
 * the selected candidate. When `credibility` is omitted we assume both sides
 * are credible (a pure two-candidate comparison).
 */
export function detectCandidateConflicts(
  a: LedgerCandidate | null | undefined,
  b: LedgerCandidate | null | undefined,
  credibility?: { a: boolean; b: boolean },
): string[] {
  if (!a || !b) return []
  if (credibility && (!credibility.a || !credibility.b)) return []
  const out: string[] = []
  for (const field of CRITICAL_CONFLICT_FIELDS) {
    const va = (a as Record<string, unknown>)[field]
    const vb = (b as Record<string, unknown>)[field]
    if (
      fieldIndependentlyValid(field, va)
      && fieldIndependentlyValid(field, vb)
      && normalizeForCompare(field, va) !== normalizeForCompare(field, vb)
    ) {
      out.push(field)
    }
  }
  return out
}

/**
 * Reason codes that mean "this row contains contradictory or outright invalid
 * data" — as opposed to a field that is merely missing or softly low-confidence.
 * A candidate that ADDS one of these is strictly less trustworthy, so it must
 * not win a ranking purely for carrying more fields.
 */
const HARD_VALIDATION_FAILURES = new Set([
  'invoice-date-future', 'invoice-date-before-gst', 'gstin-invalid', 'gstin-state-invalid',
  'gstin-checksum-failed', 'invoice-number-placeholder', 'vendor-name-placeholder',
  'non-finite-amount', 'negative-amount', 'total-mismatch', 'total-zero',
  'igst-with-cgst-sgst', 'cgst-sgst-unequal', 'igst-on-intrastate', 'cgst-sgst-on-interstate',
  'supplier-equals-recipient', 'tax-rate-mismatch', 'tax-rate-amount-missing', 'tax-rate-invalid',
  'tax-rate-cgst-sgst-unequal', 'tax-rate-igst-with-cgst-sgst', 'amount-words-total-mismatch',
  'candidate-conflict',
  // NOTE: `tax-rate-advisory` is DELIBERATELY ABSENT. It is the SAME rate/amount
  // disagreement raised only when the invoice total already ties out, so it is a
  // soft reliability hint (a human may one-tap approve), never an integrity break.
])

export function hardValidationFailureCount(reasons: readonly string[]): number {
  let n = 0
  for (const r of reasons) {
    if (HARD_VALIDATION_FAILURES.has(r.split(':')[0])) n += 1
  }
  return n
}

/** How many canonical row fields actually carry a value (completeness). */
export function presentFieldCount(row: LedgerRow): number {
  let n = 0
  if (row.invoice_date) n += 1
  if (row.invoice_number) n += 1
  if (row.vendor_name) n += 1
  if (row.supplier_gstin) n += 1
  for (const f of ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount'] as const) {
    if (row[f] !== null && row[f] !== undefined) n += 1
  }
  return n
}

/** One fully-evaluated candidate + where it came from, ready to be ranked. */
export interface CandidateAssessment {
  candidate: LedgerCandidate
  evaluation: LedgerEvaluation
  source: string
}

/**
 * Pick the candidate that best REPRESENTS the document — i.e. the one a human
 * reviewer can actually correct. This is a SELECTION rule, not an approval rule:
 * whatever it returns is still re-validated, and any arithmetic contradiction
 * (total/tax/amount-words mismatch) or cross-source conflict keeps the row in
 * needs_review. Selection never auto-accepts anything.
 *
 * The rules are lexicographic (each level is consulted only when all higher
 * levels tie):
 *   1. an approved (all-checks-passed) row beats a needs_review row — a clean,
 *      fully-valid candidate is never displaced by a richer but contradictory
 *      merge (this is the "don't auto-accept conflicting AI" guard);
 *   2. greater field completeness — between two rows that BOTH still need
 *      review, prefer the one that carries more of the invoice. The 17 Oct bug
 *      was a sparse local row (missing heads => one `non-finite-amount` code)
 *      beating a far fuller merge simply because it happened to carry FEWER
 *      reason codes; a partial row is not "safer", it is just less useful, so
 *      completeness is judged BEFORE the failure count;
 *   3. fewer hard validation failures — at EQUAL completeness, the less
 *      self-contradictory candidate wins (so a fuller row can never bury an
 *      equally-full clean one on field count alone);
 *   4. higher independently MEASURED confidence (never the model's self-report,
 *      which only ever lowers trust);
 *   5. full tie keeps the EARLIER candidate — stable, so a non-destructive merge
 *      that adds nothing does not needlessly flip provenance.
 * Confidence is a tie-breaker, never a gate, so a more-complete and equally-safe
 * result always survives.
 */
export function selectBestCandidate(
  assessments: readonly CandidateAssessment[],
): CandidateAssessment | null {
  if (assessments.length === 0) return null
  const isBetter = (a: CandidateAssessment, b: CandidateAssessment): boolean => {
    const aApproved = a.evaluation.review === 'approved' ? 1 : 0
    const bApproved = b.evaluation.review === 'approved' ? 1 : 0
    if (aApproved !== bApproved) return aApproved > bApproved
    const aCount = presentFieldCount(a.evaluation.row)
    const bCount = presentFieldCount(b.evaluation.row)
    if (aCount !== bCount) return aCount > bCount
    const aHard = hardValidationFailureCount(a.evaluation.reasons)
    const bHard = hardValidationFailureCount(b.evaluation.reasons)
    if (aHard !== bHard) return aHard < bHard
    if (a.evaluation.measuredConfidence !== b.evaluation.measuredConfidence) {
      return a.evaluation.measuredConfidence > b.evaluation.measuredConfidence
    }
    return false
  }
  return assessments.reduce((best, cur) => (isBetter(cur, best) ? cur : best))
}

/**
 * Turn the failed checks of a first read into one precise instruction for a
 * SECOND, targeted AI read. Only reasons a re-read can plausibly fix are
 * included (a misread digit, a swapped party, a wrong total); a field that is
 * simply not on the page is never "fixed" by asking again. Returns null when
 * nothing is worth re-asking.
 */
export function retryHintFor(
  reasons: readonly string[],
  opts?: { buyerGstin?: string | null },
): string | null {
  const lines: string[] = [];
  for (const r of reasons) {
    if (r === 'gstin-checksum-failed' || r === 'gstin-invalid' || r === 'gstin-state-invalid') {
      lines.push('The supplier_gstin you returned is not a valid GSTIN; re-read it character by character (watch O/0, I/1, S/5, B/8) and make sure it is the SELLER\'s, not the buyer\'s.');
    } else if (r.startsWith('total-mismatch')) {
      lines.push('taxable_value + cgst_amount + sgst_amount + igst_amount did not equal total_amount (within 1 rupee); re-read each amount from the tax summary and the grand total.');
    } else if (r === 'total-zero') {
      lines.push('total_amount came back as 0; locate the grand total / amount payable.');
    } else if (r === 'igst-with-cgst-sgst' || r === 'cgst-sgst-unequal') {
      lines.push('The tax heads are inconsistent (an invoice charges either IGST or equal CGST+SGST); re-read the tax amounts.');
    } else if (r === 'invoice-date-future' || r === 'invoice-date-before-gst' || r === 'invoice-date-unresolved') {
      lines.push('invoice_date was missing or implausible; re-read the INVOICE date (not the due, order or delivery date).');
    } else if (r === 'supplier-equals-recipient') {
      lines.push('supplier_gstin and recipient_gstin were identical; the supplier is the seller who issued the invoice.');
    } else if (r === 'supplier-equals-buyer') {
      const own = (opts?.buyerGstin ?? '').trim().toUpperCase();
      lines.push('You returned the buyer\'s OWN GSTIN' + (own ? ` (${own})` : '') + ' as supplier_gstin; that GSTIN belongs to the customer and can NEVER be the supplier. Re-read the SELLER\'s GSTIN from the "Supplier / Sold By / Invoice From" block.');
    } else if (r.startsWith('tax-rate-mismatch:') || r.startsWith('tax-rate-advisory:') || r.startsWith('tax-rate-amount-missing:')) {
      lines.push('The printed tax percentage and extracted tax amount did not agree; re-read the taxable value, rate and corresponding tax amount. Do not calculate a replacement unless the printed values support it.');
    } else if (r === 'tax-rate-invalid:cgst' || r === 'tax-rate-invalid:sgst' || r === 'tax-rate-invalid:igst') {
      lines.push('A printed tax rate could not be parsed as a percentage from 0 to 100; re-read it exactly as printed.');
    } else if (r === 'tax-rate-cgst-sgst-unequal' || r === 'tax-rate-igst-with-cgst-sgst') {
      lines.push('The printed tax rates conflict with the tax-head structure; re-read the rate and tax summary without inferring values.');
    } else if (r === 'amount-words-total-mismatch') {
      lines.push('The printed total in words disagrees with the numeric total; re-read both and do not choose one unless the document is clear.');
    }
  }
  const unique = [...new Set(lines)];
  return unique.length === 0
    ? null
    : `A previous read of this document failed validation. ${unique.join(' ')} Correct a value only if the printed document supports it; otherwise leave it empty with low confidence.`;
}
