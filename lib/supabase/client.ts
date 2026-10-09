// lib/supabase/client.ts — Anonymous client instantiation layer.
import { createBrowserClient } from '@supabase/ssr'
import { getEnv } from '@/lib/env'

export const createClient = () => {
  // Validated lazily so a missing env throws one clear error, not "supabaseUrl is required".
  const env = getEnv()
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
}
