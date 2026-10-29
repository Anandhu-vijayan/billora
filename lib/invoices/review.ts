// lib/invoices/review.ts — the complete human-review path for a needs_review invoice.
//
// WHY THIS EXISTS: an image invoice that no local engine can read (and that the
// privacy gate kept away from AI) lands as `needs_review` with no reliable fields,
// so it is deliberately left UNBATCHED and NO register workbook is ever scheduled.
// Before this module there was NO code anywhere that could take such an invoice,
// let a reviewer correct it, approve it, and push it into its real (client, month)
// batch + generate the Excel — the Image -> Review -> Excel workflow dead-ended.
// This is that missing middle.
//
// Non-negotiables enforced here:
//   * NEVER fabricate: the reviewer supplies corrected fields; anything they leave
//     blank is filled ONLY from the already-extracted values (mergeCandidates keeps
//     a source value solely when it is INDEPENDENTLY VALID), never invented. If a
//     reliable invoice date is still absent the invoice stays needs_review.
//   * Preserve the original: the stored encrypted invoice file is never touched;
//     the missing-field reasons are re-derived from the real evaluation and returned.
//   * Tenant isolation: every read/write is scoped by the caller's workspace_id.
//   * Correct period: batch is resolved from the corrected, reliably parsed invoice
//     DATE (never the upload date) and the invoice's OWN client, idempotently.
//   * Idempotent register scheduling: approving enqueues register_generation through
//     the SAME shared path as auto-extraction, so repeated confirmations/duplicate
//     deliveries never create duplicate batches or workbook jobs.
import type { SupabaseClient } from '@supabase/supabase-js'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { encryptExtractedPayload, decryptExtractedPayload } from '@/lib/encryption'
import { deriveKeyVersion } from '@/lib/encryption/files'
import { evaluateLedger, mergeCandidates, type LedgerCandidate, type LedgerRow } from '@/lib/ocr/ledger'
import {
  applyUserClassification, isAccountingCategory, isDocTypeFull, isItcEligibility, CLASSIFICATION_VERSION,
  type ClassificationResult,
} from '@/lib/ocr/classify'
import { moneyToMinorUnits, minorUnitsToNumber } from '@/lib/ocr/validators/money'
import { resolveInvoiceBatch } from '@/lib/invoices/batch'

type Db = SupabaseClient

/**
 * The client's OWN (buyer) GSTIN, read tenant-scoped and FAIL-SOFT. This is what
 * lets the human approval / correction paths run the SAME supplier==buyer guard
 * as extraction (§P0-4): a row the reviewer confirms is re-validated against the
 * known buyer, so a buyer GSTIN mislabelled as the supplier can never be approved
 * into the register. We `select('*')` so an unapplied additive own_gstin migration
 * can never raise PGRST204 here — the key is simply absent and we continue null
 * (the same resilience that fixed the session-save regression).
 */
async function loadBuyerGstin(
  db: Db, workspaceId: string, clientId: string | null | undefined,
): Promise<string | null> {
  if (!clientId) return null
  const { data, error } = await db
    .from('clients').select('*')
    .eq('workspace_id', workspaceId).eq('id', clientId).maybeSingle()
  if (error) {
    logger.warn('[Review] client own_gstin read failed; approving without buyer cross-check', {
      clientId, kind: error.code ?? 'unknown',
    })
    return null
  }
  return (data as { own_gstin?: string | null } | null)?.own_gstin ?? null
}

/** PostgREST renders bytea as a `\x`-prefixed hex string (same as intake/register). */
function byteaToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/i, ''), 'hex')
  throw new Error('BYTEA_DECODE_ERROR: unexpected encrypted_payload encoding')
}

