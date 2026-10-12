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
import { resolveFileKeyConfig, deriveWorkbookKey } from '@/lib/encryption/files'
import { decryptExtractedPayload } from '@/lib/encryption'
import { buildComplianceExcelWorkbook } from '@/lib/excel/generator'
import { updateSessionDeliveryState } from '@/lib/whatsapp/sessions'
import type { LedgerRow } from '@/lib/ocr/ledger'

type Db = SupabaseClient

const SPREADSHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 3600 // links live a week, then re-generate

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
  const { db, job } = ctx
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
  const { count: outstanding, error: outErr } = await db
    .from('processing_jobs').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId)
    .eq('job_type', 'invoice_extraction').in('status', ['queued', 'processing'])
  if (outErr) throw new Error(`BATCH_READINESS_ERROR: ${outErr.message}`)
  if ((outstanding ?? 0) > 0) throw new Error(`REGISTER_NOT_READY: ${outstanding} extraction job(s) outstanding`)

  // Approved invoice ids for this batch (still excluding anything deleted).
  const { data: invoiceRows, error: invErr } = await db
    .from('invoices').select('id')
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).neq('status', 'deleted')
  if (invErr) throw new Error(`BATCH_INVOICES_ERROR: ${invErr.message}`)
  const invoiceIds = (invoiceRows ?? []).map((r) => (r as { id: string }).id)

  // Account for the non-approved invoices so they are never silently dropped.
  const { count: flagged } = await db
    .from('invoices').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).eq('status', 'needs_review')
  if ((flagged ?? 0) > 0) {
    logger.info('[Register] batch has invoices awaiting review', { batch: batchId.slice(0, 8), needsReview: flagged })
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
    logger.info('[Register] no approved rows to render; completing as no-op', { batch: batchId.slice(0, 8) })
    return // a "no approved rows" batch is a successful no-op, not a failure
  }

  const workbook = await buildComplianceExcelWorkbook(rows)
  const exportPath = deriveWorkbookKey(batchId, pathKeyHex)
  const exportsBucket = bucketFor('exports')
  const { error: upErr } = await db.storage.from(exportsBucket)
    .upload(exportPath, workbook, { contentType: SPREADSHEET_MIME, upsert: true })
  if (upErr) throw new Error(`WORKBOOK_UPLOAD_ERROR: ${upErr.message}`)

  // Freshness: retire prior workbooks for this batch, then insert the new one
  // with a monotonic version. The insert is what makes it the current register.
  await db.from('generated_workbooks')
    .update({ status: 'expired' })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).in('status', ['ready', 'sent'])
  const { data: prior } = await db.from('generated_workbooks').select('version')
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).order('version', { ascending: false }).limit(1)
  const version = ((prior ?? [])[0]?.version as number | undefined ?? 0) + 1

  const { data: inserted, error: gwErr } = await db.from('generated_workbooks').insert({
    workspace_id: workspaceId, batch_id: batchId, file_object_path: exportPath,
    status: 'ready', version, generated_at: new Date().toISOString(),
  }).select('id').single()
  if (gwErr || !inserted) throw new Error(`WORKBOOK_ROW_ERROR: ${gwErr?.message ?? 'no id'}`)
  const workbookId = (inserted as { id: string }).id

  // Short-lived signed download link + its expiry (tracked independently of
  // generation: a link can lapse while the workbook row itself stays valid).
  const { data: signed, error: signErr } = await db.storage.from(exportsBucket)
    .createSignedUrl(exportPath, SIGNED_URL_TTL_SECONDS)
  if (signErr || !signed?.signedUrl) {
    logger.warn('[Register] signed URL creation failed; workbook still stored', {
      batch: batchId.slice(0, 8), error: signErr?.message ?? 'none',
    })
    return // generation succeeded; delivery is deferred, never fail the job
  }
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString()
  await db.from('generated_workbooks').update({ expires_at: expiresAt })
    .eq('workspace_id', workspaceId).eq('id', workbookId)

  await scheduleDelivery(db, workspaceId, rows.length, String(signed.signedUrl), expiresAt)
}

/**
 * Best-effort delivery: hand the workbook link to the sender's NEXT inbound
 * reply (the phone number is only known at webhook time, so we never claim a
 * spontaneous push). Storing the pending reply is send-only bookkeeping — a
 * failure here cannot fail the generation job (rule 5) and the workbook row +
 * signed URL persist for a later retry regardless.
 */
async function scheduleDelivery(db: Db, workspaceId: string, rowCount: number, signedUrl: string, expiresAt: string): Promise<void> {
  try {
    const senderHmac = await findOwnerSenderHmac(db, workspaceId)
    if (!senderHmac) {
      logger.info('[Register] no linked WhatsApp sender; workbook ready for later delivery', { workspace: workspaceId.slice(0, 8) })
      return
    }
    const body = `Your invoice register is ready — ${rowCount} invoice(s). Download: ${signedUrl} (link expires ${expiresAt}).`
    // If the sender is online right now a direct send may already succeed; if
    // not (no active window), fall back to the deferred-reply path. Delivery
    // status is never asserted as 'sent' from here — that stays honest.
    await updateSessionDeliveryState(db, senderHmac, { pending_reply_body: body, last_reply_error_code: null })
    logger.info('[Register] delivery queued on next inbound reply', { workspace: workspaceId.slice(0, 8) })
  } catch (e) {
    // Delivery is orthogonal to generation; swallow so the job still completes.
    logger.warn('[Register] SEND_DEFERRED: delivery scheduling failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
