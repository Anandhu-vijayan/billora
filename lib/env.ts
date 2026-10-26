import { z } from 'zod'
import { isUsableGeminiApiKey } from './env-validation'

const HEX_64 = /^[0-9a-fA-F]{64}$/

// Env booleans arrive as strings; treat only 'true'/'1' as true (never the
// zod coerce trap where any non-empty string becomes true). Default is false.
const boolFromEnv = (fallback: boolean) =>
  z
    .preprocess((v) => {
      if (v === undefined || v === '') return fallback ? 'true' : 'false'
      if (typeof v === 'boolean') return v ? 'true' : 'false'
      const s = String(v).trim().toLowerCase()
      return s === '1' || s === 'true' ? 'true' : 'false'
    }, z.enum(['true', 'false']))
    .transform((v) => v === 'true')

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
  // ABUSE / PROVIDER-QUOTA GUARD. Max NEW invoices one workspace may file per
  // UTC day at the WhatsApp intake. Bounds runaway Gemini/storage/OCR cost from
  // a spamming sender. Set 0 to disable the cap entirely.
  WHATSAPP_MAX_INVOICES_PER_DAY: z.coerce.number().int().min(0).default(200),
  // Keyed HMAC for WhatsApp sender identities. Generate with:
  // node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // NEVER commit the real value; rotate by re-keying whatsapp_identities.
  WHATSAPP_IDENTITY_HMAC_KEY: z.string().min(32, 'WHATSAPP_IDENTITY_HMAC_KEY must be at least 32 chars').optional(),
  // OPT-IN PROACTIVE DELIVERY (§P1-6). OFF by default: a register is only ever
  // pushed to the owner unprompted when the operator explicitly enables it here
  // AND the owner separately opts in AND a SEPARATE sealing key is configured AND
  // the send falls inside Meta's 24h service window. The 32-byte hex key seals the
  // owner's wa_id at rest; it is deliberately distinct from ENCRYPTION_MASTER_KEY
  // and the identity HMAC key so a leak of one cannot unmask the others.
  WHATSAPP_PROACTIVE_DELIVERY: boolFromEnv(false),
  WHATSAPP_PROACTIVE_KEY: z
    .string()
    .regex(HEX_64, 'WHATSAPP_PROACTIVE_KEY must be a 32-byte hex string (64 hex chars)')
    .optional(),
  // OPTIONAL SIGNED-LINK WEB REVIEW (§P1-8). OFF by default. When enabled, a
  // WhatsApp-only owner (no Supabase login) can open a stateless HMAC-signed,
  // expiring link that reviews EXACTLY one invoice without a session. The
  // dedicated 32-byte hex signing key is deliberately distinct from every other
  // key so a leak elsewhere cannot mint review links. The link grants no workspace
  // access and never bypasses a validator — the route re-checks tenant binding and
  // runs the SAME shared applyInvoiceReview as the authenticated + WhatsApp paths.
  REVIEW_LINKS_ENABLED: boolFromEnv(false),
  REVIEW_LINK_KEY: z
    .string()
    .regex(HEX_64, 'REVIEW_LINK_KEY must be a 32-byte hex string (64 hex chars)')
    .optional(),
  // Signed-link lifetime in seconds; defaulted + clamped in lib/review/review-token.
  REVIEW_LINK_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  // Gemini fallback for ambiguous spreadsheet headers (layout labels only, never row values).
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-flash-lite-latest'),
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
  // AI provider; tesseract is reserved and unimplemented.
  EXTRACTION_PROVIDER: z.enum(['gemini', 'tesseract']).default('gemini'),
  EXTRACTION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  EXTRACTION_AMOUNT_TOLERANCE_MINOR_UNITS: z.coerce.number().int().min(0).max(10000).default(101),
  // Vision model for invoice extraction; defaults to GEMINI_MODEL when unset.
  EXTRACTION_VISION_MODEL: z.string().min(1).optional(),
  // PRIVACY GATE. AI is OFF by default: real customer invoices are never sent
  // to an external provider unless the operator explicitly enables it AND has
  // confirmed a paid-tier + reviewed data-processing terms (EXTRACTION_AI_TIER).
  // With AI off, anything the local engine cannot resolve goes to needs_review.
  EXTRACTION_ALLOW_AI: boolFromEnv(false),
  EXTRACTION_AI_TIER: z.enum(['free', 'paid']).default('paid'),
  // PARALLEL VISION (§P2-11). OFF by default: the shipped pipeline calls Gemini
  // only when the LOCAL engine is insufficient. When on (and AI is allowed +
  // keyed) the first Gemini pass runs CONCURRENTLY with local OCR to cut latency,
  // and is consumed even when local looked sufficient — so it spends one vision
  // call per invoice. That extra provider spend/PII exposure is the explicit
  // trade-off the operator opts into; the second pass is still skipped whenever
  // the two sources reconcile. Requires the paid-tier AI gate above.
  EXTRACTION_VISION_PARALLEL: boolFromEnv(false),
  // LOCAL-FIRST engine for the hybrid pipeline. 'pdfjs-text' is the default
  // because it is fully local/private (reads a digital PDF's embedded text via
  // pdf.js — no network, no model). Scanned/image PDFs have no text layer, so
  // they yield no local candidate and then take the gated-AI or review path.
  // 'none' disables local extraction entirely; the other ids are operator-
  // wired adapters (see lib/ocr/local.ts + lib/ocr/engines/*).
  LOCAL_OCR_ENGINE: z.enum(['none', 'pdfjs-text', 'pdftotext', 'tesseract']).default('pdfjs-text'),
  // LOCAL DEBUG ONLY. When true, the extraction handler logs the full field ->
  // value map of the selected candidate at DEBUG level. logger.debug is dropped
  // entirely when NODE_ENV=production, so real invoice values can never reach a
  // production log sink even if this flag is left on. Leave unset in prod.
  EXTRACTION_DEBUG_VALUES: boolFromEnv(false),
  // IMAGE-QUALITY GATE (§P3-13). ON by default for raster uploads: a real sharp
  // focus (Laplacian variance) + minimum-resolution check runs before a row can be
  // trusted. A failing image is flagged in plain English and forced to needs_review
  // — it is NEVER auto-approved, so this can only reduce over-approval, never
  // increase it. PDFs are exempt. Set IMAGE_QUALITY_GATE=false to disable entirely.
  // Thresholds are optional; unset falls back to lib/ocr/quality.ts defaults.
  IMAGE_QUALITY_GATE: boolFromEnv(true),
  IMAGE_BLUR_VARIANCE_MAX: z.coerce.number().int().nonnegative().optional(),
  IMAGE_MIN_LONG_EDGE: z.coerce.number().int().nonnegative().optional(),
  IMAGE_MIN_PIXELS: z.coerce.number().int().nonnegative().optional(),
  // Public origin used to build authenticated workbook download links. When
  // unset the register is still generated but no link is delivered (fail-safe).
  PUBLIC_APP_URL: z.string().url().optional(),
  // Durable job queue. The queue lives in Postgres; WORKER_SECRET only guards
  // the external trigger endpoint. Unset = endpoint disabled (fail closed).
  WORKER_SECRET: z.string().min(16, 'WORKER_SECRET must be at least 16 chars').optional(),
  // Numeric knobs, parsed with defaults + clamps in lib/jobs/*.ts.
  JOB_LEASE_SECONDS: z.string().optional(),
  JOB_TICK_LIMIT: z.string().optional(),
  // Max jobs one worker tick processes CONCURRENTLY (§P2-10). Bounded + defaulted
  // in lib/jobs/worker.ts (clamped to the per-tick limit), so a misconfiguration
  // can never fan out unbounded against Gemini/storage quota.
  JOB_CONCURRENCY: z.string().optional(),
  JOB_TICK_BUDGET_MS: z.string().optional(),
  JOB_BACKOFF_BASE_SECONDS: z.string().optional(),
  JOB_BACKOFF_CAP_SECONDS: z.string().optional(),
}).superRefine((env, ctx) => {
  if (!env.EXTRACTION_ALLOW_AI) return
  if (env.EXTRACTION_AI_TIER !== 'paid') {
    ctx.addIssue({ code: 'custom', path: ['EXTRACTION_AI_TIER'], message: 'AI extraction requires the paid tier' })
  }
  if (env.EXTRACTION_PROVIDER !== 'gemini') {
    ctx.addIssue({ code: 'custom', path: ['EXTRACTION_PROVIDER'], message: 'AI extraction currently requires Gemini' })
  }
  if (!isUsableGeminiApiKey(env.GEMINI_API_KEY)) {
    ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'A valid Gemini API key is required when AI extraction is enabled' })
  }
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
    // Opt-in proactive delivery posture (booleans only — never key material).
    proactiveDelivery: (process.env.WHATSAPP_PROACTIVE_DELIVERY ?? '').trim().toLowerCase() === 'true',
    hasProactiveKey: HEX_64.test(process.env.WHATSAPP_PROACTIVE_KEY ?? ''),
    // Signed-link web review posture (booleans only — never key material).
    reviewLinksEnabled: (process.env.REVIEW_LINKS_ENABLED ?? '').trim().toLowerCase() === 'true',
    hasReviewLinkKey: HEX_64.test(process.env.REVIEW_LINK_KEY ?? ''),
    extractionProvider: process.env.EXTRACTION_PROVIDER ?? 'gemini',
    // Privacy posture (booleans/labels only — reveals no data or keys).
    aiAllowed: (process.env.EXTRACTION_ALLOW_AI ?? '').trim().toLowerCase() === 'true',
    extractionAiTier: process.env.EXTRACTION_AI_TIER ?? 'paid',
    visionParallel: (process.env.EXTRACTION_VISION_PARALLEL ?? '').trim().toLowerCase() === 'true',
    localEngine: process.env.LOCAL_OCR_ENGINE ?? 'pdfjs-text',
    hasPublicAppUrl: (process.env.PUBLIC_APP_URL ?? '').length > 0,
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
