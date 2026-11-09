// lib/exports/deliver.ts — hand a generated register back to its OWNER in-chat.
//
// The product promises "your Excel register will be sent here." The workbook is
// encrypted at rest, and the web download route requires a signed-in Supabase
// session a WhatsApp-only user does not have, so a link alone is a dead end. The
// only reliable delivery for a WhatsApp-first user is to decrypt the container IN
// MEMORY and send the .xlsx back into the owner's own chat as a document.
//
// This mirrors the download route's serve path exactly (same storage bucket, same
// decrypt + key-version check) but is authorized by the workspace owner's sender
// identity at webhook time rather than a browser cookie. It NEVER logs the file
// bytes, the object path, the key version, or the media id.
//
// Idempotency: a workbook is only pushed while its row is status='ready'. Once
// delivered we flip it to 'sent'; a later 'sent' row is reported as already
// delivered without a re-send, so repeated Review/Done taps never spam the file.
import type { SupabaseClient } from '@supabase/supabase-js'
import { bucketFor } from '@/lib/supabase/server'
import { decryptFile, resolveFileKeyConfig } from '@/lib/encryption/files'
import { uploadWhatsAppMedia, isPermanentMediaFailure } from '@/lib/whatsapp/media'
import { sendDocument, type SendOutcome } from '@/lib/whatsapp/send'
import { workbookFileName, categoryFileToken } from '@/lib/exports/naming'
import { registerSheetNameForCategory } from '@/lib/excel/generator'
import { logger } from '@/lib/logger'

type Db = SupabaseClient

const SPREADSHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface WorkbookRow {
  workspace_id: string
  batch_id: string | null
  status: string
  expires_at: string | null
  file_object_path: string
  file_encryption_key_version: string | null
  accounting_category: string | null
  period_start?: string | null
  version?: number | null
}

export interface DeliverResult {
  /** true when the file is (now or previously) in the owner's chat. */
  delivered: boolean
  /** 'skipped' = not eligible (missing/expired/not-ready) — not a failure. */
  outcome: SendOutcome | 'skipped'
  /** Meta's message id when THIS call confirmed a send, for outbox audit. */
  providerMessageId?: string | null
  /** Bounded, PII-free reason when it did not land — persisted as last_error. */
  providerDetail?: string | null
}

/**
 * Deliver one workbook (by id) to `to` as a WhatsApp document. The caller has
 * already tied `to` to the workspace that OWNS this workbook (the inbound sender
 * who onboarded it), so this is owner-scoped, not cross-tenant: the row's
 * workspace is re-read here and only that workspace's stored object is fetched.
 */
