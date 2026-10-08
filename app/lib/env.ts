import { z } from 'zod'

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required'),
  SUPABASE_SECRET_KEY: z.string().min(1, 'SUPABASE_SECRET_KEY is required').optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
})

export type ServerEnv = z.infer<typeof serverSchema>

let cached: ServerEnv | null = null

/** Validated server env. Throws a single readable error listing every missing var. */
export function getEnv(): ServerEnv {
  if (cached) return cached
  const parsed = serverSchema.safeParse(process.env)
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(
      `Invalid environment: ${details}. Copy .env.example to .env.local and fill in the values, then restart the server.`,
    )
  }
  cached = parsed.data
  return cached
}

/** Safe subset for health checks / diagnostics (never includes secrets). */
export function getPublicEnvInfo() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  return {
    hasUrl: url.length > 0,
    hasPublishableKey: (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '').length > 0,
    hasSecret: (process.env.SUPABASE_SECRET_KEY ?? '').length > 0,
    urlHost: safeHost(url),
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
