// lib/whatsapp/identity.ts — privacy-preserving WhatsApp sender identity (keyed HMAC).
import { createHmac } from 'crypto'

/** HMAC-SHA256 of the normalized E.164 sender id. Never a plain/unsalted hash. */
export function senderHmac(senderId: string): string {
  const key = process.env.WHATSAPP_IDENTITY_HMAC_KEY || ''
  if (!key) throw new Error('IDENTITY_FAULT: WHATSAPP_IDENTITY_HMAC_KEY is not configured')
  const normalized = senderId.trim()
  if (!normalized) throw new Error('IDENTITY_FAULT: empty sender id')
  return createHmac('sha256', key).update(normalized).digest('hex')
}

/** Safe log label: truncated HMAC prefix, never the phone number. */
export function senderLabel(hmac: string): string {
  return `wa:${hmac.slice(0, 10)}`
}
