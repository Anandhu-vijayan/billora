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
import { StageTimer } from '@/lib/jobs/timing'
import { PermanentJobError } from '@/lib/jobs/queue'
import type { JobContext } from '@/lib/jobs/worker'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  decryptFile, deriveKeyVersion, isMediaDecryptFailure, resolveFileKeyConfig,
} from '@/lib/encryption/files'
import { encryptExtractedPayload } from '@/lib/encryption'
import { evaluateLedger } from '@/lib/ocr/ledger'
import { classifyDocument, headingRegion } from '@/lib/ocr/classify'
import { resolveInvoiceBatch } from '@/lib/invoices/batch'
import {
  computeIdentityKey, identityKeyToBytea, DUPLICATE_IDENTITY_REASON,
} from '@/lib/invoices/dedup'
import { updateSessionDeliveryState } from '@/lib/whatsapp/sessions'
import {
  extractInvoice as runExtraction,
  InvoiceExtractionError,
  type ExtractionSource,
  type InvoiceExtractionResult,
} from '@/lib/ocr/invoice-extractor'
import { VisionTransientError, VisionPermanentError } from '@/lib/ocr/vision'

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

  // The client's OWN (buyer) GSTIN, when set, is the fact that lets extraction
  // reject a buyer GSTIN mislabelled as the supplier. Read it tenant-scoped. We
  // select('*') and fail SOFT: if the additive own_gstin migration has not been
  // applied yet the key is simply absent and we continue with null — this
  // enhancement must never be able to break extraction the way an unknown-column
  // reference would (see the PGRST204 session-save regression).
  let buyerGstin: string | null = null
  if (invoice.client_id) {
    const { data: clientRow, error: clientErr } = await db
      .from('clients')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', invoice.client_id)
      .maybeSingle()
    if (clientErr) {
      logger.warn('[Extract] client own_gstin read failed; continuing without buyer cross-check', {
        invoiceId, kind: clientErr.code ?? 'unknown',
      })
    } else {
      buyerGstin = (clientRow as { own_gstin?: string | null } | null)?.own_gstin ?? null
    }
  }

  const { masterKeyHex } = resolveFileKeyConfig()

  // §P2-12 per-stage timing. Started before the download so 'decrypt' also accounts
  // for the storage fetch. Stage names + integer ms only — never invoice content.
  const timing = new StageTimer()

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
  timing.mark('decrypt')

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
      buyerGstin,
      parallelVision: env.EXTRACTION_VISION_PARALLEL === true,
      imageQualityGate: imageQualityGateFromEnv(env),
    }).catch((e: unknown): never => {
      if (e instanceof InvoiceExtractionError) {
        if (!e.retryable) throw new PermanentJobError(`EXTRACTION_FAILED: ${e.message}`)
        throw e // transient OCR / vision fault -> the worker requeues
      }
      // A transient provider fault that reached us unwrapped must still requeue,
      // never settle; a permanent provider fault (bad key, unparseable output,
      // unsupported type) can never succeed on retry, so it settles immediately
      // instead of burning the queue's bounded attempt budget.
      if (e instanceof VisionTransientError) throw e
      if (e instanceof VisionPermanentError) throw new PermanentJobError(`EXTRACTION_FAILED: ${e.message}`)
      throw e
    })
    timing.mark('extract')

    // Re-evaluate the returned candidate independently so the handler owns the
    // canonical row and the date-resolved batching gate (the engine never returns
    // a canonicalised ledger row, only the fields it located).
    const evaluation = evaluateLedger(result.candidate, {
      minConfidence: env.EXTRACTION_MIN_CONFIDENCE,
      amountToleranceMinorUnits: env.EXTRACTION_AMOUNT_TOLERANCE_MINOR_UNITS,
      buyerGstin,
    })
    const confidenceSource: ExtractionSource = result.source

    // A critical-field conflict the engine detected is unreconciled disagreement
    // between the local and AI readings. A machine must not silently pick a winner,
    // so never auto-approve over it: downgrade to needs_review and make the reasons
    // name the exact fields, so the persisted status describes the selected candidate.
    const conflictFields = result.conflictFields ?? []
    if (conflictFields.length > 0 && evaluation.review === 'approved') {
      evaluation.review = 'needs_review'
      evaluation.reasons = [...evaluation.reasons, ...conflictFields.map((f) => `candidate-conflict:${f}`)]
      logger.info('[Extract] sources conflict on critical fields; forcing review', {
        invoiceId, jobId: job.id, source: confidenceSource, conflictFields,
      })
    }

    // §P3-13 fold the image-quality verdict into the authoritative row. A failing
    // gate can only ADD reasons and push the row to review (never approve it), so it
    // can never weaken auto-approve precision. Kept separate from the conflict rule.
    const imageQualityReasons = result.imageQualityReasons ?? []
    if (imageQualityReasons.length > 0) {
      if (evaluation.review === 'approved') evaluation.review = 'needs_review'
      evaluation.reasons = [...evaluation.reasons, ...imageQualityReasons]
      logger.info('[Extract] image quality gate forced review', {
        invoiceId, jobId: job.id, reasons: imageQualityReasons,
      })
    }

    // §P3-14 a multi-invoice document: the engine read TWO+ invoice numbers off one
    // file and returned a single group's row, dropping the others. That row can
    // never be auto-approved — a human must split the file. Like the quality gate
    // this only ADDS a reason and pushes to review, so precision is never weakened.
    if (result.multiInvoiceDetected) {
      if (evaluation.review === 'approved') evaluation.review = 'needs_review'
      if (!evaluation.reasons.includes('multi-invoice-document')) {
        evaluation.reasons = [...evaluation.reasons, 'multi-invoice-document']
      }
      logger.info('[Extract] multi-invoice document forced review', {
        invoiceId, jobId: job.id, pagesProcessed: result.pagesProcessed,
      })
    }

    // §P3-16 a printed CREDIT/DEBIT NOTE reverses an earlier invoice, so a machine
    // must never auto-approve it. Like the quality / multi-invoice gates this only
    // ADDS a reason and pushes to review (never approves), so auto-approve precision
    // is untouched. Because the reason is folded HERE (not inside the shared
    // evaluateLedger), a human correcting the note in applyInvoiceReview can still
    // approve it — the block is on silent machine approval, not on human review.
    const documentType = evaluation.row.document_type ?? 'invoice'
    if (documentType !== 'invoice') {
      if (evaluation.review === 'approved') evaluation.review = 'needs_review'
      if (!evaluation.reasons.includes('credit-debit-note')) {
        evaluation.reasons = [...evaluation.reasons, 'credit-debit-note']
      }
      logger.info('[Extract] credit/debit note forced review', {
        invoiceId, jobId: job.id, documentType,
      })
    }

    // §Part-2 classify the document's TYPE (what it IS) separately from its
    // accounting CATEGORY (how it books), from the document's OWN printed headings
    // — never a filename and never a single generic keyword. Only a POSITIVE
    // signal adds a review reason here: two competing titles, or a document that
    // is clearly NOT invoice-shaped (a receipt / payment voucher / delivery
    // challan / proforma). An ABSENT heading never blocks, so the historical
    // purchase-register default and its recall are preserved. Like the conflict /
    // quality / multi-invoice / note gates this can ONLY add a reason and push to
    // review (never approve). The full metadata is carried as an encrypted sibling
    // (`_classification`), never overwriting the original OCR row (§2.3).
    const classification = classifyDocument({
      structuralNoteType: documentType,
      headingText: headingRegion(result.rawText ?? ''),
      fullText: result.rawText ?? '',
    })
    if (classification.needsReview) {
      if (evaluation.review === 'approved') evaluation.review = 'needs_review'
      for (const reason of classification.reviewReasons) {
        if (!evaluation.reasons.includes(reason)) {
          evaluation.reasons = [...evaluation.reasons, reason]
        }
      }
      logger.info('[Extract] classification forced review', {
        invoiceId, jobId: job.id,
        documentType: classification.documentType,
        accountingCategory: classification.accountingCategory,
        reasonCodes: classification.reviewReasons,
      })
    }

    // §Part-5 Layer 2 (invoice-identity duplicate detection). Distinct from the
    // exact-file Layer 1: a re-scan of the SAME physical bill (a photo and a PDF
    // of one invoice) has different bytes yet the same identity. We build a blind
    // index (HMAC of the canonical invoice number + supplier + date under the
    // file master key — never the plaintext) and look for a PRIOR live invoice in
    // this (workspace, client) sharing it. A hit only ADDS a reason and pushes to
    // review (NEVER auto-drops, NEVER approves, NEVER deletes either row) — a
    // human confirms. The key is computed fail-soft and persisted as a separate
    // best-effort write below, so extraction is completely unaffected when the
    // additive `identity_key` migration has not been applied yet.
    let identityKeyHex: string | null = null
    try {
      identityKeyHex = computeIdentityKey(
        {
          invoiceNumber: evaluation.row.invoice_number,
          supplierGstin: evaluation.row.supplier_gstin,
          vendorName: evaluation.row.vendor_name,
          invoiceDate: evaluation.row.invoice_date,
        },
        masterKeyHex,
      )
    } catch {
      identityKeyHex = null
    }
    if (identityKeyHex) {
      const priorId = await findPriorDuplicateIdentity(db, {
        workspaceId, clientId: invoice.client_id, identityKeyHex, excludeInvoiceId: invoiceId,
      })
      if (priorId) {
        if (evaluation.review === 'approved') evaluation.review = 'needs_review'
        if (!evaluation.reasons.includes(DUPLICATE_IDENTITY_REASON)) {
          evaluation.reasons = [...evaluation.reasons, DUPLICATE_IDENTITY_REASON]
        }
        logger.info('[Extract] possible duplicate identity flagged for review', {
          invoiceId, jobId: job.id, priorInvoiceId: priorId.slice(0, 8),
        })
      }
    }

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
    // Carry the machine reason codes inside the encrypted payload as a sibling
    // key (`_reviewReasons`) so the Review list and in-chat editor can explain
    // WHY a row was flagged, in plain English (§P0-3). No new column; readers
    // index known fields, it never reaches the register export, and it is never
    // logged. An approved row carries an empty list.
    // `_recipientGstin` is likewise an informational sibling (underscore-prefixed
    // so it is never mistaken for a candidate field) that lets P0-1c learn a
    // client's own GSTIN from the buyer token recurring across their bills.
    const payload = encryptExtractedPayload(
      JSON.stringify({
        ...evaluation.row,
        _reviewReasons: evaluation.reasons,
        _recipientGstin: result.candidate.recipient_gstin ?? null,
        _classification: classification,
      }),
      masterKeyHex,
    )

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
      repairs: evaluation.repairs ?? [],
      presentFieldNames: [
        'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
        'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
      ].filter((field) => {
        const value = result.candidate[field as keyof typeof result.candidate]
        return value !== undefined && value !== null && value !== ''
      }),
      reasonCodes: evaluation.reasons.slice(0, 8),
    })
    timing.mark('persist')

    // Opt-in local debugging: print the complete field -> value map that was
    // extracted. Emitted at DEBUG level, which lib/logger drops when
    // NODE_ENV=production, so this can never leak invoice values to a prod log
    // sink even if the flag is left enabled. Enable locally with
    // EXTRACTION_DEBUG_VALUES=true in .env and restart `next dev`.
    if (getEnv().EXTRACTION_DEBUG_VALUES) {
      const present = (o: Record<string, unknown>) => Object.fromEntries(
        Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''),
      )
      logger.debug('[Extract.debug] full extraction values (LOCAL ONLY)', {
        invoiceId,
        jobId: job.id,
        source: confidenceSource,
        review: evaluation.review,
        confidence: evaluation.confidence,
        rawCandidate: present(result.candidate as unknown as Record<string, unknown>),
        normalizedRow: present(evaluation.row as unknown as Record<string, unknown>),
        reasonCodes: evaluation.reasons,
      })
    }

    // Route the invoice status. The invoices.status CHECK allows 'completed' but
    // NOT 'approved' ('approved' is an extracted_records.review_status value, not
    // an invoice lifecycle state), so a clean extraction lands as 'completed' and
    // anything unresolved as 'needs_review'.
    const invoiceStatus = evaluation.review === 'approved' ? 'completed' : 'needs_review'
    await assertLease()
    const { error: stErr } = await db.from('invoices').update({ status: invoiceStatus })
      .eq('workspace_id', workspaceId).eq('id', invoiceId)
    if (stErr) throw new Error(`INVOICE_STATUS_ERROR: ${stErr.message}`)

    // §Part-5: persist the identity blind index as a SEPARATE best-effort write.
    // Kept apart from the status update on purpose — if the additive
    // `identity_key` migration has not been applied, this update fails SOFT (a
    // logged warning) and the invoice is still correctly routed to review above;
    // the whole feature stays inactive until the operator applies the migration.
    if (identityKeyHex) {
      const { error: idErr } = await db.from('invoices')
        .update({ identity_key: identityKeyToBytea(identityKeyHex) })
        .eq('workspace_id', workspaceId).eq('id', invoiceId)
      if (idErr) {
        logger.warn('[Extract] identity_key write skipped (migration not applied?); duplicate detection inactive', {
          invoiceId, jobId: job.id, code: idErr.code ?? 'unknown',
        })
      }
    }

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
    timing.mark('batch')
    // §P2-12 one structured line per job with the per-stage breakdown (metadata only).
    logger.info('[Extract] stage timing', { invoiceId, jobId: job.id, ...timing.summary() })
    logger.info('[Extract] complete', {
      invoiceId, jobId: job.id, review: evaluation.review,
      source: confidenceSource, reasonCodes: evaluation.reasons.slice(0, 8),
      mimeType: invoice.content_type, pagesProcessed: result.pagesProcessed,
    })
  } finally {
    plain.fill(0) // wipe plaintext bytes on every exit path (approve, review, throw)
  }
}

