// lib/supabase/server-session.ts — server-side authenticated user resolution.
//
// Used only by trusted server routes (today: the encrypted workbook download)
// that must know WHO is asking before releasing tenant data. It builds a
// per-request user-scoped client from the request cookies (never the service
// key) and returns the verified user id, or null when anonymous. The publishable
// key is the browser-safe key; no secret is involved and nothing is logged.
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getEnv } from '@/lib/env'

/** The signed-in user's id, or null when there is no valid session. */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const env = getEnv()
  const cookieStore = await cookies()
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          // A GET route must not mutate cookies; refresh is best-effort only.
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // Called from a Server Component / static context — safe to ignore.
          }
        },
      },
    },
  )
  const { data } = await supabase.auth.getUser()
  return data.user?.id ?? null
}
