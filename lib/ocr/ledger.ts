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
export interface LedgerRow {
  invoice_date: string;
  invoice_number: string;
  vendor_name: string;
  supplier_gstin: string;
  taxable_value: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_amount: number;
}

/** A raw extraction candidate: values plus an optional per-field confidence. */
export interface LedgerCandidate {
  invoice_date?: string | null;
  invoice_number?: string | null;
  vendor_name?: string | null;
  supplier_gstin?: string | null;
  taxable_value?: number | string | null;
  cgst_amount?: number | string | null;
  sgst_amount?: number | string | null;
  igst_amount?: number | string | null;
  total_amount?: number | string | null;
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

const money = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

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
  const dmy = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const day = Number(dd), mon = Number(mm), year = Number(yyyy);
    if (validateParts(year, mon, day)) {
      return `${yyyy}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,\s]/g, '').replace(/₹/g, '');
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
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
}): number {
  let m = 1;
  if (!parts.dateResolved) m -= 0.5;
  if (!parts.gstinValid) m -= 0.35;
  if (!parts.invoiceNumberPresent) m -= 0.3;
  if (!parts.vendorNamePresent) m -= 0.3;
  if (!parts.amountsFinite) m -= 0.5;
  if (!parts.amountsNonNegative) m -= 0.4;
  if (!parts.arithmeticConsistent) m -= 0.4;
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
  const isGstinValid = (raw: string | null | undefined): boolean =>
    GSTIN_RE.test((raw ?? '').trim().toUpperCase())
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
  opts: { minConfidence: number },
): LedgerEvaluation {
  const reasons: string[] = [];

  const iso = parseInvoiceDate(candidate.invoice_date);
  if (!iso) reasons.push('invoice-date-unresolved');

  const invoiceNumber = (candidate.invoice_number ?? '').trim();
  if (!invoiceNumber) reasons.push('invoice-number-missing');

  const vendorName = (candidate.vendor_name ?? '').trim();
  if (!vendorName) reasons.push('vendor-name-missing');

  const gstin = (candidate.supplier_gstin ?? '').trim().toUpperCase();
  if (!gstin) reasons.push('gstin-missing');
  else if (!GSTIN_RE.test(gstin)) reasons.push('gstin-invalid');

  const taxable = toNumber(candidate.taxable_value);
  const cgst = toNumber(candidate.cgst_amount);
  const sgst = toNumber(candidate.sgst_amount);
  const igst = toNumber(candidate.igst_amount);
  const total = toNumber(candidate.total_amount);
  const amounts = [taxable, cgst, sgst, igst, total];
  const amountsFinite = amounts.every((n) => Number.isFinite(n));
  const amountsNonNegative = amounts.every((n) => Number.isFinite(n) && n >= 0);
  let arithmeticConsistent = true;
  if (!amountsFinite) reasons.push('non-finite-amount');
  if (amounts.some((n) => Number.isFinite(n) && n < 0)) reasons.push('negative-amount');
  if (amountsFinite) {
    const taxSum = taxable + cgst + sgst + igst;
    if (Math.abs(taxSum - total) > 1.01) {
      arithmeticConsistent = false;
      reasons.push(`total-mismatch:${taxSum.toFixed(2)}!=${total.toFixed(2)}`);
    }
  }

  // Measured confidence is our OWN signal; the model's self-report can only
  // lower it (a source that is unsure of a field must not be auto-approved just
  // because the deterministic shape looked clean).
  const measuredConfidence = computeMeasured({
    dateResolved: iso !== null,
    gstinValid: gstin !== '' && GSTIN_RE.test(gstin),
    invoiceNumberPresent: invoiceNumber !== '',
    vendorNamePresent: vendorName !== '',
    amountsFinite,
    amountsNonNegative,
    arithmeticConsistent,
  });
  const self = selfConfidence(candidate);
  const confidence = self === null ? measuredConfidence : Math.min(measuredConfidence, self);
  if (confidence < opts.minConfidence) reasons.push(`low-confidence:${confidence.toFixed(2)}`);

  const row: LedgerRow = {
    invoice_date: iso ?? (candidate.invoice_date ?? '').trim(),
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