// §P3-13 translate the operator's image-quality knobs into the engine gate options.
// The gate is ON unless explicitly disabled; only thresholds the operator actually
// set are forwarded, so the engine applies its own sane defaults for the rest.
function imageQualityGateFromEnv(env: ReturnType<typeof getEnv>): {
  enabled: boolean
  blurVarianceAtMost?: number
  minLongEdge?: number
  minPixels?: number
} {
  return {
    enabled: env.IMAGE_QUALITY_GATE !== false,
    ...(typeof env.IMAGE_BLUR_VARIANCE_MAX === 'number' ? { blurVarianceAtMost: env.IMAGE_BLUR_VARIANCE_MAX } : {}),
    ...(typeof env.IMAGE_MIN_LONG_EDGE === 'number' ? { minLongEdge: env.IMAGE_MIN_LONG_EDGE } : {}),
    ...(typeof env.IMAGE_MIN_PIXELS === 'number' ? { minPixels: env.IMAGE_MIN_PIXELS } : {}),
  }
}

/**
 * §Part-5 Layer 2 lookup: is there a PRIOR LIVE invoice in this (workspace,
 * client) whose identity blind index equals `identityKeyHex`? Excludes the
 * invoice currently being extracted and any soft-deleted row. Tenant-scoped, and
 * a null client (individual) is matched with an `is client_id null` filter so two
 * organizations never see each other's keys.
 *
 * Deliberately FAIL-SOFT: if the additive `identity_key` column has not been
 * created yet (migration unapplied) the read errors — we log and return null so
 * extraction proceeds with duplicate detection simply inactive, exactly the way
 * the optional `own_gstin` read degrades. A lookup must never break a real bill.
 */
