// POST /api/invoices/[id]/review — a verified workspace member corrects/approves
// one needs_review invoice. This is the human-review entrypoint that lets an
// unreadable (e.g. image) invoice be completed and then flow into its real
// (client, month) batch + register workbook.
//
// Authorization mirrors the encrypted download route exactly (the only trusted
// pattern this app has for "release/modify tenant data over HTTP"):
//   1. there must be a verified signed-in user (else 401),
//   2. the invoice must exist (else 404),
//   3. the user must be a member of THAT invoice's workspace (else 403) — the
//      cross-tenant isolation gate; a valid user from another workspace is denied
//      like a unknown id.
// Only then does it apply the correction. It never trusts the client to name the
// workspace: the workspace comes from the invoice row itself, scoped by membership.
// No invoice contents, keys or identities are logged.
import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getAuthenticatedUserId } from '@/lib/supabase/server-session'
import { resolveFileKeyConfig, isEncryptionConfigFailure } from '@/lib/encryption/files'
import { applyInvoiceReview } from '@/lib/invoices/review'
import type { LedgerCandidate } from '@/lib/ocr/ledger'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function deny(status: number, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** Keep only whitelisted fields with the right primitive type; drop everything else. */
function pickCorrections(body: unknown): LedgerCandidate {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const out: LedgerCandidate = {}
  const strFields = ['invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin'] as const
  const numFields = ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount'] as const
  for (const f of strFields) {
    const v = src[f]
    if (typeof v === 'string' && v.trim() !== '') out[f] = v.trim()
  }
  for (const f of numFields) {
    const v = src[f]
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
    if (Number.isFinite(n) && n >= 0) out[f] = n
  }
  return out
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params
  if (!UUID_RE.test(id)) return deny(404, 'INVOICE_NOT_FOUND')

  const userId = await getAuthenticatedUserId()
  if (!userId) return deny(401, 'UNAUTHENTICATED')

  let masterKeyHex: string
  try {
    ({ masterKeyHex } = resolveFileKeyConfig())
  } catch (e) {
    if (isEncryptionConfigFailure(e)) return deny(503, 'ENCRYPTION_CONFIG')
    throw e
  }

  const db = getSupabaseAdmin()
  const { data: invoice, error: invErr } = await db.from('invoices')
    .select('id,workspace_id')
    .eq('id', id)
    .maybeSingle()
  if (invErr) {
    logger.error('[Review] invoice read failed', { code: 'REVIEW_READ_ERROR' })
    return deny(500, 'REVIEW_UNAVAILABLE')
  }
  if (!invoice) return deny(404, 'INVOICE_NOT_FOUND')
  const workspaceId = (invoice as { workspace_id: string }).workspace_id

  // Tenant isolation: the caller must belong to the invoice's OWN workspace.
  const { data: member } = await db.from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!member) return deny(403, 'NOT_MEMBER')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return deny(400, 'INVALID_BODY')
  }

  try {
    const result = await applyInvoiceReview(db, {
      workspaceId, invoiceId: id, corrections: pickCorrections(body), masterKeyHex,
    })
    return NextResponse.json(
      { ok: true, review: result.review, reasons: result.reasons, confidence: result.confidence, batchId: result.batchId },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    logger.error('[Review] apply failed', { code: detail.split(':')[0] || 'REVIEW_FAULT' })
    if (/REVIEW_INVOICE_NOT_FOUND/.test(detail)) return deny(404, 'INVOICE_NOT_FOUND')
    return deny(500, 'REVIEW_FAILED')
  }
}
