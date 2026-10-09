import { z } from 'zod'
import { getEnv } from '@/lib/env'

export const workspaceIdSchema = z.string().uuid('workspaceId must be a UUID')

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
})

/** Throws when required server env is missing — call at the top of handlers/jobs. */
export function requireServerEnv() {
  const env = getEnv()
  if (!env.SUPABASE_SECRET_KEY) {
    throw new Error('Missing Supabase env: set SUPABASE_SECRET_KEY, then restart the server.')
  }
  return env
}
