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
const AUDIT_HISTORY_CAP = 50

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

/** Split a stored record into the field candidate, its audit and its reason codes. */
function splitAudit(record: StoredRecord | null): { candidate: LedgerCandidate; audit: CorrectionAudit | null; reasons: string[] } {
  if (!record) return { candidate: {}, audit: null, reasons: [] }
  const { [AUDIT_KEY]: auditRaw, [REASONS_KEY]: reasonsRaw, ...candidate } = record
  // Drop the informational recipient sibling (§P0-1c) so a review merge can never
  // read it back as a candidate field; underscore-prefixed keys are never invoice data.
  delete candidate[RECIPIENT_KEY]
  const audit = auditRaw && typeof auditRaw === 'object' && !Array.isArray(auditRaw)
    ? auditRaw as CorrectionAudit
    : null
  const reasons = Array.isArray(reasonsRaw)
    ? (reasonsRaw as unknown[]).filter((r): r is string => typeof r === 'string')
    : []
  return { candidate: candidate as LedgerCandidate, audit, reasons }
}

/** Re-encode a canonical row, preserving its audit and current reason codes. */
function encodeRow(row: LedgerRow, audit: CorrectionAudit | null, reasons: readonly string[]): string {
  const payload: StoredRecord = { ...row, [REASONS_KEY]: [...reasons] }
  return audit ? JSON.stringify({ ...payload, [AUDIT_KEY]: audit }) : JSON.stringify(payload)
}

function scalarToString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
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
  const { candidate: existing, audit } = splitAudit(
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

  const keyVersion = deriveKeyVersion(masterKeyHex)
  const payload = encryptExtractedPayload(encodeRow(evaluation.row, audit, reasons), masterKeyHex)
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

  let batchId: string | null = invoice.batch_id
  if (review === 'approved' && evaluation.invoiceDateResolved) {
    // Correct client + month from the CONFIRMED date; idempotent register enqueue.
    batchId = await resolveInvoiceBatch(db, {
      workspaceId, invoiceId, row: evaluation.row, invoice,
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
export function parseReviewCorrections(body: unknown): { corrections: LedgerCandidate; errors: ReviewFieldError[] } {
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

  return { corrections, errors }
}

export interface InvoiceCorrectionResult {
  /** The RE-SCORED review state of the corrected row (never an approval action). */
  review: 'approved' | 'needs_review'
  reasons: string[]
  confidence: number
  row: LedgerRow
  /** True when the corrected row is fully valid AND dated — i.e. APPROVE would file it. */
  approvable: boolean
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
  const { candidate: existing, audit: priorAudit } = splitAudit(
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
  const keyVersion = deriveKeyVersion(masterKeyHex)
  const payload = encryptExtractedPayload(encodeRow(evaluation.row, audit, evaluation.reasons), masterKeyHex)
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
    review: evaluation.review,
    reasons: evaluation.reasons,
    confidence: evaluation.confidence,
    row: evaluation.row,
    approvable: evaluation.review === 'approved' && evaluation.invoiceDateResolved,
  }
}
