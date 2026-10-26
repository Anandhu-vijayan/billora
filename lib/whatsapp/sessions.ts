// lib/whatsapp/sessions.ts — server-side session/identity persistence (service-role only).
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { SESSION_TTL_MS, type ConversationState } from '@/lib/whatsapp/conversation'

/**
 * Classifies a PostgREST/Postgres error for ops triage so logs distinguish a
 * missing migration (table/column) from permission, constraint, auth, schema-cache,
 * or connection problems. Codes: 42P01 relation, 42703 column, 42501 grants,
 * 23xxx constraints, PGRST205 table absent from PostgREST cache, PGRST301 JWT.
 */
export function classifyDbError(code: string | undefined, message: string | undefined): string {
  const c = code ?? ''
  const m = message ?? ''
  if (c === '42P01' || /relation .* does not exist/i.test(m)) return 'missing_relation'
  if (c === '42703' || /column .* does not exist/i.test(m)) return 'missing_column'
  if (c === 'PGRST205' || /schema cache/i.test(m)) return 'table_not_exposed_or_stale_cache'
  if (c === '42501' || /permission denied/i.test(m)) return 'permission_denied'
  if (c.startsWith('23')) return 'constraint_violation'
  if (/jwt|apikey|PGRST301/i.test(m) || c === 'PGRST301') return 'auth'
  if (/fetch failed|network|econnrefused|timeout/i.test(m)) return 'connection'
  return 'other'
}

/**
 * Safe DB error fields for logging. Long hex runs (HMACs/keys) and long digit
 * runs (phone numbers) are redacted because Postgres DETAIL for constraint
 * violations includes column values, e.g. "Key (sender_hmac)=(<64 hex>)".
 * Never log the sender's phone, HMAC, body, or credentials.
 */
function safeDbFields(error: { code?: string; message?: string; details?: string; hint?: string }) {
  const scrub = (v: string | undefined): string | null =>
    v
      ? v
          .replace(/[0-9a-f]{32,}/gi, '[redacted-hex]')
          .replace(/\d{8,}/g, '[redacted-num]')
          .slice(0, 500)
      : null
  return {
    code: error.code ?? null,
    message: scrub(error.message),
    details: scrub(error.details),
    hint: scrub(error.hint),
  }
}

export interface DbSession {
  sender_hmac: string
  state: ConversationState
  workspace_id: string | null
  client_id: string | null
  batch_id: string | null
  pending_client_id: string | null
  // The invoice the reviewer is currently correcting in the in-chat editor.
  // Set when they tap "Edit"; cleared when the edit sub-state is exited. Like
  // pending_client_id, this persisted target survives a restart / webhook retry.
  review_edit_invoice_id: string | null
  last_provider_message_id: string | null
  // Stage 2 — outbound delivery decoupled from inbound idempotency. A failed
  // (transient) reply is remembered here and best-effort resent on the sender's
  // NEXT inbound message, WITHOUT re-running any completed business operation.
  last_reply_error_code: string | null
  pending_reply_body: string | null
  // Suppress repetitive "Invoice received…" acks: set once per session after the
  // first successful filing acknowledgment.
  upload_ack_sent_at: string | null
  updated_at: string
}

/** Load-or-create identity + session. First touch wins the race via unique PK. */
export async function loadSession(db: SupabaseClient, senderHmac: string): Promise<DbSession> {
  const { error: identityError } = await db
    .from('whatsapp_identities')
    .upsert({ sender_hmac: senderHmac }, { onConflict: 'sender_hmac' })
  if (identityError) {
    logger.error('[WhatsApp] identity upsert failed', {
      kind: classifyDbError(identityError.code, identityError.message),
      ...safeDbFields(identityError),
    })
    throw new Error(`IDENTITY_UPSERT_ERROR: ${identityError.message}`)
  }
  const { data, error } = await db.from('whatsapp_sessions').select('*').eq('sender_hmac', senderHmac).maybeSingle()
  if (error) {
    logger.error('[WhatsApp] session load failed', {
      kind: classifyDbError(error.code, error.message),
      ...safeDbFields(error),
    })
    throw new Error(`SESSION_LOAD_ERROR: ${error.message}`)
  }
  if (data) return data as DbSession
  const { data: created, error: insertError } = await db
    .from('whatsapp_sessions')
    .insert({ sender_hmac: senderHmac, state: 'new' })
    .select('*')
    .single()
  if (insertError) {
    // Lost the race: re-read the winner's row.
    const retry = await db.from('whatsapp_sessions').select('*').eq('sender_hmac', senderHmac).maybeSingle()
    if (retry.data) return retry.data as DbSession
    logger.error('[WhatsApp] session create failed', {
      kind: classifyDbError(insertError.code, insertError.message),
      ...safeDbFields(insertError),
    })
    throw new Error(`SESSION_CREATE_ERROR: ${insertError.message}`)
  }
  return created as DbSession
}

/** Account type of the sender's identity — drives the upload decision engine. */
export async function loadAccountType(db: SupabaseClient, senderHmac: string): Promise<string | null> {
  const { data, error } = await db
    .from('whatsapp_identities')
    .select('account_type')
    .eq('sender_hmac', senderHmac)
    .maybeSingle()
  if (error) {
    logger.error('[WhatsApp] identity read failed', {
      kind: classifyDbError(error.code, error.message),
      ...safeDbFields(error),
    })
    throw new Error(`IDENTITY_READ_ERROR: ${error.message}`)
  }
  return (data?.account_type as string | undefined) ?? null
}

