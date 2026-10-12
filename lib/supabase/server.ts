// lib/supabase/server.ts — Privileged service role execution pool.
import { createClient } from '@supabase/supabase-js'
import { getEnv } from '@/lib/env'

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

/**
 * Resolve a logical bucket to its configured slug. Intake/exports code must
 * never hardcode a bucket name — this reads SUPABASE_INVOICES_BUCKET /
 * SUPABASE_EXPORTS_BUCKET (defaults match the provisioned private buckets).
 */
export function bucketFor(kind: 'invoices' | 'exports'): string {
  const env = getEnv()
  return kind === 'invoices' ? env.SUPABASE_INVOICES_BUCKET : env.SUPABASE_EXPORTS_BUCKET
}

// Back-compat: lazy Proxy so importing this module never throws
// ("supabaseUrl is required"). New server code should call getSupabaseAdmin().
type Admin = ReturnType<typeof createClient>
export const supabaseAdmin = new Proxy({} as Admin, {
  get(_t, prop) {
    return Reflect.get(getSupabaseAdmin(), prop)
  },
})
