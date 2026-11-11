// Production security wiring contracts for proxy and privacy-sensitive paths.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const proxy = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8')

test('SEC-rate-limit: production uses atomic shared Redis REST counters', () => {
  assert.match(proxy, /redisRateLimit\(ip\)/)
  assert.match(proxy, /redis\.call\('INCR', KEYS\[1\]\)/)
  assert.match(proxy, /redis\.call\('PEXPIRE', KEYS\[1\], ARGV\[1\]\)/)
  assert.match(proxy, /RATE_LIMIT_REDIS_REST_URL/)
  assert.match(proxy, /RATE_LIMIT_REDIS_REST_TOKEN/)
  assert.match(proxy, /RATE_LIMIT_HMAC_KEY/)
  assert.match(proxy, /crypto\.subtle\.sign\('HMAC'/)
})

test('SEC-rate-limit: production fails closed instead of falling back to per-instance Map', () => {
  assert.match(proxy, /process\.env\.NODE_ENV === 'production'[\s\S]*?await redisRateLimit\(ip\)/)
  assert.match(proxy, /rate_limiter_unavailable/)
  assert.match(proxy, /devBuckets = new Map/)
  assert.match(proxy, /process\.env\.NODE_ENV === 'production'\) \{[\s\S]*?status: 503/)
})

test('SEC-rate-limit: WhatsApp signed webhook and secret-protected worker avoid generic limits', () => {
  assert.match(proxy, /pathname === '\/api\/whatsapp' \|\| pathname === '\/api\/jobs\/worker'/)
})
