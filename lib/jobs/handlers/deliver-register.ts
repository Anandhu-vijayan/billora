// lib/jobs/handlers/deliver-register.ts — the delivery CONSUMER.
//
// Generation (build-register) only records durable, independent outbox rows; THIS
// module is the only place those rows turn into an actual WhatsApp send. It is
// driven from the owner's inbound webhook (the one moment we hold a live `to`
// wa_id to reply on), from the register handler itself when a build finishes while
// the owner is in-window and opted in, and from the worker tick — and is fully
// decoupled from generation: a send that fails leaves the workbook 'ready' and the
// row retryable, and a workbook is NEVER lost because a send had trouble. Backs
// the workbook_deliveries state machine (migration 20261030000000) via
// lib/whatsapp/delivery-outbox.
//
// Concurrency safety comes entirely from the atomic claim RPC: only the caller
// whose claim_token matches may settle a row, and FOR UPDATE SKIP LOCKED means no
// two senders ever work the same row. An uncertain outcome parks as 'unknown' and
// is never blindly resent.
//
// §one-file-per-month (the register-spam fix): a cumulative register is REBUILT
// after every single approval, so one upload burst publishes several versions of
// the same month. Shipping each one buried the owner in 4-5 copies of their own
// October file. Two rules now stop that: (1) while the workspace still has live
// queue work, nothing is sent at all — the owner gets the FINISHED register, once
// (with a bounded override so a stuck job can never strand a completed file); and
// (2) when several owed rows cover the same (batch, category), only the NEWEST
// version is sent and the older ones are parked as superseded.
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { monthLabel } from '@/lib/exports/naming'
import { deliverWorkbookToWhatsApp } from '@/lib/exports/deliver'
import { canProactivelyPush } from '@/lib/whatsapp/proactive'
import { loadProactiveIdentity, openWaId } from '@/lib/whatsapp/proactive-store'
// The pure half of the spam fix lives where it can be unit-tested in process
// (no logger / Supabase / env), so this consumer exercises the REAL rule, not a copy.
import { errorNote, newestPerScope, type DeliveryScopeFields } from '@/lib/jobs/handlers/delivery-coalesce'
import {
  claimDueDeliveries, markDeliverySent, releaseDelivery, resolveDelivery,
  backfillMissingDeliveries,
} from '@/lib/whatsapp/delivery-outbox'

type Db = SupabaseClient

/** Lease long enough for one media upload + document send, short enough to recover fast. */
const DELIVERY_LEASE_SECONDS = 120
/** How many owed files to hand to one owner per touch (bounded like the old flow). */
const DELIVERY_PAGE = 5
/** Transient send → a short, safe retry delay. */
const TRANSIENT_RETRY_SECONDS = 60
// A 'blocked' send used to park for an hour. In the field the token was demonstrably
// fine (the text reply in the same minute landed) while the DOCUMENT path was
// rejected — Meta temporarily throttles/blocks rapid media uploads to one number,
// which is exactly what shipping five copies of a register does. An hour of silence
// on the owner's own file is worse than a gentle retry, so a blocked row now backs
// off for 5 minutes; the quiescence gate above means we no longer hammer anyway.
const BLOCKED_RETRY_SECONDS = 300
/**
 * How long a completed register may be held back because the workspace still has
 * live queue work. Beyond it we deliver whatever is live: a stuck or retry-looping
 * job must never strand a finished file, and one late file is better than none.
 */
const DELIVERY_SUPPRESS_MAX_MS = 10 * 60 * 1000

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

/**
 * Read the light fields a send needs: the caption copy AND the coalescing key
 * (batch + category + version). Never any row value or PII.
 */
async function loadDeliveryFields(db: Db, workbookId: string): Promise<{
  category: string | null; month: string | null; rowCount: number | null
  batchId: string | null; version: number | null
}> {
  const { data } = await db
    .from('generated_workbooks').select('accounting_category,batch_id,source_row_count,version')
    .eq('id', workbookId).maybeSingle()
  const row = data as {
    accounting_category?: string | null; batch_id?: string | null
    source_row_count?: number | null; version?: number | null
  } | null
  let month: string | null = null
  if (row?.batch_id) {
    const { data: b } = await db.from('invoice_batches').select('period_start').eq('id', row.batch_id).maybeSingle()
    month = monthLabel((b as { period_start?: string | null } | null)?.period_start ?? null)
  }
  return {
    category: row?.accounting_category ?? null, month,
    rowCount: row?.source_row_count ?? null,
    batchId: row?.batch_id ?? null, version: row?.version ?? null,
  }
}

/**
 * §quiescence: does this workspace still have extraction or register work in
 * flight? While it does, a delivered register is by definition incomplete — the
 * owner would receive a 2-invoice file, then a 3-invoice one, then the real thing.
 * A read failure answers NO work (fail-open toward delivering): an owner waiting
 * for a finished file must not be silenced because a count query hiccupped, and
 * the per-scope newest-version rule still prevents a stale copy from going out.
 */
