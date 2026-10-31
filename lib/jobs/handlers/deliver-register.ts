// lib/jobs/handlers/deliver-register.ts — the delivery CONSUMER.
//
// Generation (build-register) only records durable, independent outbox rows; THIS
// module is the only place those rows turn into an actual WhatsApp send. It is
// driven from the owner's inbound webhook (the one moment we hold a live `to`
// wa_id to reply on) and is fully decoupled from generation: a send that fails
// leaves the workbook 'ready' and the row retryable, and a workbook is NEVER lost
// because a send had trouble. Backs the workbook_deliveries state machine
// (migration 20261030000000) via lib/whatsapp/delivery-outbox.
//
// Concurrency safety comes entirely from the atomic claim RPC: only the caller
// whose claim_token matches may settle a row, and FOR UPDATE SKIP LOCKED means no
// two senders ever work the same row. An uncertain outcome parks as 'unknown' and
// is never blindly resent.
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { monthLabel } from '@/lib/exports/naming'
import { deliverWorkbookToWhatsApp } from '@/lib/exports/deliver'
import {
  claimDueDeliveries, markDeliverySent, releaseDelivery, resolveDelivery,
  backfillMissingDeliveries,
} from '@/lib/whatsapp/delivery-outbox'

type Db = SupabaseClient

/** Lease long enough for one media upload + document send, short enough to recover fast. */
const DELIVERY_LEASE_SECONDS = 120
/** How many owed files to hand to one owner per inbound touch (bounded like the old flow). */
const DELIVERY_PAGE = 5
/** Transient send → a short, safe retry delay. Credential block → a long one (operator must fix). */
const TRANSIENT_RETRY_SECONDS = 60
const BLOCKED_RETRY_SECONDS = 3600

/** A friendly, human accounting-category label for the caption. */
function categoryLabel(category: string | null): string {
  if (!category || category === 'purchase') return 'purchase'
  return category.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** Resolve the workspace an owner (sender HMAC) belongs to, for the legacy backfill. */
async function workspaceForSender(db: Db, senderHmac: string): Promise<string | null> {
  const { data } = await db.from('whatsapp_identities').select('workspace_id')
    .eq('sender_hmac', senderHmac).limit(1)
  return ((data ?? [])[0]?.workspace_id as string | undefined) ?? null
}

/** Read the light display fields a caption needs (never any row value or PII). */
async function loadCaptionFields(db: Db, workbookId: string): Promise<{ category: string | null; month: string | null; rowCount: number | null }> {
  const { data } = await db
    .from('generated_workbooks').select('accounting_category,batch_id,source_row_count')
    .eq('id', workbookId).maybeSingle()
  const row = data as { accounting_category?: string | null; batch_id?: string | null; source_row_count?: number | null } | null
  let month: string | null = null
  if (row?.batch_id) {
    const { data: b } = await db.from('invoice_batches').select('period_start').eq('id', row.batch_id).maybeSingle()
    month = monthLabel((b as { period_start?: string | null } | null)?.period_start ?? null)
  }
  return { category: row?.accounting_category ?? null, month, rowCount: row?.source_row_count ?? null }
}

/**
 * Send every workbook the owner is currently owed. Called from the inbound
 * webhook with the sender's HMAC and live wa_id. Opportunistically backfills any
 of the workspace's still-'ready' legacy workbooks that predate the outbox (never
 * one already 'sent'), then atomically claims due rows and delivers each. Returns
 * how many landed. NEVER throws — a failure here must not disturb the reply the
 * owner just triggered; the rows stay pending/failed for a later inbound or the
 * worker recovery sweep.
 */
export async function flushPendingDeliveries(db: Db, senderHmac: string, to: string): Promise<number> {
  try {
    // Legacy recovery: enqueue any still-'ready' workspace workbook with no row.
    const workspaceId = await workspaceForSender(db, senderHmac)
    if (workspaceId) await backfillMissingDeliveries(db, workspaceId, senderHmac)

    const claimed = await claimDueDeliveries(db, senderHmac, DELIVERY_PAGE, DELIVERY_LEASE_SECONDS)
    let delivered = 0
    for (const d of claimed) {
      const { category, month, rowCount } = await loadCaptionFields(db, d.workbook_id)
      const monthPart = month ? ` for ${month}` : ''
      const countPart = rowCount && rowCount > 0 ? ` — ${rowCount} invoice(s)` : ''
      const caption = `Your ${categoryLabel(category)} register${monthPart} is ready${countPart}. I have attached the Excel file here in this chat.`

      const r = await deliverWorkbookToWhatsApp(db, {
        workbookId: d.workbook_id, to, caption, expectedWorkspaceId: d.workspace_id,
      })

      if (r.delivered) {
        // Fence-checked: only settles if WE still own the claim. A lost fence means
        // a newer claimer took over — leave it to them, do not double-write.
        const settled = await markDeliverySent(db, d.id, d.claim_token, r.providerMessageId ?? null)
        if (settled) {
          delivered += 1
          logger.info('[Deliver] outbox delivery sent', {
            deliveryId: d.id, workbookId: d.workbook_id, workspaceId: d.workspace_id,
            category, attempt: d.attempt_count, providerMessageId: r.providerMessageId ?? null,
            transition: 'sending->sent',
          })
        } else {
          logger.warn('[Deliver] outbox settle fenced (another claim owns it now)', { deliveryId: d.id, workbookId: d.workbook_id })
        }
        continue
      }
      if (r.outcome === 'transient') {
        await releaseDelivery(db, d.id, d.claim_token, TRANSIENT_RETRY_SECONDS, 'SEND_TRANSIENT')
        logger.warn('[Deliver] outbox send transient; will retry', { deliveryId: d.id, workbookId: d.workbook_id, attempt: d.attempt_count, transition: 'sending->failed' })
        continue
      }
      if (r.outcome === 'blocked') {
        // Credential-level: a retry cannot help until the operator reissues the
        // token. Park as 'failed' with a LONG backoff so it does not hammer Meta.
        await releaseDelivery(db, d.id, d.claim_token, BLOCKED_RETRY_SECONDS, 'SEND_BLOCKED')
        logger.error('[Deliver] outbox send blocked (credential); deferring far', { deliveryId: d.id, workbookId: d.workbook_id, transition: 'sending->failed' })
        continue
      }
      // 'skipped': the workbook is gone/expired/superseded or tenant-mismatched —
      // there is nothing to (safely) send. Park as 'unknown' for reconciliation and
      // NEVER auto-resent. The current register for that scope has its own row.
      await resolveDelivery(db, d.id, d.claim_token, 'unknown')
      logger.warn('[Deliver] outbox delivery not servable; parked as unknown', { deliveryId: d.id, workbookId: d.workbook_id, outcome: r.outcome, transition: 'sending->unknown' })
    }
    return delivered
  } catch (e) {
    // Pre-migration the claim RPC is absent; the legacy token path + Done/Review
    // sweep still deliver. Log at most a code — never a token/PII.
    logger.info('[Deliver] outbox flush skipped', { error: e instanceof Error ? e.message.slice(0, 120) : 'unknown' })
    return 0
  }
}
