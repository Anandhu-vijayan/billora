import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60
const buckets = new Map<string, { count: number; resetAt: number }>()

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

function isRateLimited(key: string): { limited: boolean; resetAfterMs: number } {
  const now = Date.now()
  const entry = buckets.get(key)
  if (!entry || now >= entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { limited: false, resetAfterMs: RATE_LIMIT_WINDOW_MS }
  }
  entry.count += 1
  if (entry.count > RATE_LIMIT_MAX) {
    return { limited: true, resetAfterMs: entry.resetAt - now }
  }
  return { limited: false, resetAfterMs: entry.resetAt - now }
}

/**
 * Attaches a request id, enforces a basic in-memory rate limit on /api/*,
 * and keeps the proxy free of secrets. For multi-instance production,
 * replace the Map with Redis/Upstash.
 */
export function proxy(req: NextRequest) {
  const requestId =
    req.headers.get('x-request-id') ?? crypto.randomUUID().slice(0, 8)

  if (req.nextUrl.pathname.startsWith('/api/')) {
    const { limited, resetAfterMs } = isRateLimited(
      `${clientIp(req)}:${req.nextUrl.pathname}`,
    )
    if (limited) {
      return NextResponse.json(
        { ok: false, error: { code: 'rate_limited', message: 'Too many requests. Slow down and retry.' } },
        {
          status: 429,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': String(Math.ceil(resetAfterMs / 1000)),
            'x-request-id': requestId,
          },
        },
      )
    }
  }

  const res = NextResponse.next()
  res.headers.set('x-request-id', requestId)
  return res
}

export const config = {
  matcher: ['/api/:path*'],
}
