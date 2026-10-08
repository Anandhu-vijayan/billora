import { createClient } from '@supabase/supabase-js'
import { getEnv } from '@/app/lib/env'

// Server-side only — uses the secret key. NEVER import from client components.
let cached: ReturnType<typeof createClient> | null = null

export function getSupabaseAdmin() {
  if (cached) return cached
  const env = getEnv()
  if (!env.SUPABASE_SECRET_KEY) {
    throw new Error('Missing Supabase env: set SUPABASE_SECRET_KEY, then restart the server.')
  }
  cached = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  })
  return cached
}
