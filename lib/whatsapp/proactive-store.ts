// lib/whatsapp/proactive-store.ts — encrypted wa_id custody for opt-in delivery (§P1-6).
//
// This is the ONLY place the raw phone number is ever persisted, and only when
// the owner has explicitly opted in AND the operator has configured the SEPARATE
// WHATSAPP_PROACTIVE_KEY. It reuses the proven AES-256-GCM envelope (the same
// primitive as invoice payloads) but under a DIFFERENT key, and:
//   * is scoped by sender_hmac (the session's own row) — never cross-sender;
//   * is migration-safe: reads use select('*') and writes detect the schema-cache
//     miss so an unapplied migration degrades softly instead of 503-looping chat;
//   * NEVER logs the phone, the sealed bytes, or the key — only a bounded kind.
//
// Opting OUT clears BOTH the consent flag and the sealed value (a delete), so no
// residue of the phone remains once the owner withdraws consent.
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptExtractedPayload, decryptExtractedPayload } from '@/lib/encryption'
import { logger } from '@/lib/logger'
import { proactiveKeyConfigured } from './proactive'

type Db = SupabaseClient

const HEX_64 = /^[0-9a-f]{64}$/i

/** The sealing key, or null when the separate proactive key is absent/misconfigured. */
export function resolveProactiveKeyHex(env: Record<string, string | undefined> = process.env): string | null {
  const k = env.WHATSAPP_PROACTIVE_KEY ?? ''
  return HEX_64.test(k) ? k : null
}

/** PostgREST renders bytea as a `\x`-prefixed hex string (same convention as intake). */
function byteaToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/i, ''), 'hex')
  throw new Error('BYTEA_DECODE_ERROR')
}

export type ProactiveConsentResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_MIGRATED' | 'NO_KEY' | 'NOT_FOUND' | 'FAULT' }

function isMissingProactiveColumn(error: { code?: string; message?: string }): boolean {
  const m = error.message ?? ''
  return (error.code === 'PGRST204' || /schema cache/i.test(m))
    && /proactive_consent|wa_id_encrypted/.test(m)
}

/**
 * Record the owner's proactive opt-in/opt-out for THIS sender row.
 *  - enabled=true  → seals `waId` under the proactive key and sets consent.
 *  - enabled=false → clears consent AND nulls the sealed value (a delete).
 * The write is keyed only by sender_hmac, so it can never touch another sender.
 */
export async function setProactiveConsent(
  db: Db,
  senderHmac: string,
  args: { enabled: boolean; waId: string | null; env?: Record<string, string | undefined> },
): Promise<ProactiveConsentResult> {
  const env = args.env ?? process.env
  let sealed: Buffer | null = null
  if (args.enabled) {
    if (!proactiveKeyConfigured(env)) return { ok: false, reason: 'NO_KEY' }
    if (!args.waId) return { ok: false, reason: 'NO_KEY' }
    const key = resolveProactiveKeyHex(env)
    if (!key) return { ok: false, reason: 'NO_KEY' }
    sealed = encryptExtractedPayload(args.waId.trim(), key)
  }
  const patch = { proactive_consent: args.enabled, wa_id_encrypted: sealed }
  const { data, error } = await db
    .from('whatsapp_sessions')
    .update(patch)
    .eq('sender_hmac', senderHmac)
    .select('sender_hmac')
  if (error) {
    if (isMissingProactiveColumn(error)) {
      logger.warn('[Proactive] consent columns absent from schema; opt-in saved as a no-op (apply migration 20261026000001_proactive_delivery)')
      return { ok: false, reason: 'NOT_MIGRATED' }
    }
    logger.error('[Proactive] consent write failed', { code: error.code ?? null })
    return { ok: false, reason: 'FAULT' }
  }
  if (!data || data.length === 0) return { ok: false, reason: 'NOT_FOUND' }
  return { ok: true }
}

export interface ProactiveIdentity {
  consent: boolean
  /** sealed wa_id bytes, or null when none is stored. */
  sealed: Buffer | null
  /** last activity (session updated_at) in epoch ms, or null. */
  lastActivityMs: number | null
}

/**
 * Read this sender's proactive state. select('*') so an unapplied migration never
 * raises here; absent columns read as consent=false / sealed=null.
 */
export async function loadProactiveIdentity(db: Db, senderHmac: string): Promise<ProactiveIdentity | null> {
  const { data, error } = await db
    .from('whatsapp_sessions').select('*')
    .eq('sender_hmac', senderHmac).maybeSingle()
  if (error) {
    logger.error('[Proactive] identity read failed', { code: error.code ?? null })
    return null
  }
  if (!data) return null
  const row = data as { proactive_consent?: boolean | null; wa_id_encrypted?: unknown; updated_at?: string | null }
  let sealed: Buffer | null = null
  if (row.wa_id_encrypted) {
    try { sealed = byteaToBuffer(row.wa_id_encrypted) } catch { sealed = null }
  }
  const updatedMs = row.updated_at ? new Date(row.updated_at).getTime() : null
  return {
    consent: row.proactive_consent === true,
    sealed,
    lastActivityMs: updatedMs != null && Number.isFinite(updatedMs) ? updatedMs : null,
  }
}

/**
 * Open a sealed wa_id back to the phone for an in-window proactive send. Returns
 * null on ANY failure (no key, corrupt, wrong key version) — the caller then falls
 * back to next-inbound delivery. The phone is NEVER logged on any path.
 */
export function openWaId(sealed: Buffer | null, env: Record<string, string | undefined> = process.env): string | null {
  if (!sealed) return null
  const key = resolveProactiveKeyHex(env)
  if (!key) return null
  try {
    const plain = decryptExtractedPayload(sealed, key).trim()
    return plain.length > 0 ? plain : null
  } catch {
    return null
  }
}
