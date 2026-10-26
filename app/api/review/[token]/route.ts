// app/api/review/[token]/route.ts — OPTIONAL signed-link web review (§P1-8).
//
// A WhatsApp-only owner has no Supabase login, so the authenticated
// /api/invoices/[id]/review route is unreachable for them. This is the gated
// alternative: a stateless HMAC-signed, expiring link that reviews EXACTLY ONE
// invoice, bound to ONE workspace, WITHOUT a session. It is OFF unless the
// operator sets REVIEW_LINKS_ENABLED=true and provides REVIEW_LINK_KEY.
//
// Security posture (strict precedence — nothing runs before the link is proven):
//   1. links must be fully configured, else 503 REVIEW_LINKS_DISABLED (fail closed,
//      before ANY database touch — an unconfigured deployment exposes no surface);
//   2. the token must verify against the DEDICATED key + injected clock, else
//      401 (BAD_SIGNATURE / EXPIRED / MALFORMED — a single opaque verdict, never
//      which field failed);
//   3. the token binds a workspace, but the invoice row is authoritative: the read
//      is tenant-scoped by that workspace and a cross-workspace/replayed id is
//      answered like an unknown invoice (404) — the SAME isolation the session
//      route relies on, enforced here by scoping every query on the token's OWN
//      workspace and re-checking the invoice's workspace_id;
//   4. only then does it read (GET, read-only) or apply (POST) — and the POST runs
//      the SHARED parseReviewCorrections + applyInvoiceReview, so a signed link can
//      NEVER bypass a validator or fabricate a value; a still-invalid row stays
//      needs_review exactly as in the app and WhatsApp paths.
// The token, the signing key and every invoice value are PII/secret material and
// are NEVER logged — only opaque codes and corrected field NAMES.
import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { resolveFileKeyConfig, isEncryptionConfigFailure } from '@/lib/encryption/files'
import { applyInvoiceReview, parseReviewCorrections } from '@/lib/invoices/review'
import { loadInvoiceForEdit } from '@/lib/whatsapp/review-confirm'
import {
  reviewLinksEnabled, resolveReviewLinkKey, verifyReviewToken,
} from '@/lib/review/review-token'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

function deny(status: number, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Fail-closed gate + token verification, run identically for GET and POST so the
 * surface can never diverge. Returns the bound (workspaceId, invoiceId) ONLY on a
 * full all-clear, otherwise a ready-to-return denial Response. Does not touch the
 * DB, so an unconfigured or tampered request is answered before any query runs.
 */
function authorize(token: string | undefined):
  | { ok: true; workspaceId: string; invoiceId: string }
  | { ok: false; response: NextResponse } {
  if (!reviewLinksEnabled()) return { ok: false, response: deny(503, 'REVIEW_LINKS_DISABLED') }
  const secretHex = resolveReviewLinkKey()
  const verdict = verifyReviewToken(token ?? null, { secretHex, nowMs: Date.now() })
  if (!verdict.ok) {
    // One opaque 401 regardless of WHY — never reveal which check failed.
    return { ok: false, response: deny(401, 'INVALID_REVIEW_LINK') }
  }
  return { ok: true, workspaceId: verdict.workspaceId, invoiceId: verdict.invoiceId }
}

// GET opens the review read-only: the stored row + its plain reason codes, so the
// reviewer can see exactly what will be confirmed. It mutates nothing.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params
  const auth = authorize(token)
  if (!auth.ok) return auth.response

  const db = getSupabaseAdmin()
  // Tenant-scoped, pending-only read (loadInvoiceForEdit refuses a non-pending or
  // cross-workspace invoice and never renders a corrupt row).
  const loaded = await loadInvoiceForEdit(db, { workspaceId: auth.workspaceId, invoiceId: auth.invoiceId })
  if (!loaded.ok) {
    if (loaded.error === 'NOT_PENDING') return deny(409, 'INVOICE_NOT_PENDING')
    return deny(404, 'INVOICE_NOT_FOUND')
  }
  return NextResponse.json(
    { ok: true, row: loaded.row, reasons: loaded.reasons },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

// POST applies the reviewer's corrections and runs the SHARED review path — the
// exact same validator + approval + batching logic as the session route, so a
// link grants no more authority than an authenticated member already has.
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params
  const auth = authorize(token)
  if (!auth.ok) return auth.response
  const { workspaceId, invoiceId } = auth

  let masterKeyHex: string
  try {
    ({ masterKeyHex } = resolveFileKeyConfig())
  } catch (e) {
    if (isEncryptionConfigFailure(e)) return deny(503, 'ENCRYPTION_CONFIG')
    throw e
  }

  // Authoritative tenant re-check: the invoice must live in the token's OWN
  // workspace and still be pending. loadInvoiceForEdit is scoped by workspaceId,
  // so a token naming another workspace's invoice resolves to NOT_FOUND here —
  // before any write — and we never trust the caller to name a workspace.
  const db = getSupabaseAdmin()
  const loaded = await loadInvoiceForEdit(db, { workspaceId, invoiceId })
  if (!loaded.ok) {
    if (loaded.error === 'NOT_PENDING') return deny(409, 'INVOICE_NOT_PENDING')
    return deny(404, 'INVOICE_NOT_FOUND')
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return deny(400, 'INVALID_BODY')
  }

  const { corrections, errors } = parseReviewCorrections(body)
  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FIELDS', fields: errors } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  try {
    const result = await applyInvoiceReview(db, {
      workspaceId, invoiceId, corrections, masterKeyHex,
    })
    // Audit: field NAMES only — never values, GSTINs, vendor names, amounts, the
    // token or the key (§11 no-sensitive-content logging).
    logger.info('[ReviewLink] correction applied', {
      invoice: invoiceId, workspace: workspaceId,
      fields: Object.keys(corrections), review: result.review,
    })
    return NextResponse.json(
      { ok: true, review: result.review, reasons: result.reasons, confidence: result.confidence, batchId: result.batchId, row: result.row },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    logger.error('[ReviewLink] apply failed', { code: detail.split(':')[0] || 'REVIEW_FAULT' })
    if (/REVIEW_INVOICE_NOT_FOUND/.test(detail)) return deny(404, 'INVOICE_NOT_FOUND')
    return deny(500, 'REVIEW_FAILED')
  }
}
