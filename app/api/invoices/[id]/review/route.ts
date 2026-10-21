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
import { moneyToMinorUnits, minorUnitsToNumber } from '@/lib/ocr/validators/money'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function deny(status: number, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Parse a reviewer-supplied amount with the SAME decimal-safe, Indian-grouping
 * and currency-symbol-aware engine the extractor uses (moneyToMinorUnits). A
 * bare `Number('1,23,456.78')` is NaN and would silently discard a legitimate
 * correction, so formatted strings like "₹1,23,456.78" or "1,18,200/-" must
 * parse here too. Returns null for empty/invalid/non-finite input — never zero.
 */
function parseMoney(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null
  const minor = moneyToMinorUnits(v)
  return minor === null ? null : minorUnitsToNumber(minor)
}

/** Upper bounds for reviewer-supplied text; over-length is a field error, not a silent truncate. */
const MAX_LEN: Record<string, number> = {
  invoice_date: 40, invoice_number: 64, vendor_name: 200, supplier_gstin: 15,
}

interface FieldError { field: string; code: string }

/**
 * Validate a reviewer's submitted corrections.
 *   * Absent or blank (empty/whitespace) fields mean "no change" — the UI does
 *     NOT have to resubmit already-correct values, and blanks never wipe a field.
 *   * A field that IS present but malformed (wrong type, over length, an amount
 *     the money engine cannot parse, or a negative required amount) is returned
 *     as a field-specific error instead of being silently discarded — never
 *     coerced to zero and never lost without an actionable signal (§7.2 / §5).
 * Date VALUE correctness is intentionally NOT re-implemented here; the shared
 * date service in evaluateLedger re-scores it and keeps the row in review with a
 * reason code if it is unresolved (§4 single source of truth).
 */
function parseCorrections(body: unknown): { corrections: LedgerCandidate; errors: FieldError[] } {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const corrections: LedgerCandidate = {}
  const errors: FieldError[] = []
  const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')

  const strFields = ['invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin'] as const
  for (const f of strFields) {
    const v = src[f]
    if (!present(v)) continue
    if (typeof v !== 'string') { errors.push({ field: f, code: 'INVALID_TYPE' }); continue }
    const t = v.trim()
    if (t.length > MAX_LEN[f]) { errors.push({ field: f, code: 'TOO_LONG' }); continue }
    corrections[f] = t
  }

  // Required amounts must be non-negative; optional reconciliation components
  // (round_off, netting discount/deduction) may legitimately be negative.
  const readAmount = (f: string, v: unknown, allowNegative: boolean) => {
    if (!present(v)) return
    const n = parseMoney(v)
    if (n === null) { errors.push({ field: f, code: 'INVALID_AMOUNT' }); return }
    if (!allowNegative && n < 0) { errors.push({ field: f, code: 'NEGATIVE_NOT_ALLOWED' }); return }
    ;(corrections as Record<string, unknown>)[f] = n
  }
  for (const f of ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount'] as const) readAmount(f, src[f], false)
  for (const f of ['cess_amount', 'shipping_amount', 'discount_amount', 'deduction_amount', 'round_off'] as const) readAmount(f, src[f], true)

  return { corrections, errors }
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

  const { corrections, errors } = parseCorrections(body)
  if (errors.length > 0) {
    // Never silently drop a malformed correction: tell the caller exactly which
    // fields were rejected and why, so the UI can surface field-level feedback.
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FIELDS', fields: errors } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  try {
    const result = await applyInvoiceReview(db, {
      workspaceId, invoiceId: id, corrections, masterKeyHex,
    })
    // Audit metadata: WHO corrected WHICH fields on WHICH invoice, and the
    // resulting state. Only field NAMES are logged — never their values, GSTINs,
    // vendor names or amounts (§7.2 / §11 no-sensitive-content logging).
    logger.info('[Review] correction applied', {
      actor: userId, invoice: id, workspace: workspaceId,
      fields: Object.keys(corrections), review: result.review,
    })
    return NextResponse.json(
      { ok: true, review: result.review, reasons: result.reasons, confidence: result.confidence, batchId: result.batchId, row: result.row },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    logger.error('[Review] apply failed', { code: detail.split(':')[0] || 'REVIEW_FAULT' })
    if (/REVIEW_INVOICE_NOT_FOUND/.test(detail)) return deny(404, 'INVOICE_NOT_FOUND')
    return deny(500, 'REVIEW_FAILED')
  }
}
