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
  /** Lowest per-field confidence across the required fields (0 when unknown). */
  confidence: number;
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

/** Lowest confidence across the required fields; 0 when the model gave none. */
function overallConfidence(candidate: LedgerCandidate): number {
  const c = candidate.confidence;
  if (!c || typeof c !== 'object') return 0;
  let min = 1;
  let seen = false;
  for (const field of REQUIRED_FIELDS) {
    const value = c[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      seen = true;
      if (value < min) min = value;
    }
  }
  return seen ? min : 0;
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
  if (amounts.some((n) => !Number.isFinite(n))) reasons.push('non-finite-amount');
  if (amounts.some((n) => Number.isFinite(n) && n < 0)) reasons.push('negative-amount');
  if (amounts.every((n) => Number.isFinite(n))) {
    const taxSum = taxable + cgst + sgst + igst;
    if (Math.abs(taxSum - total) > 1.01) {
      reasons.push(`total-mismatch:${taxSum.toFixed(2)}!=${total.toFixed(2)}`);
    }
  }

  const confidence = overallConfidence(candidate);
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
    invoiceDateResolved: iso !== null,
  };
}