// ---- correction audit, carried inside the ENCRYPTED payload ----------------
// §2.4 / §7: preserve the original extracted values and a bounded correction
// history WITHOUT adding database columns — the encrypted invoice payload already
// holds the row, so one extra sibling key carries provenance. Every reader that
// indexes a known field ignores it; it never leaks into the register (the fresh
// LedgerRow is what the workbook reads) and is never logged.
type StoredRecord = Record<string, unknown>
interface CorrectionHistoryEntry { field: string; from: string | null; to: string | null; at: string; source: 'human' }
interface CorrectionAudit { originalExtracted: StoredRecord | null; history: CorrectionHistoryEntry[] }
const AUDIT_KEY = '_audit'
// The machine reason codes for the CURRENT row, carried as an encrypted sibling
// key (like the audit) so no new column is needed and nothing leaks into the
// register (only the canonical LedgerRow is read for export) or the logs (§P0-3).
const REASONS_KEY = '_reviewReasons'
// Informational sibling written by extraction so P0-1c can learn a client's own
// GSTIN from the recurring buyer token. Stripped here (underscore-prefixed, never
// a candidate field) so a review merge can never read it as invoice data.
const RECIPIENT_KEY = '_recipientGstin'
// §Part-2 the machine classification (document TYPE vs accounting CATEGORY) for
// this row, carried as its own encrypted sibling exactly like the audit/reasons.
// It is split OUT of the candidate on read (so it can never be merged as invoice
// data) and re-attached on write, so a correction/approval never silently drops
// it. Its `needsReview` guard is re-folded (ADDITIVELY) on every re-score, so a
// non-invoice document can never be approved by an edit that re-derives reasons
// from scratch. Never overwrites the original OCR row (§2.3).
const CLASSIFICATION_KEY = '_classification'
const AUDIT_HISTORY_CAP = 50

/** A reviewer-confirmed classification change; values are validated as enums. */
export interface ClassificationPatch { documentType?: unknown; accountingCategory?: unknown; itcEligibility?: unknown }

function decodeStoredRecord(encryptedPayload: unknown, masterKeyHex: string): StoredRecord | null {
  try {
    const plain = decryptExtractedPayload(byteaToBuffer(encryptedPayload), masterKeyHex)
    const parsed = JSON.parse(plain) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StoredRecord : null
  } catch {
    // A corrupt stored payload is "no prior value": never let a damaged row
    // silently suppress the reviewer's corrections.
    return null
  }
}

/** Split a stored record into the field candidate, its audit, reason codes and classification. */
function splitAudit(record: StoredRecord | null): { candidate: LedgerCandidate; audit: CorrectionAudit | null; reasons: string[]; classification: ClassificationResult | null } {
  if (!record) return { candidate: {}, audit: null, reasons: [], classification: null }
  const { [AUDIT_KEY]: auditRaw, [REASONS_KEY]: reasonsRaw, [CLASSIFICATION_KEY]: classRaw, ...candidate } = record
  // Drop the informational recipient sibling (§P0-1c) so a review merge can never
  // read it back as a candidate field; underscore-prefixed keys are never invoice data.
  delete candidate[RECIPIENT_KEY]
  const audit = auditRaw && typeof auditRaw === 'object' && !Array.isArray(auditRaw)
    ? auditRaw as CorrectionAudit
    : null
  const reasons = Array.isArray(reasonsRaw)
    ? (reasonsRaw as unknown[]).filter((r): r is string => typeof r === 'string')
    : []
  // Defensive: a pre-Part-2 row carries no classification, and a corrupt one is
  // treated as absent rather than trusted — a human can still set it explicitly.
  const c = classRaw as Partial<ClassificationResult> | null | undefined
  const classification = c && typeof c === 'object' && isDocTypeFull(c.documentType) && isAccountingCategory(c.accountingCategory)
    // §3.3 a pre-ITC stored row has no itc sibling; normalize it to the machine's
    // honest 'needs_review' rather than dropping the whole classification. A human
    // can still set the final value; the machine never claims 'eligible'.
    ? {
        ...(classRaw as ClassificationResult),
        itcEligibility: isItcEligibility(c.itcEligibility) ? (classRaw as ClassificationResult).itcEligibility : 'needs_review',
        itcReason: typeof c.itcReason === 'string'
          ? (classRaw as ClassificationResult).itcReason
          : 'input-tax-credit eligibility requires human confirmation',
      }
    : null
  return { candidate: candidate as LedgerCandidate, audit, reasons, classification }
}