async function hasOutstandingWork(db: Db, workspaceId: string): Promise<boolean> {
  const { count, error } = await db
    .from('processing_jobs').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).in('status', ['queued', 'processing'])
  if (error) return false
  return (count ?? 0) > 0
}

/**
 * How long the OLDEST owed row for this owner has been waiting. Used only as the
 * bounded override on the quiescence gate. A read failure reports 'waiting forever'
 * (0 ms is the suppress-safe direction, so we return Infinity to force delivery).
 */
async function oldestWaitMs(db: Db, senderHmac: string): Promise<number> {
  const { data, error } = await db
    .from('workbook_deliveries').select('created_at')
    .eq('recipient_sender_hmac', senderHmac).eq('status', 'pending')
    .order('created_at', { ascending: true }).limit(1)
  if (error) return Number.POSITIVE_INFINITY
  const created = (data ?? [])[0]?.created_at as string | undefined
  if (!created) return Number.POSITIVE_INFINITY
  const age = Date.now() - new Date(created).getTime()
  return Number.isFinite(age) && age >= 0 ? age : Number.POSITIVE_INFINITY
}

/**
 * Send every workbook the owner is currently owed. Called from the inbound
 * webhook (sender HMAC + live wa_id), from the completion push below, and from the
 * worker sweep. Opportunistically backfills any of the workspace's still-'ready'
 * legacy workbooks that predate the outbox (never one already 'sent'), claims due
 * rows atomically and delivers each. Returns how many landed. NEVER throws — a
 * failure here must not disturb the reply the owner just triggered; the rows stay
 * pending/failed for a later touch.
 */
