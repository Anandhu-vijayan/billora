// §P1-8 signed-link web review tests.
// Two layers: (1) the PURE review-token primitive is exercised IN-PROCESS via the
// real transpiled module (round-trip, tamper, expiry, wrong-key, TTL clamp); (2) the
// route is a source-contract — it touches Supabase/crypto/`@/` aliases and cannot be
// imported here, so we assert its security ordering literally (fail-closed gate +
// verify BEFORE any DB, reuse of the SHARED applyInvoiceReview, tenant re-check, and
// that no token/secret/PII is ever logged). A contract change fails loudly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importTs } from '../scripts/_ts-import.mjs'

const rt = await importTs('lib/review/review-token.ts')
const routeSrc = () => readFileSync(new URL('../app/api/review/[token]/route.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const envSrc = () => readFileSync(new URL('../lib/env.ts', import.meta.url), 'utf8')
const exampleSrc = () => readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

const KEY = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const WS = '11111111-1111-1111-1111-111111111111'
const INV = '22222222-2222-2222-2222-222222222222'
const DAY = 24 * 60 * 60 * 1000

// ---- enabled / key resolution (env-driven, injected) ------------------------
test('P1-8 links are OFF unless BOTH the flag and a 64-hex key are present', () => {
  assert.equal(rt.reviewLinksEnabled({}), false)
  assert.equal(rt.reviewLinksEnabled({ REVIEW_LINKS_ENABLED: 'true' }), false, 'flag but no key')
  assert.equal(rt.reviewLinksEnabled({ REVIEW_LINK_KEY: KEY }), false, 'key but no flag')
  assert.equal(rt.reviewLinksEnabled({ REVIEW_LINKS_ENABLED: 'true', REVIEW_LINK_KEY: KEY }), true)
  assert.equal(rt.reviewLinksEnabled({ REVIEW_LINKS_ENABLED: '1', REVIEW_LINK_KEY: KEY }), false, 'only literal true')
  assert.equal(rt.reviewLinksEnabled({ REVIEW_LINKS_ENABLED: 'true', REVIEW_LINK_KEY: 'tooshort' }), false)
})

test('P1-8 resolveReviewLinkKey returns the key only when fully configured', () => {
  assert.equal(rt.resolveReviewLinkKey({ REVIEW_LINKS_ENABLED: 'true', REVIEW_LINK_KEY: KEY }), KEY)
  assert.equal(rt.resolveReviewLinkKey({ REVIEW_LINK_KEY: KEY }), null, 'not enabled -> null')
  assert.equal(rt.resolveReviewLinkKey({ REVIEW_LINKS_ENABLED: 'true' }), null, 'no key -> null')
})

test('P1-8 TTL defaults to 7 days and is clamped to the 30-day hard ceiling', () => {
  assert.equal(rt.reviewLinkTtlSeconds({}), rt.REVIEW_LINK_DEFAULT_TTL_SECONDS)
  assert.equal(rt.reviewLinkTtlSeconds({ REVIEW_LINK_TTL_SECONDS: '3600' }), 3600)
  assert.equal(rt.reviewLinkTtlSeconds({ REVIEW_LINK_TTL_SECONDS: '0' }), rt.REVIEW_LINK_DEFAULT_TTL_SECONDS)
  assert.equal(rt.reviewLinkTtlSeconds({ REVIEW_LINK_TTL_SECONDS: 'nope' }), rt.REVIEW_LINK_DEFAULT_TTL_SECONDS)
  // A misconfigured decade-long TTL is capped, never honored -> no perpetual link.
  assert.equal(rt.reviewLinkTtlSeconds({ REVIEW_LINK_TTL_SECONDS: String(99999 * DAY) }), rt.REVIEW_LINK_MAX_TTL_SECONDS)
  assert.ok(rt.REVIEW_LINK_MAX_TTL_SECONDS <= 30 * DAY)
})

// ---- sign + verify round-trip ----------------------------------------------
test('P1-8 a honestly minted token verifies and yields the bound ids', () => {
  const now = Date.now()
  const token = rt.signReviewToken({ workspaceId: WS, invoiceId: INV, expiresAtMs: now + DAY, secretHex: KEY })
  const v = rt.verifyReviewToken(token, { secretHex: KEY, nowMs: now })
  assert.equal(v.ok, true)
  assert.equal(v.workspaceId, WS)
  assert.equal(v.invoiceId, INV)
  assert.equal(v.expiresAtMs, now + DAY)
})

test('P1-8 an expired token is refused EXPIRED against the injected clock', () => {
  const now = Date.now()
  const token = rt.signReviewToken({ workspaceId: WS, invoiceId: INV, expiresAtMs: now + 1000, secretHex: KEY })
  assert.equal(rt.verifyReviewToken(token, { secretHex: KEY, nowMs: now }).ok, true)
  const late = rt.verifyReviewToken(token, { secretHex: KEY, nowMs: now + 2000 })
  assert.equal(late.ok, false)
  assert.equal(late.reason, 'EXPIRED')
})

test('P1-8 a token signed by another key is a single BAD_SIGNATURE verdict', () => {
  const now = Date.now()
  const token = rt.signReviewToken({ workspaceId: WS, invoiceId: INV, expiresAtMs: now + DAY, secretHex: KEY })
  const v = rt.verifyReviewToken(token, { secretHex: OTHER, nowMs: now })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'BAD_SIGNATURE')
})

test('P1-8 tampering with the payload (swap the invoice) fails the signature', () => {
  const now = Date.now()
  const token = rt.signReviewToken({ workspaceId: WS, invoiceId: INV, expiresAtMs: now + DAY, secretHex: KEY })
  const [payloadB64, sig] = token.split('.')
  const evil = Buffer.from(`${WS}.${INV.replace(/2/g, '3')}.${now + DAY}`, 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  assert.notEqual(evil, payloadB64)
  const v = rt.verifyReviewToken(`${evil}.${sig}`, { secretHex: KEY, nowMs: now })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'BAD_SIGNATURE', 'a re-signed-free payload edit is caught by the HMAC')
})

test('P1-8 verify refuses to run without a key and rejects malformed input', () => {
  const now = Date.now()
  const token = rt.signReviewToken({ workspaceId: WS, invoiceId: INV, expiresAtMs: now + DAY, secretHex: KEY })
  assert.equal(rt.verifyReviewToken(token, { secretHex: null, nowMs: now }).reason, 'NO_KEY')
  assert.equal(rt.verifyReviewToken(token, { secretHex: 'not-hex', nowMs: now }).reason, 'NO_KEY')
  for (const bad of ['', 'x', 'a.b.c', '....', '!!notbase64!!.!!stillnot!!.']) {
    assert.equal(rt.verifyReviewToken(bad, { secretHex: KEY, nowMs: now }).ok, false, `must reject: ${bad}`)
  }
})

// ---- route source-contract -------------------------------------------------
test('P1-8 route gates + verifies BEFORE any database access (fail closed)', () => {
  const src = routeSrc()
  const authorizeAt = src.indexOf('function authorize')
  assert.ok(authorizeAt >= 0, 'authorize() must exist')
  const authorizeBody = src.slice(authorizeAt, src.indexOf('// GET opens', authorizeAt))
  assert.ok(/reviewLinksEnabled\(\)/.test(authorizeBody), 'checks enabled')
  assert.ok(/deny\(503,\s*'REVIEW_LINKS_DISABLED'\)/.test(authorizeBody), '503 when unconfigured')
  assert.ok(/verifyReviewToken\(/.test(authorizeBody), 'verifies the token')
  assert.ok(/deny\(401,\s*'INVALID_REVIEW_LINK'\)/.test(authorizeBody), 'opaque 401 on any verify failure')
  // No DB/secret-resolution call inside the pure gate — every query runs only AFTER authorize.
  assert.ok(!/getSupabaseAdmin\(/.test(authorizeBody), 'authorize must not touch the DB')
  assert.ok(!/resolveFileKeyConfig\(/.test(authorizeBody), 'authorize must not resolve encryption keys')
  // Both handlers short-circuit on the denial before touching the DB.
  for (const verb of ['GET', 'POST']) {
    const fn = src.slice(src.indexOf(`export async function ${verb}`))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    const authIdx = body.indexOf('authorize(token)')
    const dbIdx = body.indexOf('getSupabaseAdmin()')
    assert.ok(authIdx >= 0 && dbIdx >= 0, `${verb}: authorize then DB`)
    assert.ok(authIdx < dbIdx, `${verb}: verification precedes any DB call`)
    assert.ok(/if \(!auth\.ok\) return auth\.response/.test(body), `${verb}: denial returned immediately`)
  }
})

test('P1-8 POST reuses the SHARED review path and re-checks tenant before writing', () => {
  const src = routeSrc()
  const post = src.slice(src.indexOf('export async function POST'))
  assert.ok(/import \{[\s\S]*?\} from '@\/lib\/invoices\/review'/.test(src) && /applyInvoiceReview/.test(src), 'reuses applyInvoiceReview')
  assert.ok(/parseReviewCorrections\(body\)/.test(post), 'shared field validation, not a bespoke one')
  // Tenant re-check runs BEFORE the applyInvoiceReview write: loadInvoiceForEdit is
  // scoped by the token's OWN workspace and gates the write on it still being pending.
  const loadIdx = post.indexOf('loadInvoiceForEdit(db, { workspaceId, invoiceId })')
  const applyIdx = post.indexOf('applyInvoiceReview(db,')
  assert.ok(loadIdx >= 0 && applyIdx >= 0 && loadIdx < applyIdx, 'pending + tenant re-check precedes the write')
  // The workspace used for every query is the VERIFIED token's, never the request body.
  assert.ok(!/workspaceId:\s*(?:body|req)/.test(post), 'workspace is never taken from the request')
  assert.ok(/applyInvoiceReview\(db,\s*\{[\s\S]*?workspaceId,[\s\S]*?invoiceId/.test(post), 'apply is tenant-scoped by the token workspace')
})

test('P1-8 the route never logs the token, the key or invoice contents', () => {
  const src = routeSrc()
  const loggerCalls = [...src.matchAll(/logger\.\w+\(([^)]*)\)/g)].map((m) => m[1])
  assert.ok(loggerCalls.length > 0, 'route logs something')
  const joined = loggerCalls.join('\n').toLowerCase()
  for (const forbidden of ['secret', 'token', 'review_link_key', 'masterkey', 'gstin', 'vendor', 'corrections.']) {
    assert.ok(!joined.includes(forbidden), `logger must never reference ${forbidden}`)
  }
  // Audit logs only field NAMES + opaque ids/result.
  assert.ok(/fields:\s*Object\.keys\(corrections\)/.test(src), 'only field names logged')
})

// ---- env + docs wiring -----------------------------------------------------
test('P1-8 env schema + public info expose the review-link vars (booleans only)', () => {
  const src = envSrc()
  assert.ok(/REVIEW_LINKS_ENABLED:\s*boolFromEnv\(false\)/.test(src), 'off by default')
  assert.ok(/REVIEW_LINK_KEY:[\s\S]*?HEX_64/.test(src), 'validated 32-byte hex key')
  assert.ok(/REVIEW_LINK_TTL_SECONDS:\s*z\.coerce\.number\(\)/.test(src), 'ttl coerced')
  // Public info reveals posture only — never key material.
  const pub = src.slice(src.indexOf('export function getPublicEnvInfo'))
  assert.ok(/reviewLinksEnabled:/.test(pub) && /hasReviewLinkKey:/.test(pub))
  assert.ok(!/REVIEW_LINK_KEY\b(?!\s*\?\?\s*'')/.test(pub.replace(/HEX_64\.test\(process\.env\.REVIEW_LINK_KEY/, '')), 'no key value in public info')
})

test('P1-8 .env.example documents the three review-link vars', () => {
  const src = exampleSrc()
  assert.match(src, /^REVIEW_LINKS_ENABLED=false$/m)
  assert.match(src, /^REVIEW_LINK_KEY=$/m)
  assert.match(src, /^REVIEW_LINK_TTL_SECONDS=$/m)
})
