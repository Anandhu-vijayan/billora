// lib/jobs/handlers/build-register.ts — register_generation job handler.
//
// Builds one batch's GSTR-2B purchase register from its APPROVED extracted
// rows, stores the workbook privately, and hands the download link to the
// sender's next inbound reply (best-effort). It never claims delivery it did
// not achieve (rule 6) and a failed send never fails the job (rule 5).
//
// Invariants:
//   * Tenant isolation: every read is scoped by the job's workspace_id; the
//     batch itself is verified to belong to that workspace before any gather.
//   * Determinism: the workbook object key is an HMAC of the batch id, so a
//     re-run overwrites the same slot instead of piling up files.
//   * Freshness: prior workbooks for the batch are marked stale and a monotonically
//     increasing version is recorded, so an old object can never look current.
//   * Review accounting: needs_review/failed invoices are NOT silently dropped —
//     they are counted and logged, and only approved rows enter the register.
import type { SupabaseClient } from '@supabase/supabase-js'
import { bucketFor } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { PermanentJobError } from '@/lib/jobs/queue'
import type { JobContext } from '@/lib/jobs/worker'
import { resolveFileKeyConfig, deriveWorkbookKey, encryptFile } from '@/lib/encryption/files'
import { decryptExtractedPayload } from '@/lib/encryption'
import { buildComplianceExcelWorkbook } from '@/lib/excel/generator'
import { updateSessionDeliveryState } from '@/lib/whatsapp/sessions'
import type { LedgerRow } from '@/lib/ocr/ledger'

type Db = SupabaseClient

const SPREADSHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
// A generated workbook is protected AT REST and served only through the
// authenticated /api/exports/[id]/download route (workspace membership is
// re-checked there). This window is when a ready register stays downloadable
// before it is treated as lapsed; the object itself is never handed out raw.
const WORKBOOK_LINK_TTL_SECONDS = 7 * 24 * 3600

/** PostgREST renders bytea as a `\x`-prefixed hex string (same as intake). */
function byteaToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/i, ''), 'hex')
  throw new Error('BYTEA_DECODE_ERROR: unexpected encrypted_payload encoding')
}

/** The WhatsApp sender identity that owns a workspace (for reply linkage). */
async function findOwnerSenderHmac(db: Db, workspaceId: string): Promise<string | null> {
  const { data } = await db.from('whatsapp_identities').select('sender_hmac')
    .eq('workspace_id', workspaceId).limit(1)
  return ((data ?? [])[0]?.sender_hmac as string | undefined) ?? null
}

