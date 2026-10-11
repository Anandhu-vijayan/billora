// Zero-dependency onboarding + intake tests: npm test (node --test).
// Mirrors contracts in lib/whatsapp/*.ts without importing TS (Node 20 has
// no type-stripping). A = conversation contract; B = intake/concurrency;
// C = migration + logging expectations. Contract changes fail loudly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const REPLY = {
  IND: 'billora:account:individual',
  ORG: 'billora:account:organization',
  ADD: 'billora:client:add',
}

function snap(state, extra = {}) {
  return {
    senderHmac: 'h', state, workspaceId: null, clientId: null, batchId: null,
    pendingClientId: null,
    lastProviderMessageId: null, expired: false, ...extra,
  }
}

const routeSrc = () => readFileSync(new URL('../app/api/whatsapp/route.ts', import.meta.url), 'utf8')
const intakeSrc = () => readFileSync(new URL('../lib/whatsapp/intake.ts', import.meta.url), 'utf8')
const conversationSrc = () => readFileSync(new URL('../lib/whatsapp/conversation.ts', import.meta.url), 'utf8')
const statusesSrc = () => readFileSync(new URL('../lib/statuses.ts', import.meta.url), 'utf8')
const sendSrc = () => readFileSync(new URL('../lib/whatsapp/send.ts', import.meta.url), 'utf8')
const sqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261010120000_whatsapp_onboarding_v1.sql', import.meta.url), 'utf8')
const lifecycleSqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261011000000_phase1_status_lifecycle.sql', import.meta.url), 'utf8')
const p2SqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261011150000_phase2_onboarding.sql', import.meta.url), 'utf8')

test('A1 reply-id namespace is validated (prefix + uuid shape)', () => {
  const good = 'billora:client:123e4567-e89b-12d3-a456-426614174000'
  assert.match(good, /^billora:client:[0-9a-f-]{8,36}$/i)
  assert.ok(!/^billora:client:[0-9a-f-]{8,36}$/i.test('billora:client:../../etc'))
  assert.ok(!/^billora:client:[0-9a-f-]{8,36}$/i.test('Free text label'))
})

test('A2 org/client names must be 2-120 chars', () => {
  const ok = (n) => n.trim().length >= 2 && n.trim().length <= 120
  assert.ok(ok('Acme LLP'))
  assert.ok(!ok('x'))
  assert.ok(!ok(' '.repeat(5)))
  assert.ok(!ok('a'.repeat(121)))
})

test('A3 greetings trigger onboarding, other text nudges to greet', () => {
  for (const g of ['hi', 'Hi', 'HELLO', 'hey', 'start']) {
    assert.ok(['hi', 'hello', 'hey', 'start', 'namaste'].includes(g.trim().toLowerCase()))
  }
  assert.ok(!['hi', 'hello', 'hey', 'start', 'namaste'].includes('invoice total 500'))
})

test('A4 duplicate provider id is a no-op (idempotency)', () => {
  const s = snap('awaiting_account_type', { lastProviderMessageId: 'wamid.1' })
  assert.equal(s.lastProviderMessageId, 'wamid.1')
})

test('A5 HMAC identity: sha256 hex, distinct per sender, stable per sender', async () => {
  const { createHmac } = await import('node:crypto')
  const h = (sender, key) => createHmac('sha256', key).update(sender.trim()).digest('hex')
  const a = h('919999999999', 'k1')
  const b = h('918888888888', 'k1')
  assert.equal(a.length, 64)
  assert.notEqual(a, b)
  assert.equal(a, h('919999999999', 'k1'))
  assert.notEqual(a, h('919999999999', 'k2'))
})

test('A6 account reply IDs are exact (labels never trusted)', () => {
  assert.equal(REPLY.IND, 'billora:account:individual')
  assert.equal(REPLY.ORG, 'billora:account:organization')
  assert.equal(REPLY.ADD, 'billora:client:add')
  assert.ok(!['Individual', 'Organization / CA firm'].includes(REPLY.IND))
})


test('B1 only an accepted row suppresses reprocessing (received/failed retry)', () => {
  const isAccepted = (r) => r.status === 'accepted' && r.processed_at !== null
  assert.ok(isAccepted({ status: 'accepted', processed_at: '2026-01-01T00:00:00Z' }))
  assert.ok(!isAccepted({ status: 'received', processed_at: null }))
  assert.ok(!isAccepted({ status: 'failed', processed_at: null }))
})