export async function flushPendingDeliveries(db: Db, senderHmac: string, to: string): Promise<number> {
  try {
    const workspaceId = await workspaceForSender(db, senderHmac)

    // §quiescence gate: while the owner's workspace still has queue work in
    // flight, an intermediate register is NOT worth a chat message. Hold it; the
    // finished file goes out the moment the last job settles (completion push,
    // then the next inbound as the backstop). Bounded so a stuck job cannot strand
    // a completed register forever.
    if (workspaceId && await hasOutstandingWork(db, workspaceId)) {
      const waitedMs = await oldestWaitMs(db, senderHmac)
      if (waitedMs < DELIVERY_SUPPRESS_MAX_MS) {
        logger.info('[Deliver] flush held while the workspace is still processing', {
          workspaceId, waitedSec: Math.round(waitedMs / 1000),
        })
        return 0
      }
      logger.warn('[Deliver] flush override: max hold exceeded; delivering the live register', { workspaceId })
    }

    // Legacy recovery: enqueue any still-'ready' workspace workbook with no row.
    if (workspaceId) await backfillMissingDeliveries(db, workspaceId, senderHmac)

    const claimed = await claimDueDeliveries(db, senderHmac, DELIVERY_PAGE, DELIVERY_LEASE_SECONDS)
    if (claimed.length === 0) return 0

    // One light read per claimed row: caption copy + the (batch, category, version)
    // coalescing key.
    const fields = new Map<string, DeliveryScopeFields>()
    const captionBy = new Map<string, { category: string | null; month: string | null; rowCount: number | null }>()
    for (const d of claimed) {
      const f = await loadDeliveryFields(db, d.workbook_id)
      fields.set(d.workbook_id, { batchId: f.batchId, category: f.category, version: f.version })
      captionBy.set(d.workbook_id, { category: f.category, month: f.month, rowCount: f.rowCount })
    }

    // §one-file-per-month: if this page owes the SAME month twice (v3 and v4 both
    // queued before anyone messaged), send only the newest and park the older.
    const { keep, superseded } = newestPerScope(claimed, fields)
    for (const d of superseded) {
      await resolveDelivery(db, d.id, d.claim_token, 'unknown')
      logger.info('[Deliver] superseded register not sent; parked as unknown', {
        deliveryId: d.id, workbookId: d.workbook_id, transition: 'sending->unknown',
      })
    }

    let delivered = 0
    for (const d of keep) {
      const c = captionBy.get(d.workbook_id) ?? { category: null, month: null, rowCount: null }
      const monthPart = c.month ? ` for ${c.month}` : ''
      const countPart = c.rowCount && c.rowCount > 0 ? ` — ${c.rowCount} invoice(s)` : ''
      const caption = `Your ${categoryLabel(c.category)} register${monthPart} is ready${countPart}. I have attached the Excel file here in this chat.`

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
            category: c.category, attempt: d.attempt_count, providerMessageId: r.providerMessageId ?? null,
            transition: 'sending->sent',
          })
        } else {
          logger.warn('[Deliver] outbox settle fenced (another claim owns it now)', { deliveryId: d.id, workbookId: d.workbook_id })
        }
        continue
      }
      if (r.outcome === 'transient') {
        await releaseDelivery(db, d.id, d.claim_token, TRANSIENT_RETRY_SECONDS, errorNote('SEND_TRANSIENT', r.providerDetail))
        logger.warn('[Deliver] outbox send transient; will retry', { deliveryId: d.id, workbookId: d.workbook_id, attempt: d.attempt_count, transition: 'sending->failed' })
        continue
      }
      if (r.outcome === 'blocked') {
        // Meta rejected this send at the credential/media layer. Park 'failed' with
        // a SHORT-but-gentle backoff and record WHY, so the owner's own file is not
        // silenced for an hour when the fault was a temporary media throttle — and so
        // the DB row itself distinguishes that from a genuinely dead token.
        await releaseDelivery(db, d.id, d.claim_token, BLOCKED_RETRY_SECONDS, errorNote('SEND_BLOCKED', r.providerDetail))
        logger.error('[Deliver] outbox send blocked; backing off', { deliveryId: d.id, workbookId: d.workbook_id, detail: errorNote('SEND_BLOCKED', r.providerDetail), transition: 'sending->failed' })
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

/**
 * §completion push: hand the owner their finished register the moment the last
 * build settles, instead of waiting for them to message again. This is a
 * BUSINESS-INITIATED send, so it is allowed only through the sanctioned opt-in
 * path — the owner's explicit consent, the feature switch, the separate sealing
 * key and Meta's 24-hour window (canProactivelyPush) — and only once the
 * workspace has no live queue work left (the same quiescence rule the flush
 * applies). Anything missing means we simply do nothing: the row stays owed and
 * the next inbound delivers it, exactly as before. NEVER throws.
 */
export async function pushReadyRegistersForWorkspace(db: Db, workspaceId: string): Promise<number> {
  try {
    if (await hasOutstandingWork(db, workspaceId)) return 0
    const { data: identity } = await db.from('whatsapp_identities').select('sender_hmac')
      .eq('workspace_id', workspaceId).limit(1)
    const senderHmac = (identity ?? [])[0]?.sender_hmac as string | undefined
    if (!senderHmac) return 0
    const id = await loadProactiveIdentity(db, senderHmac)
    if (!id || !canProactivelyPush({ consent: id.consent, lastActivityMs: id.lastActivityMs })) return 0
    const to = openWaId(id.sealed)
    if (!to) return 0
    const sent = await flushPendingDeliveries(db, senderHmac, to)
    if (sent > 0) logger.info('[Deliver] completion push delivered register without an inbound', { workspaceId, sent })
    return sent
  } catch (e) {
    logger.info('[Deliver] completion push skipped', { error: e instanceof Error ? e.message.slice(0, 120) : 'unknown' })
    return 0
  }
}

/**
 * §worker-tick sweep: retry what is owed even if the owner never messages again
 * (a blocked send backing off, a row enqueued while the owner was out of window,
 * a push that died mid-send). Only owners who opted into proactive delivery can
 * be reached unprompted, so consent is checked up front (one batched read) and
 * each recipient then goes through the same full gate as the completion push.
 * Bounded page per tick; NEVER throws.
 */
export async function sweepDueDeliveries(db: Db, limit = 5): Promise<number> {
  try {
    const { data: due, error } = await db
      .from('workbook_deliveries').select('recipient_sender_hmac')
      .in('status', ['pending', 'failed']).lte('next_attempt_at', new Date().toISOString())
      .order('next_attempt_at', { ascending: true }).limit(50)
    if (error || !due || due.length === 0) return 0
    const candidates = [...new Set(due.map((r) => r.recipient_sender_hmac as string))]
    // Fairness, in ONE batched read: a row owed to an owner who never opted in
    // stays pending with its original (oldest) next_attempt_at, so left unchecked
    // those unreachable recipients would occupy every sweep slot forever and
    // silently starve owners who DID opt in. Consent is a flag only — no phone,
    // no sealed value — and an unapplied migration (or any read fault) degrades
    // back to the unfiltered list rather than stopping all unprompted delivery.
    let recipients = candidates
    const { data: consented, error: consentErr } = await db
      .from('whatsapp_sessions').select('sender_hmac').in('sender_hmac', candidates).eq('proactive_consent', true)
    if (!consentErr && consented) {
      recipients = consented.map((r) => r.sender_hmac as string).filter((h) => candidates.includes(h))
    }
    recipients = recipients.slice(0, limit)
    let sent = 0
    for (const recipient of recipients) {
      const workspaceId = await workspaceForSender(db, recipient)
      if (!workspaceId) continue
      sent += await pushReadyRegistersForWorkspace(db, workspaceId)
    }
    return sent
  } catch (e) {
    logger.info('[Deliver] due-delivery sweep skipped', { error: e instanceof Error ? e.message.slice(0, 120) : 'unknown' })
    return 0
  }
}
