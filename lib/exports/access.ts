// lib/exports/access.ts — pure authorization decision for workbook downloads.
//
// The register is encrypted at rest and can only be served through our own
// authenticated route. This module holds the SINGLE decision function so the
// rule set is small, auditable and unit-testable in-process (it imports no DB,
// no crypto and no `@/` aliases). The route gathers the facts and defers the
// verdict entirely to decideDownloadAccess — so a cross-workspace request, an
// expired link, or an anonymous caller can never reach the decrypt step.
export type DownloadDenial = {
  ok: false
  status: 401 | 403 | 404 | 410
  code: string
}
export type DownloadDecision = { ok: true } | DownloadDenial

export interface DownloadFacts {
  /** A verified signed-in Supabase user made the request. */
  authenticated: boolean
  /** The requested workbook row exists. */
  workbookExists: boolean
  /** The verified user is a member of the workbook's workspace. */
  memberOfWorkspace: boolean
  /** generated_workbooks.status, or null when the row was not found. */
  status: string | null
  /** generated_workbooks.expires_at (ISO), or null when unset. */
  expiresAt: string | null
  /** Current wall-clock in ms (injected so the check is deterministic). */
  nowMs: number
}

/**
 * Decide whether a download may proceed, in strict precedence order:
 *   401 anonymous  ->  404 no such workbook  ->  403 not a member (tenant
 *   isolation)  ->  404 deleted  ->  410 expired. Only an all-clear returns ok.
 * A non-member is answered 403 to make cross-workspace denial explicit; the
 * route logs no PII and returns only these stable codes.
 */
export function decideDownloadAccess(f: DownloadFacts): DownloadDecision {
  if (!f.authenticated) return { ok: false, status: 401, code: 'UNAUTHENTICATED' }
  if (!f.workbookExists) return { ok: false, status: 404, code: 'WORKBOOK_NOT_FOUND' }
  if (!f.memberOfWorkspace) return { ok: false, status: 403, code: 'NOT_MEMBER' }
  if (f.status === 'deleted') return { ok: false, status: 404, code: 'WORKBOOK_DELETED' }
  if (f.status === 'expired') return { ok: false, status: 410, code: 'WORKBOOK_EXPIRED' }
  if (f.expiresAt) {
    const t = Date.parse(f.expiresAt)
    if (Number.isFinite(t) && t <= f.nowMs) return { ok: false, status: 410, code: 'LINK_EXPIRED' }
  }
  return { ok: true }
}
