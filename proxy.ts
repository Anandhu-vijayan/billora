import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60
const DEV_BUCKET_MAX = 5_000
const devBuckets = new Map<string, { count: number; resetAt: number }>()

type LimitResult = { limited: boolean; resetAfterMs: number }

function clientIp(req: NextRequest): string {
  // The hosting edge must overwrite these forwarding headers. Do not accept a
  // query parameter or application cookie as an IP source.
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

function devRateLimit(key: string): LimitResult {
  const now = Date.now()
  const entry = devBuckets.get(key)
  if (!entry || now >= entry.resetAt) {
    if (devBuckets.size >= DEV_BUCKET_MAX) {
      // Bound memory in long-running local processes.
      for (const [bucketKey, bucket] of devBuckets) {
        if (now >= bucket.resetAt) devBuckets.delete(bucketKey)
      }
      if (devBuckets.size >= DEV_BUCKET_MAX) devBuckets.clear()
    }
    devBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { limited: false, resetAfterMs: RATE_LIMIT_WINDOW_MS }
  }
  entry.count += 1
  return {
    limited: entry.count > RATE_LIMIT_MAX,
    resetAfterMs: Math.max(0, entry.resetAt - now),
  }
}

async function hmacKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(value),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function redisRateLimit(ip: string): Promise<LimitResult> {
  const url = process.env.RATE_LIMIT_REDIS_REST_URL
  const token = process.env.RATE_LIMIT_REDIS_REST_TOKEN
  const secret = process.env.RATE_LIMIT_HMAC_KEY
  if (!url || !token || !secret || secret.length < 32) {
    throw new Error('RATE_LIMITER_NOT_CONFIGURED')
  }

  // Store only a keyed digest of the client IP; never put raw IP addresses in
  // Redis keys. The secret must be stable across all application instances.
  const key = await hmacKey(secret)
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip))
  const ipDigest = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  const redisKey = `billora:rate-limit:v1:${ipDigest}`
  const script = [
    "local n = redis.call('INCR', KEYS[1])",
    "if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
    "local ttl = redis.call('PTTL', KEYS[1])",
    'return {n, ttl}',
  ].join('\n')

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['EVAL', script, '1', redisKey, String(RATE_LIMIT_WINDOW_MS)]),
    cache: 'no-store',
    signal: AbortSignal.timeout(2_500),
  })
  if (!response.ok) throw new Error(`RATE_LIMITER_HTTP_${response.status}`)
  const payload = await response.json() as { result?: unknown; error?: string }
  if (payload.error || !Array.isArray(payload.result)) throw new Error('RATE_LIMITER_BAD_RESPONSE')
  const count = Number(payload.result[0])
  const ttl = Number(payload.result[1])
  if (!Number.isFinite(count) || !Number.isFinite(ttl) || ttl < 0) {
    throw new Error('RATE_LIMITER_BAD_COUNTER')
  }
  return { limited: count > RATE_LIMIT_MAX, resetAfterMs: ttl }
}

/**
 * Shared, atomic rate limiting for horizontally scaled production instances.
 * Production requires an Upstash-compatible Redis REST endpoint; the local Map
 * is deliberately development-only. WhatsApp is excluded here because Meta's
 * signed webhook is independently authenticated and can deliver legitimate
 * bursts; the worker endpoint has its own high-entropy secret.
 */
export async function proxy(req: NextRequest) {
  const requestId = crypto.randomUUID()
  const pathname = req.nextUrl.pathname
  const exempt = pathname === '/api/whatsapp' || pathname === '/api/jobs/worker'

  if (pathname.startsWith('/api/') && !exempt) {
    const ip = clientIp(req)
    try {
      const result = process.env.NODE_ENV === 'production'
        ? await redisRateLimit(ip)
        : (process.env.RATE_LIMIT_REDIS_REST_URL
            ? await redisRateLimit(ip)
            : devRateLimit(ip))
      if (result.limited) {
        return NextResponse.json(
          { ok: false, error: { code: 'rate_limited', message: 'Too many requests. Slow down and retry.' } },
          {
            status: 429,
            headers: {
              'Cache-Control': 'no-store',
              'Retry-After': String(Math.max(1, Math.ceil(result.resetAfterMs / 1000))),
              'x-request-id': requestId,
            },
          },
        )
      }
    } catch (error) {
      // Fail closed in production: silently falling back to per-instance state
      // would give a false impression of distributed protection.
      if (process.env.NODE_ENV === 'production') {
        return NextResponse.json(
          { ok: false, error: { code: 'rate_limiter_unavailable', message: 'Request protection is temporarily unavailable. Retry shortly.' } },
          {
            status: 503,
            headers: { 'Cache-Control': 'no-store', 'Retry-After': '5', 'x-request-id': requestId },
          },
        )
      }
      console.warn('[proxy] shared rate limiter unavailable in development', error)
    }
  }

  const res = NextResponse.next()
  res.headers.set('x-request-id', requestId)
  return res
}

export const config = {
  matcher: ['/api/:path*'],
}
