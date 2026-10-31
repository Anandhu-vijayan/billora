// lib/whatsapp/delivery-outbox.ts — the durable, atomically-claimed source of
// truth for "what still owes the owner a workbook". It replaces the racy single
// `whatsapp_sessions.pending_reply_body` token slot (whose lost-update race during
// a cross-month Approve All silently dropped one month's file). Backs the
// `workbook_deliveries` table + its claim RPCs (migration 20261030000000).
//
// Every function is service-role and logs ONLY the recipient HMAC / a safe id —
// never a phone number, never a claim secret, never decrypted content.
import type { SupabaseClient } from '@supabase/supabase-js'

type Db = SupabaseClient

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown'

/** The delivery lifecycle, mirroring the DB CHECK on workbook_deliveries.status. */
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['pending', 'sending', 'sent', 'failed', 'unknown']

/** A delivery row freshly claimed by THIS caller, safe to send under its fence. */
export type ClaimedDelivery = {
  id: string
  workbook_id: string
  workspace_id: string
  recipient_sender_hmac: string
  claim_token: string
  attempt_count: number
  status: DeliveryStatus
}

/**
 * Idempotently record that `workbookId` still owes `recipientSenderHmac` a file.
 * The unique (workspace, workbook, recipient) key makes a rebuild/re-enqueue a
 * no-op, so a generation can never fork two rows for one file and an already
 * 'sent' row is never reopened. Returns false when the write is rejected (e.g.
 * the outbox migration is not yet applied) so the caller can log a deferral — a
 * 'ready' workbook is never lost: the Done/Review ready-sweep and the post-push
 * legacy backfill still get it out.
 */
export async function enqueueWorkbookDelivery(
  db: Db,
  input: { workspaceId: string; workbookId: string; recipientSenderHmac: string },
): Promise<boolean> {
  const { error } = await db.from('workbook_deliveries').upsert({
    workspace_id: input.workspaceId,
    workbook_id: input.workbookId,
    recipient_sender_hmac: input.recipientSenderHmac,
    status: 'pending',
    next_attempt_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,workbook_id,recipient_sender_hmac', ignoreDuplicates: true })
  return !error
}

/**
 * Atomically claim up to `limit` due deliveries for ONE recipient. The RPC runs
 * FOR UPDATE SKIP LOCKED, so a concurrent worker/restart can never claim the same
 * row twice, and only THIS caller receives the claim_token to send under. Throws
 * on a real DB error (the caller backoffs); an unapplied migration surfaces as an
 * error the delivery tick logs without losing any row.
 */
export async function claimDueDeliveries(
  db: Db, recipientSenderHmac: string, limit = 5, leaseSeconds = 120,
): Promise<ClaimedDelivery[]> {
  const { data, error } = await db.rpc('claim_workbook_deliveries', {
    p_recipient_sender_hmac: recipientSenderHmac,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  })
  if (error) throw new Error(`DELIVERY_CLAIM_ERROR: ${error.message}`)
  return (data ?? []) as ClaimedDelivery[]
}

/** Confirm a send as 'sent'. Only the current claim_token holder settles a row. */
export async function markDeliverySent(
  db: Db, id: string, claimToken: string, providerMessageId: string | null,
): Promise<boolean> {
  const { data, error } = await db.rpc('mark_workbook_delivery_sent', {
    p_id: id, p_claim_token: claimToken, p_provider_message_id: providerMessageId,
  })
  if (error) throw new Error(`DELIVERY_MARK_ERROR: ${error.message}`)
  return data === true
}

/** Release a transiently-failed send back to 'failed' with a safe retry delay. */
export async function releaseDelivery(
  db: Db, id: string, claimToken: string, retrySeconds: number, lastError: string | null,
): Promise<boolean> {
  const { data, error } = await db.rpc('release_workbook_delivery', {
    p_id: id, p_claim_token: claimToken, p_retry_seconds: retrySeconds, p_last_error: lastError,
  })
  if (error) throw new Error(`DELIVERY_RELEASE_ERROR: ${error.message}`)
  return data === true
}

/**
 * Move an UNCERTAIN send to an explicit final state. Used when a network failure
 * leaves it unknown whether Meta accepted the send: 'unknown' parks it for
 * reconciliation and is NEVER auto-resent (a stale worker without the fence
 * simply no-ops). Only the claim_token holder can settle the row.
 */
export async function resolveDelivery(
  db: Db, id: string, claimToken: string, finalState: 'unknown' | 'sent' | 'failed',
): Promise<boolean> {
  const { data, error } = await db.rpc('resolve_workbook_delivery', {
    p_id: id, p_claim_token: claimToken, p_final_state: finalState,
  })
  if (error) throw new Error(`DELIVERY_RESOLVE_ERROR: ${error.message}`)
  return data === true
}

/** Recovery: sweep lapsed 'sending' leases to 'unknown'. 0 if migration absent. */
export async function recoverExpiredDeliveryLeases(db: Db): Promise<number> {
  const { data, error } = await db.rpc('recover_expired_delivery_leases', {})
  if (error) return 0
  return (data as number | null) ?? 0
}

/** Legacy backfill: enqueue pending rows for a workspace's still-ready files. */
export async function backfillMissingDeliveries(
  db: Db, workspaceId: string, recipientSenderHmac: string,
): Promise<number> {
  const { data, error } = await db.rpc('backfill_missing_deliveries', {
    p_workspace_id: workspaceId, p_recipient_sender_hmac: recipientSenderHmac,
  })
  if (error) return 0
  return (data as number | null) ?? 0
}