/** Re-encode a canonical row, preserving its audit, current reason codes and classification. */
function encodeRow(row: LedgerRow, audit: CorrectionAudit | null, reasons: readonly string[], classification: ClassificationResult | null): string {
  const payload: StoredRecord = { ...row, [REASONS_KEY]: [...reasons] }
  if (classification) payload[CLASSIFICATION_KEY] = classification
  return audit ? JSON.stringify({ ...payload, [AUDIT_KEY]: audit }) : JSON.stringify(payload)
}

/**
 * A neutral baseline so a reviewer can confirm a classification on a row extracted
 * before Part 2 (which stored none). It never invents a type/category: both stay
 * 'unknown' until the human picks one, and the additive guard below then lifts.
 */
function baselineClassification(stored: ClassificationResult | null): ClassificationResult {
  return stored ?? {
    documentType: 'unknown', accountingCategory: 'unknown', method: 'rules',
    itcEligibility: 'needs_review', itcReason: 'no machine ITC determination stored for this row',
    confidence: 'low', evidence: ['no machine classification stored for this row'],
    needsReview: false, reviewReasons: [], originalInvoiceRef: null, version: CLASSIFICATION_VERSION,
  }
}

/**
 * Re-fold the deterministic classification review guard into a freshly re-scored
 * row. Like every other review gate here this is ADDITIVE ONLY: it can hold a row
 * in `needs_review` and add its reason codes, but it NEVER approves and NEVER
 * clears a reason the deterministic engine raised. Without it, a non-invoice
 * document (a receipt / payment voucher / challan / proforma) that extraction
 * forced to review would lose that reason on a later edit that re-derives reasons
 * from scratch and could be silently approved into the purchase register (§2.3).
 */
function foldClassificationGuard(
  review: 'approved' | 'needs_review',
  reasons: string[],
  classification: ClassificationResult | null,
): 'approved' | 'needs_review' {
  if (classification?.needsReview) {
    if (review === 'approved') review = 'needs_review'
    for (const r of classification.reviewReasons ?? []) {
      if (!reasons.includes(r)) reasons.push(r)
    }
  }
  return review
}

/** Append the reviewer's classification change to the correction audit, if any. */
function appendClassificationHistory(
  audit: CorrectionAudit | null,
  prior: ClassificationResult | null,
  next: ClassificationResult | null,
): CorrectionAudit | null {
  if (!next) return audit
  const now = new Date().toISOString()
  const added: CorrectionHistoryEntry[] = []
  if (prior?.documentType !== next.documentType) {
    added.push({ field: 'documentType', from: prior?.documentType ?? null, to: next.documentType, at: now, source: 'human' })
  }
  if (prior?.accountingCategory !== next.accountingCategory) {
    added.push({ field: 'accountingCategory', from: prior?.accountingCategory ?? null, to: next.accountingCategory, at: now, source: 'human' })
  }
  if (prior?.itcEligibility !== next.itcEligibility) {
    added.push({ field: 'itcEligibility', from: prior?.itcEligibility ?? null, to: next.itcEligibility, at: now, source: 'human' })
  }
  if (added.length === 0) return audit
  const base: CorrectionAudit = audit ?? { originalExtracted: null, history: [] }
  return { originalExtracted: base.originalExtracted, history: [...base.history, ...added].slice(-AUDIT_HISTORY_CAP) }
}

function scalarToString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

/**
 * §UX soft-only override: the ONLY reason families a human confirmation may clear.
 * `low-confidence` (measured OR the model's own `low-confidence:source:*`) is a
 * RELIABILITY signal, not a data-integrity failure. `tax-rate-advisory` is the same
 * rate/amount disagreement evaluateLedger raises ONLY when the invoice total ALREADY
 * ties out — the money reconciles, so it is a glance-at-the-rate hint, not a broken
 * bill. Every genuine integrity break (bad/missing GSTIN, unresolved/future date,
 * missing number/vendor, non-finite/negative/UNRECONCILED amounts, incoherent tax
 * structure, a HARD `tax-rate-mismatch` when the total does NOT tie, a non-invoice
 * document, a duplicate, a placeholder) is pushed as its OWN non-soft reason, so it
 * is NEVER classified soft here.
 */
