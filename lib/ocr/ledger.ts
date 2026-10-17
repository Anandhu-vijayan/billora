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
import { validateInvoiceCrossChecks } from './validators'
import { minorUnitsToNumber, minorUnitsToString, moneyToMinorUnits } from './validators/money'

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
  cgst_rate_percent?: number | string | null;
  sgst_rate_percent?: number | string | null;
  igst_rate_percent?: number | string | null;
  total_amount_in_words?: string | null;
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
}

// Mirrors lib/ocr/quality.ts GSTIN_RE exactly (kept in sync by a test).
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const REQUIRED_FIELDS = [
  'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
  'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
] as const;

// First day of GST (1 July 2017): no valid GST invoice predates it.
const GST_EPOCH = '2017-07-01';

const money = (n: number): number | null => Number.isFinite(n) ? n : null

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
  // Day-first: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (Indian convention).
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const day = Number(dd), mon = Number(mm), year = Number(yyyy);
    if (validateParts(year, mon, day)) {
      return `${yyyy}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }
  // Month-name forms are UNAMBIGUOUS because the month is spelled out, so they
  // are safe to accept: "5 Sep 2026", "05-Sep-2026", "5 September 2026".
  const dMonthY = /^(\d{1,2})[ .\-]+([A-Za-z]{3,9})[ .\-]*(\d{4})$/.exec(s);
  if (dMonthY) {
    const mon = monthFromName(dMonthY[2]);
    const day = Number(dMonthY[1]), year = Number(dMonthY[3]);
    if (mon !== null && validateParts(year, mon, day)) {
      return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }
  // Month-first with a spelled month: "Sep 5, 2026", "September 5 2026".
  const monthDY = /^([A-Za-z]{3,9})[ .]+(\d{1,2}),?[ .]+(\d{4})$/.exec(s);
  if (monthDY) {
    const mon = monthFromName(monthDY[1]);
    const day = Number(monthDY[2]), year = Number(monthDY[3]);
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

/**
 * The model's own lowest required-field confidence, or null when it gave none.
 * This is only ever a conservative DOWNGRADE signal — it can lower trust, and
 * the auto-approve gate never rests on it alone (see measuredConfidence below).
 */
function selfConfidence(candidate: LedgerCandidate): number | null {
  const c = candidate.confidence;
  if (!c || typeof c !== 'object') return null;
  let min = 1;
  let seen = false;
  for (const field of REQUIRED_FIELDS) {
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
  merged.confidence = confidence
  return merged
}

/**
 * Evaluate a raw extraction candidate into a safe, review-routed ledger row.
 * `minConfidence` (0..1) is the auto-approve bar; below it the row is stored but
 * always flagged for human review.
 */
export function evaluateLedger(
  candidate: LedgerCandidate,
  opts: {
    minConfidence: number
    amountToleranceMinorUnits?: number
    /** Injectable clock (tests). */ now?: Date
  },
): LedgerEvaluation {
  const reasons: string[] = [];

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
    const taxSumMinor = taxableMinor + cgstMinor + sgstMinor + igstMinor;
    const differenceMinor = taxSumMinor > totalMinor ? taxSumMinor - totalMinor : totalMinor - taxSumMinor;
    const toleranceMinorUnits = BigInt(Math.max(0, Math.trunc(opts.amountToleranceMinorUnits ?? 101)))
    if (differenceMinor > toleranceMinorUnits) {
      arithmeticConsistent = false;
      reasons.push(`total-mismatch:${minorUnitsToString(taxSumMinor)}!=${minorUnitsToString(totalMinor)}`);
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
    // Tax head vs state: same supplier/recipient state => CGST+SGST; different
    // => IGST. Checked only when both GSTINs were actually read.
    const recipient = (candidate.recipient_gstin ?? '').trim().toUpperCase();
    if (gstinOk && GSTIN_RE.test(recipient)) {
      const sameState = gstin.slice(0, 2) === recipient.slice(0, 2);
      if (gstin === recipient) {
        structureConsistent = false;
        reasons.push('supplier-equals-recipient');
      } else if (sameState && igst > 0) {
        structureConsistent = false;
        reasons.push('igst-on-intrastate');
      } else if (!sameState && igst === 0 && (cgst > 0 || sgst > 0)) {
        structureConsistent = false;
        reasons.push('cgst-sgst-on-interstate');
      }
    }
  }

  const crossChecks = validateInvoiceCrossChecks({
    taxableValue: candidate.taxable_value,
    cgstAmount: candidate.cgst_amount,
    sgstAmount: candidate.sgst_amount,
    igstAmount: candidate.igst_amount,
    totalAmount: candidate.total_amount,
    toleranceMinorUnits: BigInt(Math.max(0, Math.trunc(opts.amountToleranceMinorUnits ?? 101))),
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
  const confidence = self === null ? measuredConfidence : Math.min(measuredConfidence, self);
  if (confidence < opts.minConfidence) reasons.push(`low-confidence:${confidence.toFixed(2)}`);

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
  };

  return {
    row,
    review: reasons.length === 0 ? 'approved' : 'needs_review',
    reasons,
    confidence,
    measuredConfidence,
    invoiceDateResolved: iso !== null,
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
 */
export function detectCandidateConflicts(
  a: LedgerCandidate | null | undefined,
  b: LedgerCandidate | null | undefined,
): string[] {
  if (!a || !b) return []
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
export function retryHintFor(reasons: readonly string[]): string | null {
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
    } else if (r.startsWith('tax-rate-mismatch:') || r.startsWith('tax-rate-amount-missing:')) {
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
