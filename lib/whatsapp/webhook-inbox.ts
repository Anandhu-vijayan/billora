import 'server-only'

import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptFile, encryptFile, resolveFileKeyConfig } from '@/lib/encryption/files'
import { logger } from '@/lib/logger'

type Db = SupabaseClient

export interface ReplayableWhatsAppMessage {
  id: string
  from?: string
  type?: string
  timestamp?: string
  text?: { body?: string }
  image?: { id?: string; mime_type?: string; caption?: string }
  document?: { id?: string; mime_type?: string; caption?: string; filename?: string }
  interactive?: {
    type?: string
    button_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string }
  }
}

const MAX_STORED_MESSAGE_BYTES = 48 * 1024
const REPLAY_TIMEOUT_MS = 45_000

function limitedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined
}

function normalizeMessage(message: ReplayableWhatsAppMessage): ReplayableWhatsAppMessage {
  const normalized: ReplayableWhatsAppMessage = {
    id: limitedString(message.id, 512) ?? '',
    from: limitedString(message.from, 64),
    type: limitedString(message.type, 32),
    timestamp: limitedString(message.timestamp, 32),
  }
  if (message.text) {
    normalized.text = { body: limitedString(message.text.body, 4096) }
  }
  for (const kind of ['image', 'document'] as const) {
    const media = message[kind]
    if (!media) continue
    normalized[kind] = {
      id: limitedString(media.id, 512),
      mime_type: limitedString(media.mime_type, 128),
      caption: limitedString(media.caption, 4096),
      ...(kind === 'document' && 'filename' in media
        ? { filename: limitedString(media.filename, 512) }
        : {}),
    }
  }
  if (message.interactive) {
    normalized.interactive = {
      type: limitedString(message.interactive.type, 32),
      ...(message.interactive.button_reply
        ? { button_reply: {
            id: limitedString(message.interactive.button_reply.id, 256),
            title: limitedString(message.interactive.button_reply.title, 256),
          } }
        : {}),
      ...(message.interactive.list_reply
        ? { list_reply: {
            id: limitedString(message.interactive.list_reply.id, 256),
            title: limitedString(message.interactive.list_reply.title, 256),
          } }
        : {}),
    }
  }
  if (!normalized.id) throw new Error('WEBHOOK_PAYLOAD_INVALID: missing provider message id')
  const serialized = JSON.stringify(normalized)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_MESSAGE_BYTES) {
    throw new Error('WEBHOOK_PAYLOAD_INVALID: normalized message exceeds storage limit')
  }
  return normalized
}

function payloadContext(providerMessageId: string): string {
  return `whatsapp-webhook:${providerMessageId}`
}

export async function storeReplayableWebhookMessage(
  db: Db,
  providerMessageId: string,
  message: ReplayableWhatsAppMessage,
): Promise<boolean> {
  const normalized = normalizeMessage(message)
  if (normalized.id !== providerMessageId) {
    throw new Error('WEBHOOK_PAYLOAD_INVALID: provider message id mismatch')
  }
  const { masterKeyHex } = resolveFileKeyConfig()
  const encrypted = encryptFile(
    Buffer.from(JSON.stringify(normalized), 'utf8'),
    masterKeyHex,
    { context: payloadContext(providerMessageId) },
  )
  const { data, error } = await db.rpc('store_whatsapp_webhook_payload', {
    p_provider_message_id: providerMessageId,
    p_payload_hex: encrypted.container.toString('hex'),
  })
  if (error) throw new Error(`WEBHOOK_PAYLOAD_STORE_ERROR: ${error.message}`)
  return data === true
}

interface ReplayRow {
  provider_message_id: string
  encrypted_payload_hex: string
  event_status: string
}

function appOrigin(): string {
  const raw = process.env.PUBLIC_APP_URL
  if (!raw) throw new Error('WEBHOOK_REPLAY_CONFIG: PUBLIC_APP_URL is required')
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('WEBHOOK_REPLAY_CONFIG: PUBLIC_APP_URL must be an origin without credentials or path')
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('WEBHOOK_REPLAY_CONFIG: production PUBLIC_APP_URL must use HTTPS')
  }
  return url.origin
}

export async function replayPendingWebhookMessages(
  db: Db,
  limit = 1,
): Promise<{ attempted: number; accepted: number; deferred: number }> {
  const { data, error } = await db.rpc('list_replayable_whatsapp_payloads', {
    p_limit: Math.min(Math.max(Math.trunc(limit), 1), 10),
  })
  if (error) throw new Error(`WEBHOOK_REPLAY_LIST_ERROR: ${error.message}`)
  const rows = (data ?? []) as ReplayRow[]
  if (rows.length === 0) return { attempted: 0, accepted: 0, deferred: 0 }

  const appSecret = process.env.WHATSAPP_APP_SECRET
  if (!appSecret) throw new Error('WEBHOOK_REPLAY_CONFIG: WHATSAPP_APP_SECRET is required')
  const endpoint = new URL('/api/whatsapp', appOrigin())
  const { masterKeyHex } = resolveFileKeyConfig()
  let accepted = 0
  let deferred = 0

  for (const row of rows) {
    try {
      const container = Buffer.from(row.encrypted_payload_hex, 'hex')
      const plaintext = decryptFile(container, masterKeyHex, {
        context: payloadContext(row.provider_message_id),
      })
      if (plaintext.length > MAX_STORED_MESSAGE_BYTES) {
        throw new Error('WEBHOOK_PAYLOAD_INVALID: decrypted message exceeds storage limit')
      }
      const message = JSON.parse(plaintext.toString('utf8')) as ReplayableWhatsAppMessage
      const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] })
      const signature = createHmac('sha256', appSecret).update(body, 'utf8').digest('hex')
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${signature}`,
        },
        body,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
      })
      if (!response.ok) {
        deferred += 1
        logger.warn('[WebhookInbox] replay deferred', {
          status: response.status,
          eventState: row.event_status,
        })
        continue
      }
      accepted += 1
    } catch (error) {
      deferred += 1
      logger.error('[WebhookInbox] replay failed', {
        eventState: row.event_status,
        errorType: error instanceof Error ? error.name : 'unknown',
        errorCode: error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN',
      })
    }
  }

  return { attempted: rows.length, accepted, deferred }
}

export async function purgeExpiredWebhookPayloads(db: Db): Promise<number> {
  const { data, error } = await db.rpc('purge_expired_whatsapp_payloads')
  if (error) throw new Error(`WEBHOOK_PAYLOAD_PURGE_ERROR: ${error.message}`)
  return Number(data ?? 0)
}
