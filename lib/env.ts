import { z } from 'zod'

const HEX_64 = /^[0-9a-fA-F]{64}$/

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required'),
  SUPABASE_SECRET_KEY: z.string().min(1, 'SUPABASE_SECRET_KEY is required').optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  // WhatsApp Cloud API credentials (media download + verification).
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WHATSAPP_VERIFY_TOKEN is required').optional(),
  // App secret for X-Hub-Signature-256 webhook validation (Meta dashboard:
  // App settings > Basic > App Secret). Required in production; the webhook
  // fails closed (rejects every delivery) when it is missing there.
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
  WHATSAPP_GRAPH_VERSION: z.string().min(1).default('v21.0'),
  // Keyed HMAC for WhatsApp sender identities. Generate with:
  // node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // NEVER commit the real value; rotate by re-keying whatsapp_identities.
  WHATSAPP_IDENTITY_HMAC_KEY: z.string().min(32, 'WHATSAPP_IDENTITY_HMAC_KEY must be at least 32 chars').optional(),
  // Gemini fallback for ambiguous spreadsheet headers (layout labels only, never row values).
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.8-flash'),
  // 32-byte hex master key for local AES-256-GCM payload encryption.
  ENCRYPTION_MASTER_KEY: z
    .string()
    .regex(HEX_64, 'ENCRYPTION_MASTER_KEY must be a 32-byte hex string (64 hex chars)')
    .optional(),
  // Dedicated 32-byte hex key for the HMAC that derives opaque object paths.
  // Deliberately separate from WHATSAPP_IDENTITY_HMAC_KEY and the encryption
  // master key, so path derivation and content encryption never share a secret.
  STORAGE_PATH_KEY: z
    .string()
    .regex(HEX_64, 'STORAGE_PATH_KEY must be a 32-byte hex string (64 hex chars)')
    .optional(),
  // Supabase Storage bucket slugs (read from env; literals are the safe default
  // matching the provisioned buckets).
  SUPABASE_INVOICES_BUCKET: z.string().min(1).default('billora-invoices'),
  SUPABASE_EXPORTS_BUCKET: z.string().min(1).default('billora-exports'),
  // Extraction engine selection (Stage 3). gemini is the only implemented
  // provider; tesseract is reserved and unimplemented.
  EXTRACTION_PROVIDER: z.enum(['gemini', 'tesseract']).default('gemini'),
  EXTRACTION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  // Vision model for invoice extraction; defaults to GEMINI_MODEL when unset.
  EXTRACTION_VISION_MODEL: z.string().min(1).optional(),
  // Durable job queue. The queue lives in Postgres; WORKER_SECRET only guards
  // the external trigger endpoint. Unset = endpoint disabled (fail closed).
  WORKER_SECRET: z.string().min(16, 'WORKER_SECRET must be at least 16 chars').optional(),
  // Numeric knobs, parsed with defaults + clamps in lib/jobs/*.ts.
  JOB_LEASE_SECONDS: z.string().optional(),
  JOB_TICK_LIMIT: z.string().optional(),
  JOB_TICK_BUDGET_MS: z.string().optional(),
  JOB_BACKOFF_BASE_SECONDS: z.string().optional(),
  JOB_BACKOFF_CAP_SECONDS: z.string().optional(),
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
    hasWhatsappToken: (process.env.WHATSAPP_VERIFY_TOKEN ?? '').length > 0,
    hasWhatsappAppSecret: (process.env.WHATSAPP_APP_SECRET ?? '').length > 0,
    hasWhatsappAccessToken: (process.env.WHATSAPP_ACCESS_TOKEN ?? '').length > 0,
    hasGeminiKey: (process.env.GEMINI_API_KEY ?? '').length > 0,
    hasWorkerSecret: (process.env.WORKER_SECRET ?? '').length > 0,
    // Booleans/labels only — never key material.
    hasEncryptionKey: HEX_64.test(process.env.ENCRYPTION_MASTER_KEY ?? ''),
    hasPathKey: HEX_64.test(process.env.STORAGE_PATH_KEY ?? ''),
    extractionProvider: process.env.EXTRACTION_PROVIDER ?? 'gemini',
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
