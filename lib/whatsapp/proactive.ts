// lib/whatsapp/proactive.ts — the OPT-IN proactive-delivery decision core (§P1-6).
//
// By default Billora only ever REPLIES within a customer service window: the raw
// phone number is never stored (identity is a one-way HMAC), and a completed
// register is handed to the owner on their NEXT inbound message. Proactive
// delivery is a deliberate, reversible exception to that privacy posture and is
// therefore gated three ways, ALL required before anything is pushed unprompted:
//   1. the operator turned the feature on  (WHATSAPP_PROACTIVE_DELIVERY=true), AND
//   2. a SEPARATE encryption key is configured (WHATSAPP_PROACTIVE_KEY, 64-hex) —
//      the wa_id is sealed under ITS OWN key, never the invoice master key, so a
//      leaked register key cannot unmask identities (and vice-versa), AND
//   3. the OWNER explicitly opted in AND their last inbound message is inside the
//      24-hour service window (WhatsApp only permits a free-form business message
//      there; outside it we fall back to the existing next-inbound queue).
//
// This module is pure and env-injected so the exact gating is unit-testable in
// process; it never touches crypto, the DB, the network, or the phone number, and
// none of its inputs are ever logged (the caller passes an already-sealed value).

/** Meta's customer-service window: a free-form business message must start here. */
export const PROACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000

type Env = Record<string, string | undefined>

/** Master switch. Anything other than the exact literal 'true' keeps it OFF. */
export function proactiveDeliveryEnabled(env: Env = process.env): boolean {
  return env.WHATSAPP_PROACTIVE_DELIVERY === 'true'
}

/** A well-formed (64-hex) SEPARATE key is present. Never logs the value. */
export function proactiveKeyConfigured(env: Env = process.env): boolean {
  return /^[0-9a-f]{64}$/i.test(env.WHATSAPP_PROACTIVE_KEY ?? '')
}

/** True while `lastActivityMs` is inside the 24h window of `nowMs` (and not future). */
export function isWithinProactiveWindow(lastActivityMs: number, nowMs: number): boolean {
  const age = nowMs - lastActivityMs
  return age >= 0 && age < PROACTIVE_WINDOW_MS
}

/**
 * The single, complete gate: may we push to this owner RIGHT NOW without a fresh
 * inbound? Requires feature-on + key-configured + owner consent + an in-window
 * last-activity timestamp. Any missing condition returns false and the caller
 * falls back to the safe next-inbound delivery (never a spurious or out-of-window
 * business-initiated message).
 */
export function canProactivelyPush(args: {
  consent: boolean
  lastActivityMs: number | null
  env?: Env
  nowMs?: number
}): boolean {
  const env = args.env ?? process.env
  const nowMs = args.nowMs ?? Date.now()
  if (!args.consent) return false
  if (!proactiveDeliveryEnabled(env)) return false
  if (!proactiveKeyConfigured(env)) return false
  if (args.lastActivityMs == null) return false
  return isWithinProactiveWindow(args.lastActivityMs, nowMs)
}