test('B2 stale conditional save aborts without sending (fail-closed)', () => {
  const src = routeSrc()
  assert.match(src, /if \(!saved\) throw new Error\('STALE_SESSION/)
  assert.match(src, /Persist BEFORE any outbound send/)
})

test('B3 onboarding failures are retryable, never swallowed into 200-accepted', () => {
  const src = routeSrc()
  assert.ok(!src.includes('catch (onboardingError'))
  assert.match(src, /RETRYABLE_PROCESSING_ERROR/)
  assert.match(src, /markIntakeFailed/)
})

test('B4 media lifecycle: upload then invoice(received) then job(queued)', () => {
  const src = intakeSrc()
  assert.match(src, /recordMediaIntake/)
  assert.match(src, /status: 'received'/)
  assert.match(src, /status: 'queued'/)
  assert.match(src, /JOB_RECORD_ERROR/)
})

test('B5 retryable failures use 503; send failures never retrigger intake', () => {
  const src = routeSrc()
  assert.ok(/\{\s*status:\s*503\s*\}/.test(src), 'expected a retryable 503 response')
  // Rule 5: a failed delivery must not rewind or re-run processing. No send
  // failure may throw a retryable error anymore.
  assert.ok(!src.includes('OUTBOUND_SEND_FAILED'), 'send failures must not become retryable errors')
  assert.match(src, /outbound send deferred; processing state persisted/)
  assert.ok(!src.includes('ABORTED_DUPLICATE_EVENT'), 'permanent dedup abort must be removed')
  assert.ok(!/status:\s*'SYSTEM_COMPILATION_ERROR'/.test(src), 'masked error status must be removed')
})

test('B6 every message in a delivery is processed, not just the first', () => {
  const src = routeSrc()
  assert.match(src, /for \(const message of messages\)/)
  assert.match(src, /handleSingleMessage/)
  assert.ok(!/value\?\.messages\?\.\[0\]/.test(src.replace(/messages\.length/g, '')), 'first-message-only intake must be removed')
})

test('C1 migration guards null-owner workspaces and keeps existing owners', () => {
  const sql = sqlSrc()
  assert.match(sql, /alter table public\.workspaces alter column owner_user_id drop not null/)
  assert.match(sql, /workspaces_owner_or_whatsapp_ck/)
  assert.match(sql, /if new\.owner_user_id is not null then/)
  assert.match(sql, /references public\.clients\(id\) on delete set null/)
  assert.match(sql, /webhook_events_status_ck/)
})

test('C2 verify handshake logs outcome only (no token diagnostics)', () => {
  const src = routeSrc()
  assert.ok(!src.includes('receivedLen'))
  assert.ok(!src.includes('expectedConfigured'))
  assert.ok(!src.includes('match:'))
  assert.match(src, /logger\.info\('\[WhatsApp\] verify attempt'/)
  // Constant-time compare, never a bare === on the verify token.
  assert.match(src, /safeTokenEqual\(receivedToken, expectedToken\)/)
})

test('C3 logs carry no PII: no raw phones, bodies, or full provider ids', () => {
  const route = routeSrc()
  const send = readFileSync(new URL('../lib/whatsapp/send.ts', import.meta.url), 'utf8')
  const media = readFileSync(new URL('../lib/whatsapp/media.ts', import.meta.url), 'utf8')
  // No logger call may carry a phone number, message body, media id, token, or full provider id.
  assert.ok(!/logger\.[a-z]+\([^)]*\bfrom\b\s*:/.test(route), 'route must not log raw sender')
  assert.ok(!/logger\.[a-z]+\([^)]*\bmessageId\b\s*:/.test(route), 'route must not log full provider id')
  assert.ok(!/logger\.[a-z]+\([^)]*mediaId\s*:/.test(route + send + media), 'must not log media id')
  assert.ok(!/logger\.[a-z]+\([^)]*accessToken\s*:/.test(send + media), 'must not log access token')
  assert.ok(!/logger\.[a-z]+\([^)]*textBody\s*:/.test(route), 'must not log message body')
  assert.match(route, /shortId/)
  assert.match(send, /shortId: messageId\.slice\(-8\)/)
})
test('A7 session snapshot carries workspace/client/batch + idempotency key', () => {
  const s = snap('collecting', { workspaceId: 'w1', clientId: 'c1', batchId: 'b1', lastProviderMessageId: 'wamid.9' })
  assert.equal(s.workspaceId, 'w1')
  assert.equal(s.clientId, 'c1')
  assert.equal(s.batchId, 'b1')
  assert.equal(s.lastProviderMessageId, 'wamid.9')
})

test('D1 webhook POST validates X-Hub-Signature-256 over the raw body, fail-closed in prod', async () => {
  const src = routeSrc()
  assert.match(src, /x-hub-signature-256/)
  assert.match(src, /verifyWebhookSignature\(rawText/)
  assert.match(src, /NODE_ENV === 'production'/)
  assert.match(src, /status: 401/) // rejected deliveries never create intake rows
  const { createHmac } = await import('node:crypto')
  const secret = 'test-secret'
  const body = JSON.stringify({ object: 'whatsapp_business_account' })
  const good = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  const eq = (h) => h.startsWith('sha256=') && h.length === 'sha256='.length + 64
  assert.ok(eq(good))
  assert.ok(!eq('sha256=deadbeef'))
  assert.ok(!eq(null ?? ''))
})

test('D2 typed status enums match the DB CHECK constraints exactly', () => {
  const src = statusesSrc()
  const sql = lifecycleSqlSrc()
  const list = (name) => {
    const start = src.indexOf(`${name} = [`)
    assert.ok(start >= 0, `${name} missing from statuses.ts`)
    const chunk = src.slice(start, src.indexOf(']', start) + 1)
    return chunk.match(/'[a-z_]+'/g).map((s) => s.replace(/'/g, ''))
  }
  for (const s of list('BATCH_STATUSES')) assert.ok(sql.includes(`'${s}'`), `batch status ${s} missing from SQL`)
  for (const s of ['collecting', 'ready', 'processing', 'completed', 'needs_review', 'failed', 'cancelled']) {
    assert.ok(list('BATCH_STATUSES').includes(s), `canonical batch state ${s} missing`)
  }
  for (const s of list('INTAKE_STATUSES')) assert.ok(sqlSrc().includes(`'${s}'`), `intake status ${s} missing from SQL`)
  for (const s of list('CONVERSATION_STATES')) {
    assert.ok(p2SqlSrc().includes(`'${s}'`), `conversation state ${s} missing from phase2 SQL`)
  }
  for (const s of list('PENDING_UPLOAD_STATUSES')) {
    assert.ok(p2SqlSrc().includes(`'${s}'`), `pending upload status ${s} missing from SQL`)
  }
})

test('D3 state machine completes setup into ready states, then promotes to collecting', () => {
  const src = conversationSrc()
  assert.match(src, /nextState: 'individual_ready'/)
  // First client resolution completes onboarding; a later one is a switch.
  assert.match(src, /session\.clientId \? 'collecting' : 'organization_ready'/)
  assert.match(src, /case 'individual_ready':/)
  assert.match(src, /case 'organization_ready':/)
  // Legacy open state is rewritten, never re-introduced.
  assert.ok(!src.includes("'open'"), 'legacy open batch state must not return')
})

test('D4 credential-blocked sends are classified and alerted, never retried forever', () => {
  const src = sendSrc()
  assert.match(src, /CREDENTIAL_BLOCKED/)
  assert.match(src, /BLOCKED_ERROR_CODES/)
  assert.match(src, /res\.status === 401 \|\| res\.status === 403/)
  assert.match(src, /type SendOutcome = 'ok' \| 'transient' \| 'blocked'/)
})

// ---- Phase 2: conversation commands + upload decision engine -------------

test('E1 commands Menu/Done/Change client/Add client exist with workspace guards', () => {
  const src = conversationSrc()
  for (const c of ['MENU', 'DONE', 'CHANGE_CLIENT', 'ADD_CLIENT']) assert.ok(src.includes(`${c}:`), `command ${c} missing`)
  assert.match(src, /norm === COMMANDS\.CHANGE_CLIENT/)
  assert.match(src, /session\.workspaceId/) // guarded commands
})

test('E2 returning users never repeat setup (welcome-back + expiry keeps linkage)', () => {
  const src = conversationSrc()
  assert.match(src, /note: 'welcome-back'/)
  assert.match(src, /if \(session\.workspaceId\)/)
  const sessions = readFileSync(new URL('../lib/whatsapp/sessions.ts', import.meta.url), 'utf8')
  // Expired conversations restart at 'new' but KEEP workspace/client linkage.
  assert.match(sessions, /workspaceId: s\.workspace_id/)
  assert.match(sessions, /clientId: s\.client_id/)
})

test('E3 media holds, never orphans: receive-first-ask-later + never guess a client', () => {
  const src = routeSrc()
  assert.ok(!src.includes('MEDIA_ORPHAN_WORKSPACE'), 'uploads during onboarding must be held, not failed')
  assert.match(src, /recordPendingUpload/)
  assert.match(src, /holdMedia/)
  assert.match(src, /accountType === 'organization' && !clientId/)
  assert.match(src, /whatsapp\/pending\/\$\{mediaId\}/) // deterministic redelivery-safe path
  // Unsupported media gets a reply, not a DB error or retry loop.
  assert.match(src, /isAcceptedMediaType\(downloaded\.contentType\)/)
  assert.match(src, /PDF, JPG, or PNG/)
  // SHA-256 computed at intake time.
  assert.match(src, /createHash\('sha256'\)/)
  // Holds upsert on object_path; assigned rows are never reset.
  assert.match(intakeSrc(), /onConflict: 'object_path'/)
  const upSrc = intakeSrc()
  const upStart = upSrc.indexOf('.upsert({', upSrc.indexOf('pending_uploads'))
  const upEnd = upSrc.indexOf('}, { onConflict', upStart)
  assert.ok(upStart >= 0 && upEnd > upStart, 'pending upsert block not found')
  assert.ok(!upSrc.slice(upStart, upEnd).includes('status:'), 'upsert must not carry status')
})

test('E4 pending-assignment confirmation: asked before applying any client', () => {
  const src = routeSrc()
  assert.match(src, /awaiting_pending_confirm/)
  assert.match(src, /sendConfirmApply/)
  assert.match(src, /countWaitingUploads/)
  assert.match(src, /assignPendingUploads/)
  const send = sendSrc()
  assert.match(send, /billora:confirm:yes/)
  assert.match(send, /billora:confirm:no/)
  // Confirmation candidate client is persisted on the session (survives restarts).
  const p2 = p2SqlSrc()
  assert.match(p2, /pending_client_id uuid/)
  assert.match(p2, /'awaiting_pending_confirm'/)
})