function isSoftReviewReason(code: string): boolean {
  const base = code.split(':')[0]
  return base === 'low-confidence' || base === 'tax-rate-advisory'
}

/**
 * Fold this correction into the audit: keep the FIRST-ever extracted snapshot as
 * `originalExtracted`, and append one human entry per field whose effective value
 * actually changed. History is capped so a long edit session cannot bloat the row.
 */
function buildCorrectionAudit(
  prior: CorrectionAudit | null,
  existing: LedgerCandidate,
  corrections: LedgerCandidate,
): CorrectionAudit {
  const now = new Date().toISOString()
  const originalExtracted = prior?.originalExtracted ?? (existing as StoredRecord)
  const added: CorrectionHistoryEntry[] = []
  for (const key of Object.keys(corrections)) {
    if (key === 'confidence') continue
    const from = scalarToString((existing as StoredRecord)[key])
    const to = scalarToString((corrections as StoredRecord)[key])
    if (from === to) continue
    added.push({ field: key, from, to, at: now, source: 'human' })
  }
  return { originalExtracted, history: [...(prior?.history ?? []), ...added].slice(-AUDIT_HISTORY_CAP) }
}

export interface InvoiceReviewResult {
  review: 'approved' | 'needs_review'
  reasons: string[]
  confidence: number
  /** The batch the (approved + dated) invoice was folded into; null otherwise. */
  batchId: string | null
  /** The canonical row now stored for this invoice. */
  row: LedgerRow
}

/**
 * Apply a human review/correction to one invoice and, when it becomes a complete
 * and reliable row, approve it, file it into its correct (client, month) batch and
 * schedule the register workbook. When fields are still missing or the date is not
 * reliable it stays `needs_review` (never a guessed approval or a fabricated value).
 */
