// lib/jobs/handlers/extract-invoice.ts — invoice_extraction job handler.
//
// Turns one stored, envelope-encrypted invoice file into a validated ledger row
// (image/PDF -> data -> review routing) and, on approval, folds the invoice into
// its (workspace, client, month) batch and — when the batch has no other
// outstanding extraction work — schedules the register workbook.
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
import type { SupabaseClient } from '@supabase/supabase-js'
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
import { evaluateLedger, mergeCandidates, type LedgerCandidate, type LedgerRow } from '@/lib/ocr/ledger'

type Db = SupabaseClient

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

const monthBounds = (dateIso: string): { start: string; end: string } => {
  const [y, m] = dateIso.split('-').map(Number)
  const year = y ?? 1970
  const month = m ?? 1
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { start, end }
}

/** First day of the month for a timestamp (used when no valid invoice date). */
const monthOfTimestamp = (ts: string): string => ts.slice(0, 10)

/**
 * Schedule the batch's register workbook job. Scheduling is UNCONDITIONAL and
 * deduped (the partial unique index keeps at most one live register job per
 * batch), which avoids a multi-worker race: gating the enqueue on "no sibling
 * still processing" can deadlock when two extractions finish concurrently and
 * each observes the other as still in flight, so neither ever schedules.
 * Readiness ("build only once the batch quiesces") is enforced instead in
 * build_register, which requeues while any sibling extraction is outstanding.
 * We free the dedup slot of any terminal register row so a later re-run can
 * re-enqueue; a concurrent 23505 is a benign no-op (a live job already exists).
 */
async function enqueueRegisterGeneration(db: Db, workspaceId: string, batchId: string): Promise<void> {
  await db.from('processing_jobs')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('batch_id', batchId)
    .eq('job_type', 'register_generation')
    .in('status', ['completed', 'failed'])
  const { data: live } = await db
    .from('processing_jobs').select('id')
    .eq('workspace_id', workspaceId).eq('batch_id', batchId)
    .eq('job_type', 'register_generation').in('status', ['queued', 'processing'])
    .limit(1)
  if ((live ?? []).length > 0) return
  // A generous attempt budget: readiness requeues are expected while siblings
  // are still extracting, and must not exhaust into a settled-failed register.
  const { error } = await db.from('processing_jobs').insert({
    workspace_id: workspaceId, batch_id: batchId, invoice_id: null,
    job_type: 'register_generation', status: 'queued', max_attempts: 12,
  })
  // 23505 = another worker just scheduled the same batch: exactly what we want.
  if (error && error.code !== '23505') throw new Error(`REGISTER_ENQUEUE_ERROR: ${error.message}`)
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
    await finalizeApproved(db, { workspaceId, invoiceId, jobId: job.id })
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

    // Route the invoice status: approved -> completed, else needs_review.
    const { error: stErr } = await db.from('invoices').update({ status: evaluation.review })
      .eq('workspace_id', workspaceId).eq('id', invoiceId)
    if (stErr) throw new Error(`INVOICE_STATUS_ERROR: ${stErr.message}`)

    if (evaluation.review === 'approved') {
      await finalizeApproved(db, { workspaceId, invoiceId, jobId: job.id }, evaluation.row, invoice)
    }
    logger.info('[Extract] done', {
      invoice: invoiceId.slice(0, 8), review: evaluation.review,
      source: confidenceSource, reasons: evaluation.reasons.slice(0, 4),
    })
  } finally {
    plain.fill(0) // wipe plaintext bytes on every exit path (approve, review, throw)
  }
}

/**
 * Common tail for approved invoices (fresh or replayed): stamp the batch and
 * ensure a register job is scheduled for it. Safe to call more than once (all
 * steps are idempotent and the register enqueue is deduped).
 */
async function finalizeApproved(
  db: Db,
  args: { workspaceId: string; invoiceId: string; jobId: string },
  row?: LedgerRow, invoice?: InvoiceRow,
): Promise<void> {
  if (!invoice) {
    // Replay path: we need the client + a date source to resolve the batch.
    const { data } = await db.from('invoices')
      .select('id,workspace_id,client_id,batch_id,file_object_path,content_type,file_encryption_key_version,status,received_at')
      .eq('workspace_id', args.workspaceId).eq('id', args.invoiceId).maybeSingle()
    invoice = data as InvoiceRow | undefined
  }
  if (!invoice) return
  const periodDate = (row && row.invoice_date && /^\d{4}-\d{2}-\d{2}$/.test(row.invoice_date))
    ? row.invoice_date
    : monthOfTimestamp(invoice.received_at)

  const { start, end } = monthBounds(periodDate)
  const { data: batch, error: batchError } = await db.rpc('ensure_invoice_batch', {
    p_workspace: args.workspaceId, p_client: invoice.client_id, p_start: start, p_end: end,
  })
  if (batchError || !batch) throw new Error(`BATCH_ENSURE_ERROR: ${batchError?.message ?? 'no batch id'}`)
  const batchId = String(batch)
  if (invoice.batch_id !== batchId) {
    await db.from('invoices').update({ batch_id: batchId })
      .eq('workspace_id', args.workspaceId).eq('id', args.invoiceId)
  }

  // Ensure the batch has a (deduped) register job scheduled. Readiness is
  // re-checked in build_register, so unconditional scheduling here is safe.
  await enqueueRegisterGeneration(db, args.workspaceId, batchId)
}