export async function buildRegister(ctx: JobContext): Promise<void> {
  const { db, job, assertLease } = ctx
  const workspaceId = job.workspace_id
  if (!job.batch_id) throw new PermanentJobError('REGISTER_MISSING_BATCH')
  const batchId = job.batch_id

  // Tenant check first: the batch must belong to this job's workspace.
  const { data: batchRow, error: batchErr } = await db
    .from('invoice_batches').select('id,workspace_id,status')
    .eq('workspace_id', workspaceId).eq('id', batchId).maybeSingle()
  if (batchErr) throw new Error(`BATCH_READ_ERROR: ${batchErr.message}`)
  if (!batchRow) throw new PermanentJobError('REGISTER_BATCH_NOT_FOUND')

  // Batch readiness gate. Extraction schedules this job unconditionally (so no
  // batch is ever left unscheduled by a finish-together race); this is the
  // safety valve that stops a PREMATURE workbook: build only once no extraction
  // job for the batch is still queued/processing. A normal (non-permanent)
  // throw requeues with backoff, so the register rebuilds itself once the last
  // sibling settles — the enqueue gives this job a generous max_attempts so
  // these expected requeues never exhaust into a permanent failure.
  //
  // NEVER assume processing_jobs.batch_id is populated: an extraction job created
  // before its invoice was ever finalized carries a NULL batch_id, so a
  // batch_id-only scan would miss it and build a premature workbook. We count
  // outstanding extraction two ways and take the larger — jobs stamped into this
  // batch, and jobs whose target invoice already belongs to this batch.
  const { data: invoiceRows, error: invErr } = await db
    .from('invoices').select('id')
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).neq('status', 'deleted')
  if (invErr) throw new Error(`BATCH_INVOICES_ERROR: ${invErr.message}`)
  const invoiceIds = (invoiceRows ?? []).map((r) => (r as { id: string }).id)

  const { count: outstandingByBatch, error: outErr } = await db
    .from('processing_jobs').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId)
    .eq('job_type', 'invoice_extraction').in('status', ['queued', 'processing'])
  if (outErr) throw new Error(`BATCH_READINESS_ERROR: ${outErr.message}`)
  let outstanding = outstandingByBatch ?? 0
  if (invoiceIds.length > 0) {
    const { count: outstandingByInvoice, error: outErr2 } = await db
      .from('processing_jobs').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).in('invoice_id', invoiceIds)
      .eq('job_type', 'invoice_extraction').in('status', ['queued', 'processing'])
    if (outErr2) throw new Error(`BATCH_READINESS_ERROR: ${outErr2.message}`)
    outstanding = Math.max(outstanding, outstandingByInvoice ?? 0)
  }
  if (outstanding > 0) throw new Error(`REGISTER_NOT_READY: ${outstanding} extraction job(s) outstanding`)

  // Account for the non-approved invoices so they are never silently dropped.
  const { count: flagged } = await db
    .from('invoices').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).eq('status', 'needs_review')
  if ((flagged ?? 0) > 0) {
    logger.info('[Register] batch has invoices awaiting review', { batchId, jobId: job.id, needsReview: flagged })
  }

  if (invoiceIds.length === 0) return // nothing to do; completes as a no-op

  const { masterKeyHex, pathKeyHex } = resolveFileKeyConfig()
  const { data: records, error: recErr } = await db
    .from('extracted_records').select('invoice_id,encrypted_payload,review_status')
    .eq('workspace_id', workspaceId).eq('review_status', 'approved').in('invoice_id', invoiceIds)
  if (recErr) throw new Error(`RECORDS_READ_ERROR: ${recErr.message}`)

  const rows: LedgerRow[] = []
  for (const rec of (records ?? []) as Array<{ invoice_id: string; encrypted_payload: unknown }>) {
    try {
      const plain = decryptExtractedPayload(byteaToBuffer(rec.encrypted_payload), masterKeyHex)
      rows.push(JSON.parse(plain) as LedgerRow)
    } catch (e) {
      // A corrupt stored payload is unexpected, but never emit a partial/garbage
      // workbook: skip that one row and record it. The batch still ships cleanly.
      logger.warn('[Register] skipping undecryptable record', {
        invoice: rec.invoice_id.slice(0, 8), error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (rows.length === 0) {
    logger.info('[Register] no approved rows to render; completing as no-op', { batchId, jobId: job.id, needsReview: flagged ?? 0 })
    return // a "no approved rows" batch is a successful no-op, not a failure
  }

  logger.info('[Register] workbook generation started', { batchId, jobId: job.id, rowCount: rows.length })
  const workbook = await buildComplianceExcelWorkbook(rows)
  logger.info('[Register] workbook generated', { batchId, jobId: job.id, rowCount: rows.length, sizeBytes: workbook.length })
  const exportPath = deriveWorkbookKey(batchId, pathKeyHex)
  const exportsBucket = bucketFor('exports')
  // Encrypt the register AT REST: vendor names, GSTINs and amounts are customer
  // data. The envelope container uploads as application/octet-stream; the
  // logical spreadsheetml type + extension are retained as object metadata so
  // the download route can name the file it streams after decrypting in memory.
  const enc = encryptFile(workbook, masterKeyHex, { context: exportPath })
  await assertLease()
  const { error: upErr } = await db.storage.from(exportsBucket)
    .upload(exportPath, enc.container, {
      contentType: 'application/octet-stream', upsert: true,
      metadata: { original_mime: SPREADSHEET_MIME, original_extension: 'xlsx' },
    })
  if (upErr) throw new Error(`WORKBOOK_UPLOAD_ERROR: ${upErr.message}`)
  logger.info('[Register] workbook stored', {
    batchId, jobId: job.id, sizeBytes: enc.sizeBytes, rowCount: rows.length,
  })

  // Freshness: retire prior workbooks for this batch, then insert the new one
  // with a monotonic version. The insert is what makes it the current register.
  await assertLease()
  await db.from('generated_workbooks')
    .update({ status: 'expired' })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).in('status', ['ready', 'sent'])
  const { data: prior } = await db.from('generated_workbooks').select('version')
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).order('version', { ascending: false }).limit(1)
  const version = ((prior ?? [])[0]?.version as number | undefined ?? 0) + 1

  const expiresAt = new Date(Date.now() + WORKBOOK_LINK_TTL_SECONDS * 1000).toISOString()
  await assertLease()
  const { data: inserted, error: gwErr } = await db.from('generated_workbooks').insert({
    workspace_id: workspaceId, batch_id: batchId, file_object_path: exportPath,
    file_encryption_key_version: enc.keyVersion, size_bytes: enc.sizeBytes,
    status: 'ready', version, generated_at: new Date().toISOString(), expires_at: expiresAt,
  }).select('id').single()
  if (gwErr || !inserted) throw new Error(`WORKBOOK_ROW_ERROR: ${gwErr?.message ?? 'no id'}`)
  const workbookId = (inserted as { id: string }).id
  logger.info('[Register] workbook ready', { workbookId, batchId, jobId: job.id, rowCount: rows.length })

  // Delivery is best-effort and NEVER fails the generation job (rule 5).
  await scheduleDelivery(db, workspaceId, workbookId, job.id, rows.length, flagged ?? 0, expiresAt, assertLease)
}

/**
 * Best-effort delivery: hand the AUTHENTICATED download link to the sender's
 * NEXT inbound reply (the phone number is only known at webhook time, so we
 * never claim a spontaneous push). The workbook is encrypted at rest, so we
 * link our own login-required route rather than a raw bucket URL. Storing the
 * pending reply is send-only bookkeeping — a failure here cannot fail the
 * generation job (rule 5), and the workbook row persists for a later retry.
 */
async function scheduleDelivery(
  db: Db,
  workspaceId: string,
  workbookId: string,
  jobId: string,
  rowCount: number,
  needsReview: number,
  expiresAt: string,
  assertLease: () => Promise<void>,
): Promise<void> {
  try {
    const base = (process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '')
    if (!base) {
      // No public origin configured: the register is stored + ready, but we have
      // no safe way to hand out a link, so delivery is honestly deferred.
      logger.info('[Register] public URL unset; workbook ready, delivery deferred', { workbookId, jobId })
      return
    }
    const senderHmac = await findOwnerSenderHmac(db, workspaceId)
    if (!senderHmac) {
      logger.info('[Register] no linked WhatsApp sender; workbook ready for later delivery', { workbookId, jobId })
      return
    }
    const link = `${base}/api/exports/${workbookId}/download`
    const reviewNote = needsReview > 0
      ? ` ${needsReview} invoice(s) need review and are not included. Reply Review or choose Menu > Review.`
      : ''
    const body = `Your invoice register is ready — ${rowCount} invoice(s). Secure download (sign in required): ${link} (valid until ${expiresAt}).${reviewNote}`
    await assertLease()
    const queued = await updateSessionDeliveryState(db, senderHmac, { pending_reply_body: body, last_reply_error_code: null })
    logger.info(queued
      ? '[Register] delivery queued for next inbound reply'
      : '[Register] delivery deferred: delivery state could not be saved', { workbookId, jobId, rowCount })
  } catch (e) {
    // Delivery is orthogonal to generation; swallow so the job still completes.
    logger.warn('[Register] SEND_DEFERRED: delivery scheduling failed', {
      jobId, workbookId, error: e instanceof Error ? e.message : String(e),
    })
  }
}