export async function applyInvoiceReview(
  db: Db,
  args: {
    workspaceId: string
    invoiceId: string
    /** Fields the reviewer confirmed/corrected. Empty/absent means "unchanged". */
    corrections: LedgerCandidate
    masterKeyHex: string
    /** Override the auto-approve bar (defaults to EXTRACTION_MIN_CONFIDENCE). */
    minConfidence?: number
    /**
     * §Part-2 a reviewer-confirmed classification (document type and/or accounting
     * category). Validated as enums by parseReviewCorrections; applied via
     * applyUserClassification so provenance becomes 'user' and the machine's
     * classification review guard lifts ONLY because a human answered the question.
     */
    classificationPatch?: ClassificationPatch
    /**
     * §bulk-approve: when true the invoice is still approved + filed into its
     * (client, month) batch, but the register rebuild is NOT scheduled here — the
     * caller defers a single coalesced enqueue until every row in the batch has
     * committed, so a bulk approve never builds a half-approved (partial) workbook.
     * Defaults to false; a single approve and the extraction path are unchanged.
     */
    deferRegister?: boolean
  },
): Promise<InvoiceReviewResult> {
  const { workspaceId, invoiceId, masterKeyHex } = args

  // Tenant-scoped invoice read; the client on this row is what scopes the batch.
  const { data: invData, error: invErr } = await db.from('invoices')
    .select('id,workspace_id,client_id,batch_id')
    .eq('workspace_id', workspaceId).eq('id', invoiceId).maybeSingle()
  if (invErr) throw new Error(`REVIEW_INVOICE_READ_ERROR: ${invErr.message}`)
  if (!invData) throw new Error('REVIEW_INVOICE_NOT_FOUND')
  const invoice = invData as { client_id: string | null; batch_id: string | null }

  // Load the previously extracted row (may not exist yet) so a blank correction
  // never silently discards a value the engine had already read correctly.
  const { data: rec, error: recReadErr } = await db.from('extracted_records')
    .select('encrypted_payload')
    .eq('workspace_id', workspaceId).eq('invoice_id', invoiceId).maybeSingle()
  if (recReadErr) throw new Error(`REVIEW_RECORD_READ_ERROR: ${recReadErr.message}`)
  const { candidate: existing, audit, classification: storedClassification } = splitAudit(
    rec ? decodeStoredRecord((rec as { encrypted_payload: unknown }).encrypted_payload, masterKeyHex) : null,
  )

  // Reviewer input is authoritative; the engine's already-valid fields only fill
  // what the reviewer left blank. evaluateLedger then scores the MERGE independently
  // so nothing is trusted blindly and no field is invented.
  const merged = mergeCandidates(args.corrections, existing)
  const env = getEnv()
  const minConfidence = args.minConfidence ?? env.EXTRACTION_MIN_CONFIDENCE
  const buyerGstin = await loadBuyerGstin(db, workspaceId, invoice.client_id)
  const evaluation = evaluateLedger(merged, {
    minConfidence,
    amountToleranceMinorUnits: env.EXTRACTION_AMOUNT_TOLERANCE_MINOR_UNITS,
    buyerGstin,
  })

  // A human approval must MEAN the reviewer confirmed the invoice's identity —
  // not that they clicked approve to slip past the confidence gate. The stored
  // row carries no AI self-confidence, so once origin is 'human' the low-
  // confidence flag disappears on its own; without this guard a bare/empty
  // submit would silently approve a value the reader was unsure about. We
  // therefore honor an 'approved' outcome ONLY when the reviewer's own
  // submitted corrections affirmatively carry the invoice number. The
  // deterministic re-score above still guards the numbers either way.
  const reviewerConfirmedInvoiceNumber =
    typeof args.corrections.invoice_number === 'string' && args.corrections.invoice_number.trim() !== ''
  let review = evaluation.review
  const reasons = [...evaluation.reasons]
  if (review === 'approved' && !reviewerConfirmedInvoiceNumber) {
    review = 'needs_review'
    reasons.push('review-confirmation-required')
  }

  // §Part-2 resolve the row's classification. A reviewer patch becomes the 'user'
  // result (and may lift the machine guard); otherwise the stored classification is
  // preserved unchanged. The additive guard is then re-folded so a non-invoice
  // document that a fresh re-score no longer names stays held for review until a
  // human confirms it. It can never approve a row the deterministic engine flagged.
  let nextClassification = storedClassification
  let nextAudit = audit
  if (args.classificationPatch) {
    nextClassification = applyUserClassification(
      baselineClassification(storedClassification), args.classificationPatch,
    )
    nextAudit = appendClassificationHistory(audit, storedClassification, nextClassification)
  }
  review = foldClassificationGuard(review, reasons, nextClassification)

  // §UX soft-only human override (operator-authorized). A person who explicitly
  // confirms an invoice may file a row whose ONLY blemish is the READER'S modest
  // self-confidence on an otherwise fully-valid bill. Because every objective check
  // (invalid/missing GSTIN, unresolved/future date, missing number or vendor, non-
  // finite/negative or unreconciled amounts, incoherent tax structure, a non-invoice
  // document) carries its OWN named reason, a row flagged ONLY by `low-confidence`
  // has necessarily passed them all — so clearing it files no bad GSTIN, no broken
  // math and no placeholder. This NEVER clears a hard reason: it only stops the AI's
  // own under-confidence from vetoing a bill a human has personally confirmed. It is
  // gated on the reviewer affirmatively confirming the invoice number (as approval
  // always is), so a bare/empty submit can never trigger it.
  if (
    review === 'needs_review'
    && reviewerConfirmedInvoiceNumber
    && reasons.length > 0
    && reasons.every(isSoftReviewReason)
  ) {
    review = 'approved'
  }

  const keyVersion = deriveKeyVersion(masterKeyHex)
  const payload = encryptExtractedPayload(encodeRow(evaluation.row, nextAudit, reasons, nextClassification), masterKeyHex)
  const { error: recWriteErr } = await db.from('extracted_records').upsert({
    workspace_id: workspaceId,
    invoice_id: invoiceId,
    encrypted_payload: `\\x${payload.toString('hex')}`,
    encryption_key_version: keyVersion,
    review_status: review,
    confidence_source: 'human',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'invoice_id' })
  if (recWriteErr) throw new Error(`REVIEW_RECORD_WRITE_ERROR: ${recWriteErr.message}`)

  // 'approved' is an extracted_records value, never an invoices lifecycle status:
  // a clean confirmed invoice becomes 'completed', an incomplete one 'needs_review'.
  const invoiceStatus = review === 'approved' ? 'completed' : 'needs_review'
  const { error: stErr } = await db.from('invoices').update({ status: invoiceStatus })
    .eq('workspace_id', workspaceId).eq('id', invoiceId)
  if (stErr) throw new Error(`REVIEW_INVOICE_STATUS_ERROR: ${stErr.message}`)

  // §3.5 re-evaluate the duplicate-review decision on completion. When a human
  // approves an invoice that carried a machine-'pending' duplicate flag, their
  // review IS the resolution act, so we best-effort mark that pair 'resolved'
  // (a terminal, human-handled audit state) — we NEVER claim confirmed_duplicate
  // or distinct here, those are judgements a dedicated resolve action owns. This
  // write is deliberately SEPARATE and FAIL-SOFT: until the additive
  // `duplicate_reviews` migration is applied it errors and is swallowed (logged),
  // exactly like the identity_key write, so the review above still commits and no
  // invoice is ever blocked. It never changes the review outcome or the register.
  if (review === 'approved') {
    try {
      const { error: drErr } = await db.from('duplicate_reviews')
        .update({ review_status: 'resolved', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
        .eq('incoming_invoice_id', invoiceId)
        .eq('review_status', 'pending')
      if (drErr) {
        logger.warn('[Review] duplicate_reviews resolve skipped (migration not applied?); decision record inactive', {
          invoiceId, code: drErr.code ?? 'unknown',
        })
      }
    } catch {
      // A missing table must never fail a completed review.
    }
  }

  let batchId: string | null = invoice.batch_id
  if (review === 'approved' && evaluation.invoiceDateResolved) {
    // Correct client + month from the CONFIRMED date; idempotent register enqueue
    // (suppressed when the caller coalesces a single rebuild after a bulk approve).
    batchId = await resolveInvoiceBatch(db, {
      workspaceId, invoiceId, row: evaluation.row, invoice,
      scheduleRegister: !args.deferRegister,
    })
  }

  return {
    review,
    reasons,
    confidence: evaluation.confidence,
    batchId,
    row: evaluation.row,
  }
}

// ---- shared field validation (single source for web/API AND WhatsApp) ------
export interface ReviewFieldError { field: string; code: string }

/** Upper bounds for reviewer-supplied text; over-length is a field error, never a silent truncate. */
const MAX_REVIEW_FIELD_LEN: Record<string, number> = {
  invoice_date: 40, invoice_number: 64, vendor_name: 200, supplier_gstin: 15,
}

/**
 * Parse a reviewer-supplied amount with the SAME decimal-safe, Indian-grouping,
 * currency-symbol-aware engine the extractor uses (moneyToMinorUnits). A bare
 * Number('1,23,456.78') is NaN and would silently discard a legitimate correction,
 * so "₹1,23,456.78" / "1,18,200/-" must parse here too. Returns null for
 * empty/invalid/non-finite input — never zero.
 */
function parseReviewMoney(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null
  const minor = moneyToMinorUnits(v)
  return minor === null ? null : minorUnitsToNumber(minor)
}

/**
 * Validate a reviewer's submitted corrections. This is the ONE implementation
 * shared by the HTTP review route and the WhatsApp numbered editor, so a
 * correction can never be accepted in one channel and rejected in the other.
 *   * Absent or blank fields mean "no change" — blanks never wipe a field.
 *   * A present-but-malformed field (wrong type, over length, an unparseable
 *     amount, a negative required amount) is returned as a field-specific error,
 *     never coerced to zero or lost silently (§7.2 / §5).
 * Date VALUE correctness is NOT re-implemented here; the shared date service in
 * evaluateLedger re-scores it and keeps the row in review if unresolved (§4).
 */
export function parseReviewCorrections(body: unknown): { corrections: LedgerCandidate; errors: ReviewFieldError[]; classification?: ClassificationPatch } {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const corrections: LedgerCandidate = {}
  const errors: ReviewFieldError[] = []
  const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')

  for (const f of ['invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin'] as const) {
    const v = src[f]
    if (!present(v)) continue
    if (typeof v !== 'string') { errors.push({ field: f, code: 'INVALID_TYPE' }); continue }
    const t = v.trim()
    if (t.length > MAX_REVIEW_FIELD_LEN[f]) { errors.push({ field: f, code: 'TOO_LONG' }); continue }
    corrections[f] = t
  }

  // Required amounts must be non-negative; optional reconciliation components
  // (round_off, netting discount/deduction) may legitimately be negative.
  const readAmount = (f: string, v: unknown, allowNegative: boolean) => {
    if (!present(v)) return
    const n = parseReviewMoney(v)
    if (n === null) { errors.push({ field: f, code: 'INVALID_AMOUNT' }); return }
    if (!allowNegative && n < 0) { errors.push({ field: f, code: 'NEGATIVE_NOT_ALLOWED' }); return }
    ;(corrections as Record<string, unknown>)[f] = n
  }
  for (const f of ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount'] as const) readAmount(f, src[f], false)
  for (const f of ['cess_amount', 'shipping_amount', 'discount_amount', 'deduction_amount', 'round_off'] as const) readAmount(f, src[f], true)

  // §Part-2 an optional reviewer-confirmed classification (document type and/or
  // accounting category). Validated against the STRICT enums here and never coerced:
  // an out-of-enum label is a field error the caller surfaces, so a malformed value
  // can never silently re-label a document. Absent/blank means "no change".
  let classification: ClassificationPatch | undefined
  const cls = src.classification
  if (cls && typeof cls === 'object' && !Array.isArray(cls)) {
    const c = cls as Record<string, unknown>
    if (present(c.documentType)) {
      if (!isDocTypeFull(c.documentType)) errors.push({ field: 'classification.documentType', code: 'INVALID_ENUM' })
      else classification = { ...classification, documentType: c.documentType }
    }
    if (present(c.accountingCategory)) {
      if (!isAccountingCategory(c.accountingCategory)) errors.push({ field: 'classification.accountingCategory', code: 'INVALID_ENUM' })
      else classification = { ...classification, accountingCategory: c.accountingCategory }
    }
    // §3.3 ITC eligibility is a human-settable dimension; validated against the strict
    // enum and never coerced. This is the ONLY channel that may promote it to 'eligible'.
    if (present(c.itcEligibility)) {
      if (!isItcEligibility(c.itcEligibility)) errors.push({ field: 'classification.itcEligibility', code: 'INVALID_ENUM' })
      else classification = { ...classification, itcEligibility: c.itcEligibility }
    }
  }

  return { corrections, errors, classification }
}

export interface InvoiceCorrectionResult {
  /** The RE-SCORED review state of the corrected row (never an approval action). */
  review: 'approved' | 'needs_review'
  reasons: string[]
  confidence: number
  row: LedgerRow
  /** True when the corrected row is fully valid AND dated — i.e. APPROVE would file it. */
  approvable: boolean
  /** §Part-2 the row's classification after this edit (preserved or user-confirmed). */
  classification: ClassificationResult | null
}

/**
 * Apply one reviewer field CORRECTION and re-validate — but do NOT approve or
 * export. §7 is explicit that correcting extraction is distinct from approving an
 * invoice for export: this persists the corrected row (encrypted, immediately and
 * reliably) plus its correction history, keeps the invoice in `needs_review`, and
 * NEVER touches the lifecycle status or folds it into a batch. Only a separate,
 * explicit APPROVE (applyInvoiceReview) flips it to completed + schedules the
 * register — so editing a single field can never silently auto-approve.
 *
 * Tenant isolation is enforced by the caller's workspace_id on every read/write.
 */
export async function applyInvoiceCorrection(
  db: Db,
  args: {
    workspaceId: string
    invoiceId: string
    /** Already-validated field corrections (see parseReviewCorrections). */
    corrections: LedgerCandidate
    masterKeyHex: string
    /** §Part-2 an optional reviewer-confirmed classification (validated as enums). */
    classificationPatch?: ClassificationPatch
  },
): Promise<InvoiceCorrectionResult> {
  const { workspaceId, invoiceId, masterKeyHex } = args

  const { data: invData, error: invErr } = await db.from('invoices')
    .select('id,client_id')
    .eq('workspace_id', workspaceId).eq('id', invoiceId).maybeSingle()
  if (invErr) throw new Error(`CORRECTION_INVOICE_READ_ERROR: ${invErr.message}`)
  if (!invData) throw new Error('CORRECTION_INVOICE_NOT_FOUND')
  const correctionInvoice = invData as { client_id: string | null }

  const { data: rec, error: recReadErr } = await db.from('extracted_records')
    .select('encrypted_payload')
    .eq('workspace_id', workspaceId).eq('invoice_id', invoiceId).maybeSingle()
  if (recReadErr) throw new Error(`CORRECTION_RECORD_READ_ERROR: ${recReadErr.message}`)
  const { candidate: existing, audit: priorAudit, classification: storedClassification } = splitAudit(
    rec ? decodeStoredRecord((rec as { encrypted_payload: unknown }).encrypted_payload, masterKeyHex) : null,
  )

  // Reviewer input is authoritative; the engine's already-valid fields fill only
  // what the correction left blank. Re-evaluate the MERGE independently so nothing
  // is trusted blindly and no field is invented (same engine as every other path).
  const merged = mergeCandidates(args.corrections, existing)
  const env = getEnv()
  const buyerGstin = await loadBuyerGstin(db, workspaceId, correctionInvoice.client_id)
  const evaluation = evaluateLedger(merged, {
    minConfidence: env.EXTRACTION_MIN_CONFIDENCE,
    amountToleranceMinorUnits: env.EXTRACTION_AMOUNT_TOLERANCE_MINOR_UNITS,
    buyerGstin,
  })

  const audit = buildCorrectionAudit(priorAudit, existing, args.corrections)

  // §Part-2 preserve (or, when supplied, apply) the row's classification and
  // re-fold its ADDITIVE review guard, so editing a field on a non-invoice
  // document can never clear the reason that keeps it out of the register. Only a
  // reviewer-confirmed classification lifts it, and only because a human answered.
  let nextClassification = storedClassification
  let nextAudit = audit
  if (args.classificationPatch) {
    nextClassification = applyUserClassification(
      baselineClassification(storedClassification), args.classificationPatch,
    )
    nextAudit = appendClassificationHistory(audit, storedClassification, nextClassification) ?? audit
  }
  const review = foldClassificationGuard(evaluation.review, evaluation.reasons, nextClassification)

  const keyVersion = deriveKeyVersion(masterKeyHex)
  const payload = encryptExtractedPayload(encodeRow(evaluation.row, nextAudit, evaluation.reasons, nextClassification), masterKeyHex)
  // review_status stays 'needs_review' on this path: a correction is not an
  // approval. This keeps the invoice discoverable in the pending list so the
  // reviewer can still APPROVE (or keep correcting) it.
  const { error: recWriteErr } = await db.from('extracted_records').upsert({
    workspace_id: workspaceId,
    invoice_id: invoiceId,
    encrypted_payload: `\\x${payload.toString('hex')}`,
    encryption_key_version: keyVersion,
    review_status: 'needs_review',
    confidence_source: 'human',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'invoice_id' })
  if (recWriteErr) throw new Error(`CORRECTION_RECORD_WRITE_ERROR: ${recWriteErr.message}`)

  return {
    review,
    reasons: evaluation.reasons,
    confidence: evaluation.confidence,
    row: evaluation.row,
    approvable: review === 'approved' && evaluation.invoiceDateResolved,
    classification: nextClassification,
  }
}
