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
  opts: { minConfidence: number; /** Injectable clock (tests). */ now?: Date },
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
  if (!invoiceNumber) reasons.push('invoice-number-missing');

  const vendorName = (candidate.vendor_name ?? '').trim();
  if (!vendorName) reasons.push('vendor-name-missing');

  const gstin = (candidate.supplier_gstin ?? '').trim().toUpperCase();
  let gstinOk = false;
  if (!gstin) reasons.push('gstin-missing');
  else if (!GSTIN_RE.test(gstin)) reasons.push('gstin-invalid');
  else if (!gstinStateCodeValid(gstin)) reasons.push('gstin-state-invalid');
  else if (!gstinChecksumOk(gstin)) reasons.push('gstin-checksum-failed');
  else gstinOk = true;

  const taxable = toNumber(candidate.taxable_value);
  const total = toNumber(candidate.total_amount);
  // A tax head the document simply does not print (an interstate invoice has no
  // CGST/SGST lines; an intrastate one has no IGST line) is ABSENT, not
  // unreadable. It is read as 0 only while taxable and total are both present,
  // and the arithmetic check below must then still reconcile — so a head that
  // the parser merely failed to find shows up as a total-mismatch, never as a
  // silently wrong approved row. A missing taxable/total is never defaulted.
  const isAbsent = (v: number | string | null | undefined): boolean =>
    v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  const taxHead = (v: number | string | null | undefined): number =>
    isAbsent(v) && Number.isFinite(taxable) && Number.isFinite(total) ? 0 : toNumber(v);
  const cgst = taxHead(candidate.cgst_amount);
  const sgst = taxHead(candidate.sgst_amount);
  const igst = taxHead(candidate.igst_amount);
  const amounts = [taxable, cgst, sgst, igst, total];
  const amountsFinite = amounts.every((n) => Number.isFinite(n));
  const amountsNonNegative = amounts.every((n) => Number.isFinite(n) && n >= 0);
  let arithmeticConsistent = true;
  let structureConsistent = true;
  if (!amountsFinite) reasons.push('non-finite-amount');
  if (amounts.some((n) => Number.isFinite(n) && n < 0)) reasons.push('negative-amount');
  if (amountsFinite) {
    const taxSum = taxable + cgst + sgst + igst;
    if (Math.abs(taxSum - total) > 1.01) {
      arithmeticConsistent = false;
      reasons.push(`total-mismatch:${taxSum.toFixed(2)}!=${total.toFixed(2)}`);
    }
    // Structure checks. Extractors return 0 for "not found", so an all-zero
    // total is a miss, not an invoice; and the tax heads must be coherent.
    if (total === 0) { structureConsistent = false; reasons.push('total-zero'); }
    if (igst > 0 && (cgst > 0 || sgst > 0)) {
      structureConsistent = false;
      reasons.push('igst-with-cgst-sgst');
    } else if (Math.abs(cgst - sgst) > 0.05) {
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

  // Measured confidence is our OWN signal; the model's self-report can only
  // lower it (a source that is unsure of a field must not be auto-approved just
  // because the deterministic shape looked clean).
  const measuredConfidence = computeMeasured({
    dateResolved: iso !== null,
    gstinValid: gstinOk,
    invoiceNumberPresent: invoiceNumber !== '',
    vendorNamePresent: vendorName !== '',
    amountsFinite,
    amountsNonNegative,
    arithmeticConsistent,
    structureConsistent,
  });
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
    }
  }
  const unique = [...new Set(lines)];
  return unique.length === 0
    ? null
    : `A previous read of this document failed validation. ${unique.join(' ')} Correct a value only if the printed document supports it; otherwise leave it empty with low confidence.`;
}
