import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getAuthenticatedUserId } from '@/lib/supabase/server-session'
import {
  GEMINI_WORKSPACE_CONSENT_NOTICE,
  GEMINI_WORKSPACE_CONSENT_VERSION,
} from '@/lib/privacy/ai-consent'
import { appendWorkspaceConsentAudit } from '@/lib/privacy/consent-audit'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const headers = { 'Cache-Control': 'no-store' }
type DbError = { code?: string; message: string }
type WorkspaceConsent = { gemini_consent_at: string | null; gemini_consent_version: string | null }

function response(status: number, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code } }, { status, headers })
}

async function authorizedWorkspace(
  workspaceId: string,
): Promise<{ db: ReturnType<typeof getSupabaseAdmin>; userId: string; workspace: WorkspaceConsent } | Response> {
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
    logger.error('[WorkspacePrivacy] membership check failed', { code: memberError.code ?? null })
    return response(500, 'WORKSPACE_PRIVACY_UNAVAILABLE')
  }
  if (!member) return response(403, 'NOT_MEMBER')
  if (member.role !== 'owner' && member.role !== 'admin') return response(403, 'ADMIN_REQUIRED')

  const { data: workspace, error: workspaceError } = await (db.from('workspaces')
    .select('gemini_consent_at,gemini_consent_version')
    .eq('id', workspaceId)
    .maybeSingle() as unknown as Promise<{ data: WorkspaceConsent | null; error: DbError | null }>)
  if (workspaceError) {
    logger.error('[WorkspacePrivacy] consent read failed', { code: workspaceError.code ?? null })
    return response(500, 'WORKSPACE_PRIVACY_UNAVAILABLE')
  }
  if (!workspace) return response(404, 'WORKSPACE_NOT_FOUND')
  return { db, userId, workspace }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  const result = await authorizedWorkspace(id)
  if (result instanceof Response) return result
  return NextResponse.json({
    ok: true,
    provider: 'Google Gemini',
    consentVersion: GEMINI_WORKSPACE_CONSENT_VERSION,
    notice: GEMINI_WORKSPACE_CONSENT_NOTICE,
    enabled: result.workspace.gemini_consent_version === GEMINI_WORKSPACE_CONSENT_VERSION
      && result.workspace.gemini_consent_at !== null,
    consentedAt: result.workspace.gemini_consent_at,
  }, { headers })
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  const result = await authorizedWorkspace(id)
  if (result instanceof Response) return result

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return response(400, 'INVALID_BODY')
  }
  if (!body || typeof body !== 'object'
    || !('consent' in body) || body.consent !== true
    || !('version' in body) || body.version !== GEMINI_WORKSPACE_CONSENT_VERSION) {
    return response(400, 'CONSENT_CONFIRMATION_REQUIRED')
  }

  const workspaceTable = result.db.from('workspaces') as unknown as {
    update(values: {
      gemini_consent_at: string
      gemini_consent_version: string
      gemini_consent_actor: string
    }): { eq(column: 'id', value: string): PromiseLike<{ error: DbError | null }> }
  }
  const { error } = await workspaceTable.update({
    gemini_consent_at: new Date().toISOString(),
    gemini_consent_version: GEMINI_WORKSPACE_CONSENT_VERSION,
    gemini_consent_actor: result.userId,
  }).eq('id', id)
  if (error) {
    logger.error('[WorkspacePrivacy] consent update failed', { code: error.code ?? null })
    return response(500, 'WORKSPACE_PRIVACY_UNAVAILABLE')
  }
  try {
    await appendWorkspaceConsentAudit(
      result.db,
      id,
      result.userId,
      'enabled',
      GEMINI_WORKSPACE_CONSENT_VERSION,
      { source: 'workspace-ai-consent' },
    )
  } catch (auditError) {
    logger.error('[WorkspacePrivacy] consent audit append failed', {
      error: auditError instanceof Error ? auditError.message : String(auditError),
    })
  }
  return NextResponse.json({ ok: true, enabled: true }, { headers })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  const result = await authorizedWorkspace(id)
  if (result instanceof Response) return result

  const workspaceTable = result.db.from('workspaces') as unknown as {
    update(values: {
      gemini_consent_at: null
      gemini_consent_version: null
      gemini_consent_actor: null
    }): { eq(column: 'id', value: string): PromiseLike<{ error: DbError | null }> }
  }
  const { error } = await workspaceTable.update({
    gemini_consent_at: null,
    gemini_consent_version: null,
    gemini_consent_actor: null,
  }).eq('id', id)
  if (error) {
    logger.error('[WorkspacePrivacy] consent withdrawal failed', { code: error.code ?? null })
    return response(500, 'WORKSPACE_PRIVACY_UNAVAILABLE')
  }
  try {
    await appendWorkspaceConsentAudit(
      result.db,
      id,
      result.userId,
      'withdrawn',
      GEMINI_WORKSPACE_CONSENT_VERSION,
      { source: 'workspace-ai-consent' },
    )
  } catch (auditError) {
    logger.error('[WorkspacePrivacy] consent withdrawal audit append failed', {
      error: auditError instanceof Error ? auditError.message : String(auditError),
    })
  }
  return NextResponse.json({ ok: true, enabled: false }, { headers })
}
