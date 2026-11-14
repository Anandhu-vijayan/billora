import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getAuthenticatedUserId } from '@/lib/supabase/server-session'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const POLICY_VERSION = 'review-retention-v1'
const NOTICE = 'Invoices that remain unresolved after entering needs review are proposed for deletion after 90 days by default. The original file and associated extracted data are deleted; minimal deletion audit metadata is retained. Notices are scheduled 7 days and 1 day before expiry. Recent review activity and a legal hold pause deletion. Resolved invoices follow a separate retention policy. Confirm applicable GST, accounting, contractual, and privacy obligations before accepting this policy.'
const headers = { 'Cache-Control': 'no-store' }

type DbError = { code?: string; message: string }
type PolicyRow = {
  review_retention_days: number
  review_retention_accepted_at: string | null
  review_retention_policy_version: string | null
}

function response(status: number, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code } }, { status, headers })
}

async function authorize(
  workspaceId: string,
): Promise<{ db: ReturnType<typeof getSupabaseAdmin>; userId: string; policy: PolicyRow } | Response> {
  if (!UUID_RE.test(workspaceId)) return response(404, 'WORKSPACE_NOT_FOUND')
  const userId = await getAuthenticatedUserId()
  if (!userId) return response(401, 'UNAUTHENTICATED')
  const db = getSupabaseAdmin()
  const { data: member, error: memberError } = await (db.from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle() as unknown as Promise<{ data: { role: string } | null; error: DbError | null }>)
  if (memberError) {
    logger.error('[WorkspacePrivacy] retention membership check failed', { code: memberError.code ?? null })
    return response(500, 'WORKSPACE_PRIVACY_UNAVAILABLE')
  }
  if (!member) return response(403, 'NOT_MEMBER')
  if (member.role !== 'owner' && member.role !== 'admin') return response(403, 'ADMIN_REQUIRED')

  const { data: policy, error: policyError } = await (db.from('workspaces')
    .select('review_retention_days,review_retention_accepted_at,review_retention_policy_version')
    .eq('id', workspaceId)
    .maybeSingle() as unknown as Promise<{ data: PolicyRow | null; error: DbError | null }>)
  if (policyError) {
    logger.error('[WorkspacePrivacy] retention policy read failed', { code: policyError.code ?? null })
    return response(500, 'WORKSPACE_PRIVACY_UNAVAILABLE')
  }
  if (!policy) return response(404, 'WORKSPACE_NOT_FOUND')
  return { db, userId, policy }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  const result = await authorize(id)
  if (result instanceof Response) return result
  return NextResponse.json({
    ok: true,
    proposedDefaultDays: 90,
    minimumDays: 30,
    maximumDays: 3650,
    policyVersion: POLICY_VERSION,
    notice: NOTICE,
    enabled: result.policy.review_retention_accepted_at !== null
      && result.policy.review_retention_policy_version === POLICY_VERSION,
    retentionDays: result.policy.review_retention_days,
    acceptedAt: result.policy.review_retention_accepted_at,
  }, { headers })
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  const result = await authorize(id)
  if (result instanceof Response) return result
  if (process.env.REVIEW_RETENTION_POLICY_APPROVED !== 'true') {
    return response(503, 'RETENTION_POLICY_REQUIRES_LEGAL_APPROVAL')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return response(400, 'INVALID_BODY')
  }
  if (!body || typeof body !== 'object'
    || !('acceptPolicy' in body) || body.acceptPolicy !== true
    || !('policyVersion' in body) || body.policyVersion !== POLICY_VERSION
    || !('retentionDays' in body) || typeof body.retentionDays !== 'number'
    || !Number.isInteger(body.retentionDays) || body.retentionDays < 30 || body.retentionDays > 3650) {
    return response(400, 'RETENTION_POLICY_CONFIRMATION_REQUIRED')
  }

  const workspaceTable = result.db.from('workspaces') as unknown as {
    update(values: {
      review_retention_days: number
      review_retention_accepted_at: string
      review_retention_policy_version: string
      review_retention_actor: string
    }): { eq(column: 'id', value: string): PromiseLike<{ error: DbError | null }> }
  }
  const { error } = await workspaceTable.update({
    review_retention_days: body.retentionDays,
    review_retention_accepted_at: new Date().toISOString(),
    review_retention_policy_version: POLICY_VERSION,
    review_retention_actor: result.userId,
  }).eq('id', id)
  if (error) {
    logger.error('[WorkspacePrivacy] retention policy update failed', { code: error.code ?? null })
    return response(500, 'WORKSPACE_PRIVACY_UNAVAILABLE')
  }
  return NextResponse.json({ ok: true, enabled: true, retentionDays: body.retentionDays }, { headers })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  const result = await authorize(id)
  if (result instanceof Response) return result
  const workspaceTable = result.db.from('workspaces') as unknown as {
    update(values: {
      review_retention_accepted_at: null
      review_retention_policy_version: null
      review_retention_actor: null
    }): { eq(column: 'id', value: string): PromiseLike<{ error: DbError | null }> }
  }
  const { error } = await workspaceTable.update({
    review_retention_accepted_at: null,
    review_retention_policy_version: null,
    review_retention_actor: null,
  }).eq('id', id)
  if (error) {
    logger.error('[WorkspacePrivacy] retention policy withdrawal failed', { code: error.code ?? null })
    return response(500, 'WORKSPACE_PRIVACY_UNAVAILABLE')
  }
  return NextResponse.json({ ok: true, enabled: false }, { headers })
}
