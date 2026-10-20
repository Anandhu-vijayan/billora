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
import { encryptExtractedPayload, decryptExtractedPayload } from '@/lib/encryption'
import { deriveKeyVersion } from '@/lib/encryption/files'
import { evaluateLedger, mergeCandidates, type LedgerCandidate, type LedgerRow } from '@/lib/ocr/ledger'
import { resolveInvoiceBatch } from '@/lib/invoices/batch'

type Db = SupabaseClient

/** PostgREST renders bytea as a `\x`-prefixed hex string (same as intake/register). */
function byteaToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/i, ''), 'hex')
  throw new Error('BYTEA_DECODE_ERROR: unexpected encrypted_payload encoding')
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
  let existing: LedgerCandidate = {}
  if (rec) {
    try {
      const plain = decryptExtractedPayload(byteaToBuffer((rec as { encrypted_payload: unknown }).encrypted_payload), masterKeyHex)
      existing = JSON.parse(plain) as LedgerCandidate
    } catch {
      // A corrupt stored payload is treated as "no prior value" — we never let a
      // damaged row silently suppress the reviewer's corrections.
      existing = {}
    }
  }

  // Reviewer input is authoritative; the engine's already-valid fields only fill
  // what the reviewer left blank. evaluateLedger then scores the MERGE independently
  // so nothing is trusted blindly and no field is invented.
  const merged = mergeCandidates(args.corrections, existing)
  const env = getEnv()
  const minConfidence = args.minConfidence ?? env.EXTRACTION_MIN_CONFIDENCE
  const evaluation = evaluateLedger(merged, {
    minConfidence,
    amountToleranceMinorUnits: env.EXTRACTION_AMOUNT_TOLERANCE_MINOR_UNITS,
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
  const payload = encryptExtractedPayload(JSON.stringify(evaluation.row), masterKeyHex)
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
