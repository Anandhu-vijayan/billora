// lib/jobs/handlers/extract-invoice.ts — invoice_extraction job handler.
//
// Turns one stored, envelope-encrypted invoice file into a validated ledger row
// (image/PDF -> data -> review routing) and folds the invoice into its real
// (workspace, client, month) batch whenever a reliable invoice date was parsed —
// for BOTH approved and needs_review invoices — then, when the batch has no other
// outstanding extraction work, schedules the register workbook.
//
// Guarantees this file is responsible for:
//   * Idempotent (rule 3): an already-approved invoice completes without redoing
//     provider work. Everything keyed by invoice_id, which is the job target.
//   * Fail-closed on crypto: a tampered/expired container is a PermanentJobError
//     (decrypt throws), never a silent pass. Plaintext never touches disk.
//   * Cross-tenant isolation (Stage-3 safety): every read/write is scoped by the
//     job's own workspace_id; a job can never touch another tenant's rows.
//   * Never fabricate: review routing lives in lib/ocr/ledger.ts — a missing or
//     ambiguous date/anomaly/GSTIN lands in needs_review, not a guessed value.
import { getEnv } from '@/lib/env'
import { bucketFor } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { PermanentJobError } from '@/lib/jobs/queue'
import type { JobContext } from '@/lib/jobs/worker'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  decryptFile, deriveKeyVersion, isMediaDecryptFailure, resolveFileKeyConfig,
} from '@/lib/encryption/files'
import { encryptExtractedPayload } from '@/lib/encryption'
import { evaluateLedger } from '@/lib/ocr/ledger'
import { resolveInvoiceBatch } from '@/lib/invoices/batch'
import { updateSessionDeliveryState } from '@/lib/whatsapp/sessions'
import {
  extractInvoice as runExtraction,
  InvoiceExtractionError,
  type ExtractionSource,
  type InvoiceExtractionResult,
} from '@/lib/ocr/invoice-extractor'

interface InvoiceRow {
  id: string
  workspace_id: string
  client_id: string | null
  batch_id: string | null
  file_object_path: string | null
  content_type: string | null
  file_encryption_key_version: string | null
  status: string
  received_at: string
}

type Db = SupabaseClient