async function findPriorDuplicateIdentity(
  db: Db,
  args: { workspaceId: string; clientId: string | null; identityKeyHex: string; excludeInvoiceId: string },
): Promise<string | null> {
  try {
    let query = db
      .from('invoices')
      .select('id')
      .eq('workspace_id', args.workspaceId)
      .eq('identity_key', identityKeyToBytea(args.identityKeyHex))
      .neq('id', args.excludeInvoiceId)
      .neq('status', 'deleted')
      .limit(1)
    query = args.clientId
      ? (query.eq('client_id', args.clientId) as typeof query)
      : (query.is('client_id', null) as typeof query)
    const { data, error } = await (query as unknown as {
      maybeSingle: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>
    }).maybeSingle()
    if (error) {
      logger.warn('[Extract] identity duplicate lookup failed; continuing (fail-soft)', {
        code: error.message.slice(0, 80),
      })
      return null
    }
    return data?.id ?? null
  } catch (e) {
    logger.warn('[Extract] identity duplicate lookup threw; continuing (fail-soft)', {
      error: e instanceof Error ? e.message : String(e),
    })
    return null
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
  // whatsapp_sessions has ONE pending_reply_body slot. If a register delivery
  // ([[deliver:<id>]]) is already waiting there, overwriting it with this notice
  // would silently drop the Excel hand-off; the register message already carries
  // the "N invoice(s) need review" note, so leave it untouched.
  const { data: slot } = await db.from('whatsapp_sessions').select('pending_reply_body')
    .eq('sender_hmac', senderHmac).maybeSingle()
  const pending = (slot?.pending_reply_body as string | null | undefined) ?? ''
  if (pending.startsWith('[[deliver:')) {
    logger.info('[Extract] review notice skipped: register delivery already queued', { invoiceId, jobId })
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

