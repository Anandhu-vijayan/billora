import type { SupabaseClient } from '@supabase/supabase-js'

export type ConsentDecision = 'enabled' | 'withdrawn'

export interface WorkspaceConsentState {
  enabled: boolean
  consentVersion: string | null
  consentedAt: string | null
}

export async function getWorkspaceGeminiConsentState(
  db: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceConsentState | null> {
  const { data, error } = await db.from('workspaces')
    .select('gemini_consent_at, gemini_consent_version')
    .eq('id', workspaceId)
    .maybeSingle() as unknown as {
      data: { gemini_consent_at: string | null; gemini_consent_version: string | null } | null
      error: { message: string } | null
    }
  if (error) throw new Error(`AI_CONSENT_READ_ERROR: ${error.message}`)
  if (!data) return null
  const enabled = data.gemini_consent_version !== null && data.gemini_consent_at !== null
  return {
    enabled,
    consentVersion: data.gemini_consent_version,
    consentedAt: data.gemini_consent_at,
  }
}

export async function appendWorkspaceConsentAudit(
  db: SupabaseClient,
  workspaceId: string,
  actorUserId: string | null,
  decision: ConsentDecision,
  consentVersion: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from('workspace_consent_events').insert({
    workspace_id: workspaceId,
    consent_kind: 'gemini',
    decision,
    consent_version: consentVersion,
    actor_user_id: actorUserId,
    metadata,
  }) as unknown as { error: { message: string } | null }
  if (error) throw new Error(`AI_CONSENT_AUDIT_ERROR: ${error.message}`)
}
