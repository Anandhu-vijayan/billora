import type { createClient as createClientType } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/app/lib/supabase/admin'

// Back-compat: lazy Proxy so importing this module never throws
// ("supabaseUrl is required"). New server code should call getSupabaseAdmin().
// Server-side only — uses the secret key. NEVER import from client components.
type Admin = ReturnType<typeof createClientType>
export const supabaseAdmin = new Proxy({} as Admin, {
  get(_t, prop) {
    return Reflect.get(getSupabaseAdmin(), prop)
  },
})