/**
 * True when PostgREST rejected an update because the additive review-edit column
 * is not in its schema cache yet — i.e. migration 20261025000000_review_edit has
 * been written but not applied. Detected narrowly (this column + a schema-cache /
 * PGRST204 signal) so a genuine error is never swallowed.
 */
function isMissingReviewEditColumn(error: { code?: string; message?: string }): boolean {
  const m = error.message ?? ''
  const schemaCacheMiss = error.code === 'PGRST204' || /schema cache/i.test(m)
  return schemaCacheMiss && /review_edit_invoice_id/.test(m)
}

/** Conditional persist: only advances if no newer message already moved the row. */
export async function saveSession(
  db: SupabaseClient,
  senderHmac: string,
  expectedLastId: string | null,
  patch: {
    state: ConversationState
    workspace_id?: string | null
    client_id?: string | null
    batch_id?: string | null
    pending_client_id?: string | null
    review_edit_invoice_id?: string | null
    last_provider_message_id: string
    expires_at?: string | null
  },
): Promise<boolean> {
  const { review_edit_invoice_id, ...base } = patch
  const runUpdate = (body: Record<string, unknown>) => {
    let query = db
      .from('whatsapp_sessions')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('sender_hmac', senderHmac)
    query = expectedLastId
      ? query.eq('last_provider_message_id', expectedLastId)
      : query.is('last_provider_message_id', null)
    return query.select('sender_hmac')
  }
  // Reference the editor column ONLY when there is an actual pointer to store. An
  // ordinary (non-editor) turn carries null, so it never touches the possibly
  // not-yet-migrated column and cannot fail on a schema the migration has not
  // reached — this keeps greet/done/menu/collecting persistence alive pre-migration.
  const wantsEditColumn = review_edit_invoice_id !== undefined && review_edit_invoice_id !== null
  let { data, error } = await runUpdate(wantsEditColumn ? { ...base, review_edit_invoice_id } : base)
  if (error && wantsEditColumn && isMissingReviewEditColumn(error)) {
    // The additive migration is pending: persist the session WITHOUT the editor
    // pointer rather than 503-looping the whole conversation. The in-chat editor
    // cannot remember its target across turns until the migration is applied, but
    // every other flow — and the state machine itself — keeps working.
    logger.warn('[WhatsApp] review_edit_invoice_id absent from schema; saved session without editor pointer (apply migration 20261025000000_review_edit)', {
      kind: classifyDbError(error.code, error.message),
      ...safeDbFields(error),
    })
    ;({ data, error } = await runUpdate(base))
  }
  if (error) {
    logger.error('[WhatsApp] session save failed', {
      kind: classifyDbError(error.code, error.message),
      ...safeDbFields(error),
    })
    throw new Error(`SESSION_SAVE_ERROR: ${error.message}`)
  }
  return (data?.length ?? 0) > 0
}

export function isExpired(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > SESSION_TTL_MS
}

/**
 * Unconditional field update (not the guarded onboarding advance). Used for
 * delivery bookkeeping only: a lost race here never rewinds conversation state
 * or re-triggers intake (rule 5), so we don't gate it on last_provider_message_id.
 */
export async function updateSessionDeliveryState(
  db: SupabaseClient,
  senderHmac: string,
  patch: {
    last_reply_error_code?: string | null
    pending_reply_body?: string | null
    upload_ack_sent_at?: string | null
  },
): Promise<boolean> {
  const { error } = await db.from('whatsapp_sessions').update(patch).eq('sender_hmac', senderHmac)
  if (error) {
    logger.error('[WhatsApp] delivery-state update failed', {
      kind: classifyDbError(error.code, error.message), ...safeDbFields(error),
    })
    return false
  }
  return true
}

/**
 * Race-safe "claim the next upload acknowledgment" for a sender, so a burst of
 * files uploaded together yields ONE confirmation, not one per file. Each file
 * arrives as its own near-simultaneous webhook, and a plain session read lets
 * every worker see a null/stale `upload_ack_sent_at` and all of them ack. A single
 * conditional UPDATE is atomic at the row level (Postgres re-checks the predicate
 * under the row lock), so ONLY the worker whose write actually flips the slot wins
 * and may send; the rest get zero affected rows and stay silent. The slot re-arms
 * once it is older than `windowMs`, so a genuinely later batch still gets exactly
 * one ack. Fails quiet on error — one missing ack beats a burst of nags.
 */
export async function claimUploadAck(
  db: SupabaseClient,
  senderHmac: string,
  windowMs: number,
): Promise<boolean> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - Math.max(0, windowMs)).toISOString()
  const { data, error } = await db
    .from('whatsapp_sessions')
    .update({ upload_ack_sent_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('sender_hmac', senderHmac)
    .or(`upload_ack_sent_at.is.null,upload_ack_sent_at.lt.${cutoff}`)
    .select('sender_hmac')
  if (error) {
    logger.error('[WhatsApp] upload-ack claim failed', {
      kind: classifyDbError(error.code, error.message), ...safeDbFields(error),
    })
    return false
  }
  return (data?.length ?? 0) > 0
}

/**
 * Expired conversations restart at `new`, but setup is NOT repeated: the
 * workspace/client/batch linkage survives expiry (returning-user rule). The
 * route backfills from the identity row if the session itself is brand new.
 */
export function expiredSnapshot(s: DbSession, senderHmac: string) {
  return {
    senderHmac,
    state: 'new' as ConversationState,
    workspaceId: s.workspace_id,
    clientId: s.client_id,
    batchId: s.batch_id,
    pendingClientId: s.pending_client_id ?? null,
    reviewEditInvoiceId: s.review_edit_invoice_id ?? null,
    lastProviderMessageId: s.last_provider_message_id,
    expired: true,
  }
}