export async function extractInvoice(ctx: JobContext): Promise<void> {
  const { db, job, assertLease } = ctx
  if (!job.invoice_id) throw new PermanentJobError('EXTRACT_MISSING_TARGET: invoice job without invoice_id')
  const invoiceId = job.invoice_id
  const workspaceId = job.workspace_id

  // Idempotent short-circuit: an already-approved record means the work is done;
  // re-affirm invoice completion + batch scheduling and finish without re-calling
  // the provider (never burn Gemini quota on a retry/duplicate claim).
  const { data: existing } = await db
    .from('extracted_records')
    .select('review_status')
    .eq('workspace_id', workspaceId).eq('invoice_id', invoiceId).maybeSingle()
  if (existing && existing.review_status === 'approved') {
    await resolveInvoiceBatch(db, { workspaceId, invoiceId, jobId: job.id, assertLease })
    logger.info('[Extract] already approved; skipping provider call', { invoiceId, jobId: job.id })
    return
  }

  // Load the invoice scoped to this job's workspace (tenant isolation).
  const { data: invoiceData, error: invErr } = await db
    .from('invoices')
    .select('id,workspace_id,client_id,batch_id,file_object_path,content_type,file_encryption_key_version,status,received_at')
    .eq('workspace_id', workspaceId).eq('id', invoiceId).maybeSingle()
  if (invErr) throw new Error(`INVOICE_READ_ERROR: ${invErr.message}`)
  const invoice = invoiceData as InvoiceRow | undefined
  if (!invoice) throw new PermanentJobError('INVOICE_NOT_FOUND')
  if (!invoice.file_object_path || !invoice.content_type) {
    throw new PermanentJobError('INVOICE_INCOMPLETE: no stored object/content type')
  }

  const { masterKeyHex } = resolveFileKeyConfig()

  // Download the encrypted container and decrypt it IN MEMORY only.
  const { data: blob, error: dlErr } = await db.storage.from(bucketFor('invoices'))
    .download(invoice.file_object_path)
  if (dlErr || !blob) throw new Error(`MEDIA_DOWNLOAD_ERROR: ${dlErr?.message ?? 'empty'}`)
  const container = Buffer.from(await blob.arrayBuffer())

  let plain: Buffer
  try {
    plain = decryptFile(container, masterKeyHex, {
      context: invoice.file_object_path,
      expectedKeyVersion: invoice.file_encryption_key_version ?? undefined,
    })
  } catch (e) {
    // A corrupt/tampered/expired container can never succeed on retry.
    if (isMediaDecryptFailure(e)) throw new PermanentJobError(`MEDIA_DECRYPT_FAILED: ${(e as Error).message}`)
    throw e
  }

  // Extraction now runs through the dedicated OCR engine (lib/ocr/invoice-extractor):
  // sharp + tesseract.js for images, a PDF text layer / bounded rendered-page OCR
  // for PDFs, and an optional privacy-GATED Gemini vision fallback. The handler
  // keeps ownership of decryption, encryption-at-rest, tenant-scoped writes,
  // review routing, batch scheduling and the in-memory wipe. Nothing is fabricated.
  const env = getEnv()
  try {
    // AI stays strictly behind the operator gate and is NEVER default-on: the
    // engine only reaches Gemini when allowAI is true AND a paid tier is set.
    const allowAI = env.EXTRACTION_ALLOW_AI === true && env.EXTRACTION_AI_TIER === 'paid'
    if (allowAI && env.EXTRACTION_PROVIDER !== 'gemini') {
      throw new PermanentJobError(`PROVIDER_UNIMPLEMENTED: ${env.EXTRACTION_PROVIDER}`)
    }

    // The engine returns a raw candidate + provenance. A permanent failure (bad
    // media, unsupported type) never spins retries; a transient OCR/vision fault does.
    const result: InvoiceExtractionResult = await runExtraction({
      buffer: plain,
      mimeType: invoice.content_type,
      minConfidence: env.EXTRACTION_MIN_CONFIDENCE,
      amountToleranceMinorUnits: env.EXTRACTION_AMOUNT_TOLERANCE_MINOR_UNITS,
      allowAI,
      apiKey: allowAI ? (env.GEMINI_API_KEY || '') : undefined,
      model: env.EXTRACTION_VISION_MODEL || env.GEMINI_MODEL,
    }).catch((e: unknown): never => {
      if (e instanceof InvoiceExtractionError) {
        if (!e.retryable) throw new PermanentJobError(`EXTRACTION_FAILED: ${e.message}`)
        throw e // transient OCR / vision fault -> the worker requeues
      }
      throw e
    })

    // Re-evaluate the returned candidate independently so the handler owns the
    // canonical row and the date-resolved batching gate (the engine never returns
    // a canonicalised ledger row, only the fields it located).
    const evaluation = evaluateLedger(result.candidate, {
      minConfidence: env.EXTRACTION_MIN_CONFIDENCE,
      amountToleranceMinorUnits: env.EXTRACTION_AMOUNT_TOLERANCE_MINOR_UNITS,
    })
    const confidenceSource: ExtractionSource = result.source

    // Say WHY nothing could read the file: a silent empty review row was previously
    // indistinguishable from a model failure in the logs.
    if (confidenceSource === 'human' && evaluation.review === 'needs_review') {
      logger.warn('[Extract] no extractor available: local OCR missed and AI is gated off', {
        invoiceId, jobId: job.id,
        mime: invoice.content_type,
        aiGate: env.EXTRACTION_ALLOW_AI !== true ? 'EXTRACTION_ALLOW_AI is not true' : 'EXTRACTION_AI_TIER is not paid',
        reasons: evaluation.reasons.slice(0, 4),
      })
    }

    const keyVersion = deriveKeyVersion(masterKeyHex)
    const payload = encryptExtractedPayload(JSON.stringify(evaluation.row), masterKeyHex)

    await assertLease()
    const { error: recErr } = await db.from('extracted_records').upsert({
      workspace_id: workspaceId,
      invoice_id: invoiceId,
      encrypted_payload: `\\x${payload.toString('hex')}`,
      encryption_key_version: keyVersion,
      review_status: evaluation.review,
      confidence_source: confidenceSource,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'invoice_id' })
    if (recErr) throw new Error(`RECORD_WRITE_ERROR: ${recErr.message}`)
    logger.info('[Extract] result saved', {
      invoiceId, jobId: job.id, review: evaluation.review,
      source: confidenceSource, confidence: evaluation.confidence,
      presentFieldNames: [
        'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
        'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
      ].filter((field) => {
        const value = result.candidate[field as keyof typeof result.candidate]
        return value !== undefined && value !== null && value !== ''
      }),
      reasonCodes: evaluation.reasons.slice(0, 8),
    })

    // Route the invoice status. The invoices.status CHECK allows 'completed' but
    // NOT 'approved' ('approved' is an extracted_records.review_status value, not
    // an invoice lifecycle state), so a clean extraction lands as 'completed' and
    // anything unresolved as 'needs_review'.
    const invoiceStatus = evaluation.review === 'approved' ? 'completed' : 'needs_review'
    await assertLease()
    const { error: stErr } = await db.from('invoices').update({ status: invoiceStatus })
      .eq('workspace_id', workspaceId).eq('id', invoiceId)
    if (stErr) throw new Error(`INVOICE_STATUS_ERROR: ${stErr.message}`)

    // Batch + register scheduling is NOT restricted to approved invoices: a
    // needs_review invoice with a reliably parsed date still belongs in its real
    // (client, month) batch so the register can account for outstanding review
    // items. When the date is missing/ambiguous we NEVER guess the upload month —
    // the invoice stays unbatched and visible in the review workflow instead.
    if (evaluation.invoiceDateResolved) {
      const batchId = await resolveInvoiceBatch(db, {
        workspaceId, invoiceId, jobId: job.id, row: evaluation.row, invoice, assertLease,
      })
      logger.info('[Extract] batch assignment complete', { invoiceId, jobId: job.id, batchId })
    } else {
      logger.info('[Extract] no reliable invoice date; left unbatched for review', {
        invoiceId, jobId: job.id, reasonCodes: evaluation.reasons.slice(0, 8),
      })
    }
    if (evaluation.review === 'needs_review') {
      await queueReviewNotice(db, workspaceId, job.id, invoiceId, assertLease)
    }
    logger.info('[Extract] complete', {
      invoiceId, jobId: job.id, review: evaluation.review,
      source: confidenceSource, reasonCodes: evaluation.reasons.slice(0, 8),
      mimeType: invoice.content_type, pagesProcessed: result.pagesProcessed,
    })
  } finally {
    plain.fill(0) // wipe plaintext bytes on every exit path (approve, review, throw)
  }
}

async function queueReviewNotice(
  db: Db,
  workspaceId: string,
  jobId: string,
  invoiceId: string,
  assertLease: () => Promise<void>,
): Promise<void> {
  const { data, error } = await db.from('whatsapp_identities').select('sender_hmac')
    .eq('workspace_id', workspaceId).limit(1)
  if (error) {
    logger.warn('[Extract] review notice deferred: sender lookup failed', { invoiceId, jobId, code: error.code ?? null })
    return
  }
  const senderHmac = (data?.[0]?.sender_hmac as string | undefined) ?? null
  if (!senderHmac) {
    logger.info('[Extract] review notice unavailable: no WhatsApp sender linked', { invoiceId, jobId })
    return
  }
  await assertLease()
  const queued = await updateSessionDeliveryState(db, senderHmac, {
    pending_reply_body: 'One or more invoices need review and are not included in an Excel register until corrected. Reply Review or choose Menu > Review to see what needs attention.',
    last_reply_error_code: null,
  })
  logger.info(queued
    ? '[Extract] review notice queued for next inbound message'
    : '[Extract] review notice deferred: delivery state could not be saved', { invoiceId, jobId })
}

