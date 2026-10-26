// lib/whatsapp/provision.ts — WhatsApp-first workspace/client provisioning (server only).
// No auth.users rows are fabricated: bot workspaces use created_via='whatsapp'
// with NULL owner_user_id (see migration 20261010120000). Auth linking happens later.
import type { SupabaseClient } from '@supabase/supabase-js'

function validName(name: string): boolean {
  const n = name.trim()
  return n.length >= 2 && n.length <= 120
}

/** Find-or-create the sender's individual workspace. Idempotent per sender. */
export async function ensureIndividualWorkspace(db: SupabaseClient, senderHmac: string): Promise<string> {
  const existing = await db
    .from('whatsapp_identities')
    .select('workspace_id')
    .eq('sender_hmac', senderHmac)
    .maybeSingle()
  if (existing.data?.workspace_id) return existing.data.workspace_id as string

  const { data: created, error } = await db
    .from('workspaces')
    .insert({ name: 'My Invoices', account_type: 'individual', owner_user_id: null, created_via: 'whatsapp' })
    .select('id')
    .single()
  if (error) throw new Error(`WORKSPACE_CREATE_ERROR: ${error.message}`)
  const workspaceId = created.id as string
  const { error: linkError } = await db
    .from('whatsapp_identities')
    .update({ workspace_id: workspaceId, account_type: 'individual' })
    .eq('sender_hmac', senderHmac)
  if (linkError) throw new Error(`IDENTITY_LINK_ERROR: ${linkError.message}`)
  return workspaceId
}

/** Find-or-create an organization workspace by exact name for this sender. */
export async function ensureOrganizationWorkspace(
  db: SupabaseClient,
  senderHmac: string,
  orgName: string,
): Promise<{ workspaceId: string; created: boolean }> {
  const name = orgName.trim()
  if (!validName(name)) throw new Error('INVALID_ORG_NAME')
  const linked = await db.from('whatsapp_identities').select('workspace_id').eq('sender_hmac', senderHmac).maybeSingle()
  if (linked.data?.workspace_id) {
    const ws = await db.from('workspaces').select('id,name,account_type').eq('id', linked.data.workspace_id).maybeSingle()
    if (ws.data && (ws.data as { account_type: string }).account_type === 'organization') {
      return { workspaceId: ws.data.id as string, created: false }
    }
  }
  const { data: created, error } = await db
    .from('workspaces')
    .insert({ name, account_type: 'organization', owner_user_id: null, created_via: 'whatsapp' })
    .select('id')
    .single()
  if (error) throw new Error(`WORKSPACE_CREATE_ERROR: ${error.message}`)
  const workspaceId = created.id as string
  const { error: linkError } = await db
    .from('whatsapp_identities')
    .update({ workspace_id: workspaceId, account_type: 'organization' })
    .eq('sender_hmac', senderHmac)
  if (linkError) throw new Error(`IDENTITY_LINK_ERROR: ${linkError.message}`)
  return { workspaceId, created: true }
}

/** Clients of a workspace — the route verifies the sender owns this workspace first. */
export async function listClients(db: SupabaseClient, workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await db.from('clients').select('id,name').eq('workspace_id', workspaceId).order('name').limit(50)
  if (error) throw new Error(`CLIENT_LIST_ERROR: ${error.message}`)
  return (data ?? []) as Array<{ id: string; name: string }>
}

/** Persist a new client after workspace-authorization check by the caller. */
export async function createClient(db: SupabaseClient, workspaceId: string, name: string): Promise<string> {
  const clean = name.trim()
  if (!validName(clean)) throw new Error('INVALID_CLIENT_NAME')
  const { data, error } = await db.from('clients').insert({ workspace_id: workspaceId, name: clean }).select('id').single()
  if (error) throw new Error(`CLIENT_CREATE_ERROR: ${error.message}`)
  return data.id as string
}

/** Verify a client id belongs to the sender's workspace before accepting the selection. */
export async function verifyClientInWorkspace(db: SupabaseClient, workspaceId: string, clientId: string): Promise<boolean> {
  const { data, error } = await db
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(`CLIENT_VERIFY_ERROR: ${error.message}`)
  return !!data
}

export type OwnGstinResult = { ok: true } | { ok: false; reason: 'NOT_MIGRATED' | 'NOT_FOUND' | 'FAULT' }

/**
 * Persist (or clear, when `gstin` is null) the buyer's OWN GSTIN for one client,
 * tenant-scoped (§P0-1b). Fail-SOFT and migration-safe: if the additive
 * own_gstin migration has not been applied yet the write hits PGRST204 and we
 * return NOT_MIGRATED instead of throwing — the optional capture must never break
 * the chat the way an unknown-column write would (see the session-save regression
 * and the same `select('*')` resilience in the extract/review paths). The value is
 * assumed already checksum-validated by the conversation layer; a null clears it.
 */
export async function setClientOwnGstin(
  db: SupabaseClient, workspaceId: string, clientId: string, gstin: string | null,
): Promise<OwnGstinResult> {
  const value = (gstin ?? '').trim().toUpperCase() || null
  const { data, error } = await db
    .from('clients')
    .update({ own_gstin: value })
    .eq('workspace_id', workspaceId)
    .eq('id', clientId)
    .select('id')
  if (error) {
    if (error.code === 'PGRST204' || /schema cache|own_gstin/i.test(error.message ?? '')) {
      return { ok: false, reason: 'NOT_MIGRATED' }
    }
    return { ok: false, reason: 'FAULT' }
  }
  if (!data || data.length === 0) return { ok: false, reason: 'NOT_FOUND' }
  return { ok: true }
}