export async function deliverWorkbookToWhatsApp(
  db: Db,
  args: { workbookId: string; to: string; caption?: string; expectedWorkspaceId?: string },
): Promise<DeliverResult> {
  const { workbookId, to } = args
  if (!UUID_RE.test(workbookId)) return { delivered: false, outcome: 'skipped' }

  const { data: row, error: readErr } = await db
    .from('generated_workbooks')
    .select('workspace_id,batch_id,status,expires_at,file_object_path,file_encryption_key_version,accounting_category,period_start,version')
    .eq('id', workbookId)
    .maybeSingle()
  if (readErr || !row) {
    logger.warn('[Deliver] workbook row unavailable for delivery', { code: 'DELIVER_NO_ROW' })
    return { delivered: false, outcome: 'skipped' }
  }
  const wb = row as WorkbookRow
  // §delivery isolation: when the caller knows which workspace the recipient is
  // owed (the delivery outbox records it per row), refuse to serve a workbook that
  // belongs to a DIFFERENT tenant — a claim must never resolve to another
  // workspace's file even given a forged/guessed workbook id.
  if (args.expectedWorkspaceId && wb.workspace_id !== args.expectedWorkspaceId) {
    logger.warn('[Deliver] workspace mismatch; refusing cross-tenant send', { code: 'DELIVER_TENANT_MISMATCH', workbookId })
    return { delivered: false, outcome: 'skipped' }
  }
  const expired = !!wb.expires_at && new Date(wb.expires_at).getTime() <= Date.now()
  if (expired || !wb.file_object_path) return { delivered: false, outcome: 'skipped' }
  // Already pushed to this owner once — do not re-send; report as delivered.
  if (wb.status === 'sent') return { delivered: true, outcome: 'ok' }
  if (wb.status !== 'ready') return { delivered: false, outcome: 'skipped' }
  // §one-file-per-month: a workbook is only servable while it is still the LIVE
  // register for its own (batch, category). Publish retires prior versions, but a
  // rebuild that raced the retire (or two builds that read the same max version)
  // can leave two 'ready' rows for one month — and the owner would then receive the
  // same month twice, an older copy first. If a NEWER version exists for this exact
  // scope, this row is superseded: skip it, never send a stale register.
  if (wb.batch_id && wb.version != null) {
    const scope = db.from('generated_workbooks').select('id')
      .eq('workspace_id', wb.workspace_id).eq('batch_id', wb.batch_id)
      .gt('version', wb.version).in('status', ['ready', 'sent', 'expired'])
    // A legacy row may carry no category at all: match on IS NULL rather than
    // eq(null), which PostgREST renders as a filter that can never match.
    const { data: newer } = await (wb.accounting_category
      ? scope.eq('accounting_category', wb.accounting_category)
      : scope.is('accounting_category', null)).limit(1)
    if ((newer ?? []).length > 0) {
      logger.info('[Deliver] workbook superseded by a newer version; not sending a stale register', { workbookId })
      return { delivered: false, outcome: 'skipped', providerDetail: 'superseded by a newer version' }
    }
  }

  try {
    const { masterKeyHex } = resolveFileKeyConfig()
    const { data: blob, error: dlErr } = await db.storage
      .from(bucketFor('exports'))
      .download(wb.file_object_path)
    if (dlErr || !blob) {
      // A MISSING object is permanent for this row — a retry can never resurrect it
      // — so it must NOT be reported 'transient' (which parks it 'failed' with a
      // future next_attempt_at and re-loops forever on every inbound, burying the
      // real fault). '404'/'NoSuchKey' is surfaced as 'skipped', which the consumer
      // parks as a terminal 'unknown' for reconciliation; a network/5xx read stays
      // 'transient'. Log only a bounded provider status/code — never the path or PII.
      const status = (dlErr as { statusCode?: number | string } | null)?.statusCode
      const pcode = (dlErr as { code?: string } | null)?.code
      const missing = String(status) === '404' || pcode === 'NoSuchKey'
      logger.error('[Deliver] storage read failed', {
        code: missing ? 'DELIVER_OBJECT_MISSING' : 'DELIVER_STORAGE_ERROR',
        status: status ?? null, providerCode: pcode ?? null, workbookId,
      })
      return {
        delivered: false, outcome: missing ? 'skipped' : 'transient',
        providerDetail: `storage: ${missing ? 'object missing' : `status ${String(status ?? pcode ?? 'unknown')}`}`,
      }
    }
    const container = Buffer.from(await blob.arrayBuffer())
    // A tampered / wrong-key container throws (never emits plaintext); we surface
    // a safe code only.
    const plain = decryptFile(container, masterKeyHex, {
      context: wb.file_object_path,
      expectedKeyVersion: wb.file_encryption_key_version ?? undefined,
    })

    // The in-chat file is named by its REAL accounting month (Billora_YYYY-MM.xlsx,
    // §P1-5), read from the workbook's OWN validated period (§register-scope) — the
    // scope it was actually built for — and only if that is absent (a legacy row from
    // before the period was stamped) does it fall back to the batch's period_start.
    // An unresolvable period keeps the stable generic name; we never stamp a guessed
    // month on the download.
    let periodStart: string | null = wb.period_start ?? null
    if (!periodStart && wb.batch_id) {
      const { data: batchRow } = await db
        .from('invoice_batches').select('period_start')
        .eq('workspace_id', wb.workspace_id).eq('id', wb.batch_id).maybeSingle()
      periodStart = (batchRow as { period_start?: string | null } | null)?.period_start ?? null
    }
    const filename = workbookFileName(periodStart, categoryFileToken(registerSheetNameForCategory(wb.accounting_category)))

    let mediaId: string
    try {
      mediaId = await uploadWhatsAppMedia({ buffer: plain, mimeType: SPREADSHEET_MIME, filename })
    } catch (e) {
      // The message is Meta's own text plus a bounded graph code — no token, no path.
      const detail = e instanceof Error ? e.message.slice(0, 120) : 'media upload error'
      if (isPermanentMediaFailure(e)) {
        logger.error('[Deliver] media upload blocked (credential)', { code: 'DELIVER_UPLOAD_BLOCKED' })
        return { delivered: false, outcome: 'blocked', providerDetail: `upload: ${detail}` }
      }
      logger.warn('[Deliver] media upload transient', { code: 'DELIVER_UPLOAD_RETRY' })
      return { delivered: false, outcome: 'transient', providerDetail: `upload: ${detail}` }
    }

    // Capture Meta's message id so the outbox records exactly which send settled
    // the claim (audit + reconciliation); it is never logged in full.
    const messageIdOut: { current: string | null } = { current: null }
    // And WHY it did not, when it didn't: a blocked document send and a blocked text
    // reply are not the same fault, and without the provider code parked in the row
    // an operator cannot tell a dead token from a temporary Meta media block.
    const diagnosticsOut: { current: string | null } = { current: null }
    const outcome = await sendDocument(
      to,
      {
        mediaId,
        filename,
        caption: args.caption ?? 'Your Billora invoice register. Each invoice is filed under its own invoice month.',
      },
      { workbookId },
      messageIdOut,
      diagnosticsOut,
    )
    if (outcome !== 'ok') {
      return { delivered: false, outcome, providerMessageId: messageIdOut.current, providerDetail: diagnosticsOut.current }
    }

    // Confirmed delivered: retire the pending row so we never re-send it. A lost
    // race (already flipped) is fine — the file is in the chat either way.
    await db.from('generated_workbooks').update({ status: 'sent' }).eq('id', workbookId).eq('status', 'ready')
    logger.info('[Deliver] register delivered as document', { workbookId })
    return { delivered: true, outcome: 'ok', providerMessageId: messageIdOut.current }
  } catch (e) {
    logger.error('[Deliver] delivery failed', { code: 'DELIVER_FAILED' })
    return { delivered: false, outcome: 'transient', providerDetail: `fault: ${e instanceof Error ? e.name : 'unknown'}`.slice(0, 120) }
  }
}
