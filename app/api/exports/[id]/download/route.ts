// GET /api/exports/[id]/download — authenticated, workspace-scoped workbook serve.
//
// Generated registers are encrypted at rest, so they can never be handed out as
// a raw bucket/signed URL. This route is the only way to obtain one, and it
// re-checks authorization on every request BEFORE touching the object:
//   1. there must be a verified signed-in user (else 401),
//   2. the workbook row must exist (else 404),
//   3. the user must be a member of THAT workbook's workspace (else 403) — this
//      is the cross-tenant isolation gate; a valid user from another workspace
//      is denied exactly like an unknown id,
//   4. the register must not be deleted/expired (else 404/410),
// and only then does it decrypt the container IN MEMORY and stream the .xlsx.
// It never logs invoice contents, keys, or the download identity.
import { NextResponse } from 'next/server'
import { getSupabaseAdmin, bucketFor } from '@/lib/supabase/server'
import { getAuthenticatedUserId } from '@/lib/supabase/server-session'
import { decryptFile, resolveFileKeyConfig } from '@/lib/encryption/files'
import { decideDownloadAccess } from '@/lib/exports/access'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const SPREADSHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface WorkbookRow {
  workspace_id: string
  status: string
  expires_at: string | null
  file_object_path: string
  file_encryption_key_version: string | null
}

function deny(status: number, code: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params
  if (!UUID_RE.test(id)) return deny(404, 'WORKBOOK_NOT_FOUND')

  const userId = await getAuthenticatedUserId()
  const db = getSupabaseAdmin()

  const { data: row, error: readErr } = await db
    .from('generated_workbooks')
    .select('workspace_id,status,expires_at,file_object_path,file_encryption_key_version')
    .eq('id', id)
    .maybeSingle()
  if (readErr) {
    logger.error('[Export] workbook read failed', { code: 'EXPORT_READ_ERROR' })
    return deny(500, 'EXPORT_UNAVAILABLE')
  }
  const workbook = row as WorkbookRow | null

  // Membership is resolved against the workbook's OWN workspace id, so an
  // authenticated user who is not a member is denied (403) — never served.
  let memberOfWorkspace = false
  if (userId && workbook) {
    const { data: member } = await db
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workbook.workspace_id)
      .eq('user_id', userId)
      .maybeSingle()
    memberOfWorkspace = !!member
  }

  const decision = decideDownloadAccess({
    authenticated: !!userId,
    workbookExists: !!workbook,
    memberOfWorkspace,
    status: workbook?.status ?? null,
    expiresAt: workbook?.expires_at ?? null,
    nowMs: Date.now(),
  })
  if (!decision.ok) return deny(decision.status, decision.code)
  if (!workbook) return deny(404, 'WORKBOOK_NOT_FOUND') // defensive: satisfies narrowing

  try {
    const { masterKeyHex } = resolveFileKeyConfig()
    const { data: blob, error: dlErr } = await db.storage
      .from(bucketFor('exports'))
      .download(workbook.file_object_path)
    if (dlErr || !blob) return deny(503, 'EXPORT_UNAVAILABLE')

    const container = Buffer.from(await blob.arrayBuffer())
    // Decrypt the envelope container into an in-memory .xlsx buffer. A tampered
    // or wrong-key container throws (never emits plaintext); we surface a safe
    // code only and do not log the object path, key version, or contents.
    const plain = decryptFile(container, masterKeyHex, {
      context: workbook.file_object_path,
      expectedKeyVersion: workbook.file_encryption_key_version ?? undefined,
    })

    return new Response(new Uint8Array(plain), {
      headers: {
        'Content-Type': SPREADSHEET_MIME,
        'Content-Disposition': 'attachment; filename="billora-register.xlsx"',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    logger.error('[Export] download failed', { code: 'EXPORT_DOWNLOAD_FAILED' })
    return deny(500, 'EXPORT_DOWNLOAD_FAILED')
  }
}
