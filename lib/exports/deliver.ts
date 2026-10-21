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
import { logger } from '@/lib/logger'

type Db = SupabaseClient

const SPREADSHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FILENAME = 'billora-register.xlsx'

interface WorkbookRow {
  workspace_id: string
  status: string
  expires_at: string | null
  file_object_path: string
  file_encryption_key_version: string | null
}

export interface DeliverResult {
  /** true when the file is (now or previously) in the owner's chat. */
  delivered: boolean
  /** 'skipped' = not eligible (missing/expired/not-ready) — not a failure. */
  outcome: SendOutcome | 'skipped'
}

/**
 * Deliver one workbook (by id) to `to` as a WhatsApp document. The caller has
 * already tied `to` to the workspace that OWNS this workbook (the inbound sender
 * who onboarded it), so this is owner-scoped, not cross-tenant: the row's
 * workspace is re-read here and only that workspace's stored object is fetched.
 */
export async function deliverWorkbookToWhatsApp(
  db: Db,
  args: { workbookId: string; to: string; caption?: string },
): Promise<DeliverResult> {
  const { workbookId, to } = args
  if (!UUID_RE.test(workbookId)) return { delivered: false, outcome: 'skipped' }

  const { data: row, error: readErr } = await db
    .from('generated_workbooks')
    .select('workspace_id,status,expires_at,file_object_path,file_encryption_key_version')
    .eq('id', workbookId)
    .maybeSingle()
  if (readErr || !row) {
    logger.warn('[Deliver] workbook row unavailable for delivery', { code: 'DELIVER_NO_ROW' })
    return { delivered: false, outcome: 'skipped' }
  }
  const wb = row as WorkbookRow
  const expired = !!wb.expires_at && new Date(wb.expires_at).getTime() <= Date.now()
  if (expired || !wb.file_object_path) return { delivered: false, outcome: 'skipped' }
  // Already pushed to this owner once — do not re-send; report as delivered.
  if (wb.status === 'sent') return { delivered: true, outcome: 'ok' }
  if (wb.status !== 'ready') return { delivered: false, outcome: 'skipped' }

  try {
    const { masterKeyHex } = resolveFileKeyConfig()
    const { data: blob, error: dlErr } = await db.storage
      .from(bucketFor('exports'))
      .download(wb.file_object_path)
    if (dlErr || !blob) {
      logger.error('[Deliver] storage read failed', { code: 'DELIVER_STORAGE_ERROR' })
      return { delivered: false, outcome: 'transient' }
    }
    const container = Buffer.from(await blob.arrayBuffer())
    // A tampered / wrong-key container throws (never emits plaintext); we surface
    // a safe code only.
    const plain = decryptFile(container, masterKeyHex, {
      context: wb.file_object_path,
      expectedKeyVersion: wb.file_encryption_key_version ?? undefined,
    })

    let mediaId: string
    try {
      mediaId = await uploadWhatsAppMedia({ buffer: plain, mimeType: SPREADSHEET_MIME, filename: FILENAME })
    } catch (e) {
      if (isPermanentMediaFailure(e)) {
        logger.error('[Deliver] media upload blocked (credential)', { code: 'DELIVER_UPLOAD_BLOCKED' })
        return { delivered: false, outcome: 'blocked' }
      }
      logger.warn('[Deliver] media upload transient', { code: 'DELIVER_UPLOAD_RETRY' })
      return { delivered: false, outcome: 'transient' }
    }

    const outcome = await sendDocument(
      to,
      {
        mediaId,
        filename: FILENAME,
        mimeType: SPREADSHEET_MIME,
        caption: args.caption ?? 'Your Billora invoice register. Each invoice is filed under its own invoice month.',
      },
      { workbookId },
    )
    if (outcome !== 'ok') return { delivered: false, outcome }

    // Confirmed delivered: retire the pending row so we never re-send it. A lost
    // race (already flipped) is fine — the file is in the chat either way.
    await db.from('generated_workbooks').update({ status: 'sent' }).eq('id', workbookId).eq('status', 'ready')
    logger.info('[Deliver] register delivered as document', { workbookId })
    return { delivered: true, outcome: 'ok' }
  } catch {
    logger.error('[Deliver] delivery failed', { code: 'DELIVER_FAILED' })
    return { delivered: false, outcome: 'transient' }
  }
}
