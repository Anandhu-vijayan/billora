import { fail, ok, toPublicErrorMessage } from '@/lib/api-response'
import { getPublicEnvInfo } from '@/lib/env'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { requireServerEnv } from '@/lib/validation'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID().slice(0, 8)
  const started = Date.now()
  try {
    requireServerEnv()
    const admin = getSupabaseAdmin()
    // `workspaces` exists in supabase/migrations/20261002143735_initial_schema.sql.
    // service_role bypasses RLS so a count query is a pure connectivity check.
    const { count, error } = await admin.from('workspaces').select('id', { count: 'exact', head: true })
    if (error) throw new Error(error.message)
    logger.info('supabase health ok', { requestId, ms: Date.now() - started })
    return ok({ connected: true, ...getPublicEnvInfo(), count }, { requestId })
  } catch (e) {
    logger.error('supabase health failed', { requestId, ms: Date.now() - started })
    const info = getPublicEnvInfo()
    if (!info.hasUrl || !info.hasSecret) {
      return fail('Supabase is not configured.', {
        status: 503,
        code: 'not_configured',
        requestId,
      })
    }
    return fail(toPublicErrorMessage(e), { status: 503, code: 'unreachable', requestId })
  }
}
