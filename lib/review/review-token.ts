// lib/review/review-token.ts — the signed, expiring review-link primitive (§P1-8).
//
// A WhatsApp-only owner has no Supabase login, so the authenticated
// /api/invoices/[id]/review route is unreachable for them. This module is the
// OPTIONAL alternative: a stateless HMAC token that binds ONE invoice to ONE
// workspace for a bounded window, so a signed link can open a web review for that
// single invoice WITHOUT a session. It carries no PII and grants access to exactly
// one invoice — never a workspace dump.
//
// Design guarantees (all pure + env/secret-injected so they are unit-testable):
//   * the payload is signed with a DEDICATED secret (REVIEW_LINK_KEY), distinct from
//     every other key, so a leaked register/identity key cannot mint review links;
//   * the signature is compared in CONSTANT TIME, and any tamper is a single
//     BAD_SIGNATURE verdict (we never reveal which field changed);
//   * expiry is enforced against an injected clock, so a replayed link is refused
//     the instant its window closes;
//   * nothing here touches the DB, network or the review WRITE — the caller re-checks
//     tenant membership and runs the SAME shared applyInvoiceReview, so a link can
//     never bypass a validator.
import { createHmac, timingSafeEqual } from 'node:crypto'

const HEX_64 = /^[0-9a-f]{64}$/i
type Env = Record<string, string | undefined>

export const REVIEW_LINK_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
/** Hard ceiling so a misconfigured TTL can never mint a perpetual mutation link. */
export const REVIEW_LINK_MAX_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

/** Links are OFF unless the operator both enables them AND provides the key. */
export function reviewLinksEnabled(env: Env = process.env): boolean {
  return env.REVIEW_LINKS_ENABLED === 'true' && HEX_64.test(env.REVIEW_LINK_KEY ?? '')
}

/** Resolve the dedicated signing key, or null when links are not fully configured. */
export function resolveReviewLinkKey(env: Env = process.env): string | null {
  const k = env.REVIEW_LINK_KEY ?? ''
  return reviewLinksEnabled(env) ? k : null
}

/** Resolve the link lifetime in seconds, clamped to a safe range (never perpetual). */
export function reviewLinkTtlSeconds(env: Env = process.env): number {
  const raw = Number.parseInt(env.REVIEW_LINK_TTL_SECONDS ?? '', 10)
  const n = Number.isFinite(raw) && raw > 0 ? raw : REVIEW_LINK_DEFAULT_TTL_SECONDS
  return Math.min(n, REVIEW_LINK_MAX_TTL_SECONDS)
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64url(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    return null
  }
}

function sign(payload: string, secretHex: string): Buffer {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(payload).digest()
}

export interface ReviewTokenPayload {
  workspaceId: string
  invoiceId: string
  expiresAtMs: number
}

/** Mint a signed, expiring token for exactly one (workspace, invoice). */
export function signReviewToken(args: ReviewTokenPayload & { secretHex: string }): string {
  const payload = `${args.workspaceId}.${args.invoiceId}.${args.expiresAtMs}`
  const sig = b64url(sign(payload, args.secretHex))
  return `${b64url(Buffer.from(payload, 'utf8'))}.${sig}`
}

export type ReviewTokenResult =
  | { ok: true; workspaceId: string; invoiceId: string; expiresAtMs: number }
  | { ok: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'NO_KEY' }

/**
 * Verify a token against the dedicated key and an injected clock. Returns the bound
 * (workspaceId, invoiceId) ONLY on an all-clear; every failure is a stable reason
 * with no detail that would help an attacker probe the payload.
 */
export function verifyReviewToken(
  token: string | null | undefined,
  opts: { secretHex: string | null; nowMs: number },
): ReviewTokenResult {
  if (!opts.secretHex || !HEX_64.test(opts.secretHex)) return { ok: false, reason: 'NO_KEY' }
  const parts = (token ?? '').trim().split('.')
  if (parts.length !== 2) return { ok: false, reason: 'MALFORMED' }
  const payloadBuf = unb64url(parts[0])
  const sigBuf = unb64url(parts[1])
  if (!payloadBuf || !sigBuf) return { ok: false, reason: 'MALFORMED' }
  const payload = payloadBuf.toString('utf8')
  const expected = sign(payload, opts.secretHex)
  if (sigBuf.length !== expected.length || !timingSafeEqual(sigBuf, expected)) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }
  const seg = payload.split('.')
  if (seg.length !== 3) return { ok: false, reason: 'MALFORMED' }
  const [workspaceId, invoiceId, expStr] = seg
  const expiresAtMs = Number(expStr)
  if (!workspaceId || !invoiceId || !Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: 'MALFORMED' }
  }
  if (expiresAtMs <= opts.nowMs) return { ok: false, reason: 'EXPIRED' }
  return { ok: true, workspaceId, invoiceId, expiresAtMs }
}
