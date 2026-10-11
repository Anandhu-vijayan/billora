// lib/whatsapp/verify.ts — webhook authenticity helpers (server only, pure).
import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Validate Meta's X-Hub-Signature-256 header against the RAW request body.
 * Must run before JSON re-serialization: signature covers exact bytes.
 * Header format: "sha256=<64 hex>". Constant-time comparison.
 */
export function verifyWebhookSignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): boolean {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false
  const received = Buffer.from(header.slice('sha256='.length), 'utf8')
  const expected = Buffer.from(
    createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex'),
    'utf8',
  )
  if (received.length !== expected.length) return false
  return timingSafeEqual(received, expected)
}

/** Constant-time compare for the hub.verify_token handshake. */
export function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
