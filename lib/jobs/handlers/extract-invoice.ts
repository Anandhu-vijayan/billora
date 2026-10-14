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
import {
  decryptFile, deriveKeyVersion, isMediaDecryptFailure, resolveFileKeyConfig,
} from '@/lib/encryption/files'
import { encryptExtractedPayload } from '@/lib/encryption'
import { extractInvoiceFields, VisionTransientError } from '@/lib/ocr/vision'
import { tryLocalExtract } from '@/lib/ocr/local'
import { renderFirstPageToPng } from '@/lib/ocr/pdf'
import { evaluateLedger, mergeCandidates, type LedgerCandidate } from '@/lib/ocr/ledger'
import { resolveInvoiceBatch } from '@/lib/invoices/batch'

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

export async function extractInvoice(ctx: JobContext): Promise<void> {
  const { db, job } = ctx
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
    await resolveInvoiceBatch(db, { workspaceId, invoiceId, jobId: job.id })
    logger.info('[Extract] already approved; skipping provider call', { invoice: invoiceId.slice(0, 8) })
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

  // Extraction is LOCAL-FIRST with a privacy-GATED AI fallback. The decrypted
  // bytes live in memory only and are wiped in `finally`; plaintext is never
  // persisted and nothing is ever fabricated.
  const env = getEnv()
  try {
    // 1) Try a configured/registered LOCAL engine (PDF text / OCR). When there
    //    is no local engine — or the input is an image/scan it cannot process —
    //    tryLocalExtract returns a miss (never a made-up candidate).
    const local = await tryLocalExtract({ buffer: plain, mimeType: invoice.content_type })
    let candidate: LedgerCandidate | null = local.ok ? local.candidate : null
    let confidenceSource: 'local' | 'ai' | 'human' = local.ok ? 'local' : 'human'

    // 2) Independently evaluate whatever local produced. evaluateLedger measures
    //    confidence from objective checks — it never trusts a source's own number.
    let evaluation = candidate
      ? evaluateLedger(candidate, { minConfidence: env.EXTRACTION_MIN_CONFIDENCE })
      : null

    // 3) AI fallback ONLY when the operator explicitly enabled it AND confirmed
    //    a paid tier. When AI is disabled we NEVER silently send decrypted
    //    invoice content to a provider; unresolved input stays for human review.
    const aiEnabled = env.EXTRACTION_ALLOW_AI === true && env.EXTRACTION_AI_TIER === 'paid'
    const needsFallback = evaluation === null || evaluation.review === 'needs_review'
    if (aiEnabled && needsFallback) {
      if (env.EXTRACTION_PROVIDER !== 'gemini') {
        throw new PermanentJobError(`PROVIDER_UNIMPLEMENTED: ${env.EXTRACTION_PROVIDER}`)
      }
      const model = env.EXTRACTION_VISION_MODEL || env.GEMINI_MODEL
      // HYBRID media selection: a PDF reaches Gemini as a REAL rendered FIRST
      // PAGE (never every page), so a scanned/ambiguous document is seen as a
      // genuine rasterized image. Bare images go as-is. If no canvas is
      // available we fall back to the original PDF bytes (Gemini accepts PDFs)
      // rather than silently skipping — but we never fabricate a result.
      const isPdf = /^application\/pdf$/i.test(invoice.content_type ?? '')
      let aiBuffer: Buffer = plain
      let aiMime = invoice.content_type ?? 'application/pdf'
      if (isPdf) {
        const png = await renderFirstPageToPng(plain)
        if (png) { aiBuffer = png; aiMime = 'image/png' }
      }
      let aiCandidate: LedgerCandidate
      try {
        aiCandidate = await extractInvoiceFields({
          buffer: aiBuffer, mimeType: aiMime, apiKey: env.GEMINI_API_KEY || '', model,
        })
      } catch (e) {
        if (e instanceof VisionTransientError) throw e // -> retryable backoff
        throw new PermanentJobError(`VISION_FAILED: ${e instanceof Error ? e.message : String(e)}`)
      }
      // AI only ASSISTS the local parser: every locally-valid field is kept and
      // AI merely fills what local missed. The merged row is then re-evaluated
      // independently, so no source is ever blindly trusted.
      const assisted = candidate ? mergeCandidates(candidate, aiCandidate) : aiCandidate
      const aiEval = evaluateLedger(assisted, { minConfidence: env.EXTRACTION_MIN_CONFIDENCE })
      // Adopt only when the merge strictly improves the outcome; a valid local
      // approval is never downgraded or overruled by the AI result.
      if (!evaluation || aiEval.review === 'approved' || aiEval.confidence > evaluation.confidence) {
        candidate = assisted
        evaluation = aiEval
        confidenceSource = 'ai'
      }
    }

    // 4) No engine and AI disabled -> a review-only placeholder (empty values,
    //    never invented) so the invoice deterministically lands in needs_review.
    if (!evaluation) {
      evaluation = evaluateLedger({}, { minConfidence: Number.NEGATIVE_INFINITY })
      confidenceSource = 'human'
    }

    const keyVersion = deriveKeyVersion(masterKeyHex)
    const payload = encryptExtractedPayload(JSON.stringify(evaluation.row), masterKeyHex)

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

    // Route the invoice status. The invoices.status CHECK allows 'completed' but
    // NOT 'approved' ('approved' is an extracted_records.review_status value, not
    // an invoice lifecycle state), so a clean extraction lands as 'completed' and
    // anything unresolved as 'needs_review'.
    const invoiceStatus = evaluation.review === 'approved' ? 'completed' : 'needs_review'
    const { error: stErr } = await db.from('invoices').update({ status: invoiceStatus })
      .eq('workspace_id', workspaceId).eq('id', invoiceId)
    if (stErr) throw new Error(`INVOICE_STATUS_ERROR: ${stErr.message}`)

    // Batch + register scheduling is NOT restricted to approved invoices: a
    // needs_review invoice with a reliably parsed date still belongs in its real
    // (client, month) batch so the register can account for outstanding review
    // items. When the date is missing/ambiguous we NEVER guess the upload month —
    // the invoice stays unbatched and visible in the review workflow instead.
    if (evaluation.invoiceDateResolved) {
      await resolveInvoiceBatch(db, { workspaceId, invoiceId, jobId: job.id, row: evaluation.row, invoice })
    } else {
      logger.info('[Extract] no reliable invoice date; left unbatched for review', {
        invoice: invoiceId.slice(0, 8), reasons: evaluation.reasons.slice(0, 4),
      })
    }
    logger.info('[Extract] done', {
      invoice: invoiceId.slice(0, 8), review: evaluation.review,
      source: confidenceSource, reasons: evaluation.reasons.slice(0, 4),
    })
  } finally {
    plain.fill(0) // wipe plaintext bytes on every exit path (approve, review, throw)
  }
}

