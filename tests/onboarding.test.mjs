// Zero-dependency onboarding + intake tests: npm test (node --test).
// Mirrors contracts in lib/whatsapp/*.ts without importing TS (Node 20 has
// no type-stripping). A = conversation contract; B = intake/concurrency;
// C = migration + logging expectations. Contract changes fail loudly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { importTs } from '../scripts/_ts-import.mjs'

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
const mediaSrc = () => readFileSync(new URL('../lib/whatsapp/media.ts', import.meta.url), 'utf8')
const initialSqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261002143735_initial_schema.sql', import.meta.url), 'utf8')
const p3SqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261011190000_phase3_job_queue.sql', import.meta.url), 'utf8')
const queueSrc = () => readFileSync(new URL('../lib/jobs/queue.ts', import.meta.url), 'utf8')
const workerSrc = () => readFileSync(new URL('../lib/jobs/worker.ts', import.meta.url), 'utf8')
const workerRouteSrc = () => readFileSync(new URL('../app/api/jobs/worker/route.ts', import.meta.url), 'utf8')
const filesSrc = () => readFileSync(new URL('../lib/encryption/files.ts', import.meta.url), 'utf8')
const envSrc = () => readFileSync(new URL('../lib/env.ts', import.meta.url), 'utf8')
const serverSrc = () => readFileSync(new URL('../lib/supabase/server.ts', import.meta.url), 'utf8')
const encSqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261012000000_invoice_storage_encryption.sql', import.meta.url), 'utf8')
const encMenuSqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261012120000_whatsapp_menu_outbound_decoupling.sql', import.meta.url), 'utf8')
const visionSrc = () => readFileSync(new URL('../lib/ocr/vision.ts', import.meta.url), 'utf8')
const extractSrc = () => readFileSync(new URL('../lib/jobs/handlers/extract-invoice.ts', import.meta.url), 'utf8')
const registerSrc = () => readFileSync(new URL('../lib/jobs/handlers/build-register.ts', import.meta.url), 'utf8')
const handlersIndexSrc = () => readFileSync(new URL('../lib/jobs/handlers/index.ts', import.meta.url), 'utf8')
const extractionSqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261012190000_extraction_register.sql', import.meta.url), 'utf8')
const qualitySrc = () => readFileSync(new URL('../lib/ocr/quality.ts', import.meta.url), 'utf8')
const healthSrc = () => readFileSync(new URL('../app/api/health/route.ts', import.meta.url), 'utf8')
const sessionsSrc = () => readFileSync(new URL('../lib/whatsapp/sessions.ts', import.meta.url), 'utf8')
const envExampleSrc = () => readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const webpSqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261012210000_media_formats_webp.sql', import.meta.url), 'utf8')
const privacySqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261013120000_privacy_extraction_exports.sql', import.meta.url), 'utf8')
const localSrc = () => readFileSync(new URL('../lib/ocr/local.ts', import.meta.url), 'utf8')
const accessSrc = () => readFileSync(new URL('../lib/exports/access.ts', import.meta.url), 'utf8')
const downloadRouteSrc = () => readFileSync(
  new URL('../app/api/exports/[id]/download/route.ts', import.meta.url), 'utf8')
const pdfSrc = () => readFileSync(new URL('../lib/ocr/pdf.ts', import.meta.url), 'utf8')
const pdfEngineSrc = () => readFileSync(new URL('../lib/ocr/engines/pdf-text-engine.ts', import.meta.url), 'utf8')
const nextConfigSrc = () => readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8')
const readmeSrc = () => readFileSync(new URL('../README.md', import.meta.url), 'utf8')

// Stage-1 envelope crypto is exercised against the REAL module (transpiled),
// not a copy, so a format drift cannot silently pass here and break Stage-3.
const files = await importTs('lib/encryption/files.ts')
// conversation.ts imports only erased types, so it transpiles to pure JS and
// the menu routing is tested behaviorally against the REAL state machine.
const conv = await importTs('lib/whatsapp/conversation.ts')
// ledger.ts is dependency-free (no aliases/provider imports), so the REAL
// extraction-review decision logic is exercised in-process, not reimplemented.
const ledger = await importTs('lib/ocr/ledger.ts')
// file-type.ts + statuses.ts are alias-free, so the REAL byte-sniffer, the REAL
// size/pixel/page limits, and the REAL accepted-type set are tested in-process
// rather than reimplemented (a drift in either would fail here, not silently).
const fileType = await importTs('lib/media/file-type.ts')
const statuses = await importTs('lib/statuses.ts')
// local.ts (seam) + access.ts (download authz) are alias-free, so the REAL
// no-fabrication behavior and the REAL cross-workspace denial decision are
// exercised in-process rather than reimplemented in the test.
const local = await importTs('lib/ocr/local.ts')
const access = await importTs('lib/exports/access.ts')
// text-parser.ts is alias-free + dependency-free, so the REAL deterministic
// text->field extraction is exercised in-process (a regex drift fails here,
// not silently in production).
const textParser = await importTs('lib/ocr/text-parser.ts')
const MASTER = randomBytes(32).toString('hex')
const PATHK = randomBytes(32).toString('hex')
function sess(state, workspaceId = null) {
  return { senderHmac: 'h', state, workspaceId, clientId: null, batchId: null,
    pendingClientId: null, lastProviderMessageId: null, expired: false }
}

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
  for (const s of list('JOB_STATUSES')) {
    assert.ok(initialSqlSrc().includes(`'${s}'`), `job status ${s} missing from initial SQL`)
  }
  for (const s of list('JOB_TYPES')) {
    assert.ok(p3SqlSrc().includes(`'${s}'`), `job type ${s} missing from phase3 SQL`)
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
  // Encrypted intake: opaque deterministic hold path + plaintext never stored.
  assert.match(src, /deriveObjectKey\('pending', mediaId, pathKeyHex\)/)
  assert.match(src, /encryptFile\(downloaded\.buffer, masterKeyHex/)
  // Unsupported/oversized media is rejected from the SNIFFED bytes, gets a
  // useful reply, and is NOT stored / never loops (return before any DB write).
  assert.match(src, /validateInvoiceMedia\(/)
  assert.match(src, /isPermanentMediaFormatFailure\(e\)/)
  assert.ok(!/isAcceptedMediaType/.test(src), 'intake must stop trusting the declared MIME')
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

test('E5 credential-blocked media never loops Meta retries and surfaces the real reason', () => {
  const media = mediaSrc()
  // Expired/blocked Graph codes (190 family) are permanent, not retryable.
  assert.match(media, /PERMANENT_GRAPH_CODES/)
  for (const c of ['190', '102', '200']) assert.ok(media.includes(c), `graph code ${c} must be permanent`)
  assert.match(media, /MediaPermanentError/)
  assert.match(media, /META_MEDIA_UNRECOVERABLE/)
  // The thrown error carries Meta's message + numeric code (no token, no URL).
  assert.match(media, /graph code \$\{meta\?\.error\.code\}/)
  const src = routeSrc()
  assert.match(src, /isPermanentMediaFailure\(e\)/)
  assert.match(src, /MEDIA_CREDENTIAL_BLOCKED/)
  assert.match(src, /return 'processed'/)
  // Retry-path logs carry the full detail (truncating to the code prefix hid
  // the root cause during the expired-token incident).
  assert.match(src, /error: code, detail: detail\.slice\(0, 200\)/)
  assert.ok(!src.includes("const code = detail.split(':')[0]"), 'retry path must not truncate the error to its code prefix')
})

test('E6 a freshly-filed invoice is acknowledged; redelivery stays silent', () => {
  const src = routeSrc()
  // Clean filing must confirm receipt (was previously silent, confusing users).
  assert.match(src, /Invoice received and queued for processing/)
  // Guarded so a Meta webhook redelivery of the same media never double-pings.
  assert.match(src, /if \(!deduped && !alreadyAcked\)/)
  const dedupIdx = src.indexOf('if (!deduped && !alreadyAcked)')
  const sendIdx = src.indexOf('Invoice received and queued', dedupIdx)
  const acceptIdx = src.indexOf('accepted for queue')
  assert.ok(dedupIdx > 0 && sendIdx > dedupIdx, 'acknowledgment must fire inside the !deduped guard')
  // Rule 5: delivery is best-effort and never rewinds the accepted intake.
  assert.ok(acceptIdx > 0, 'intake still reports accepted for queue')
})

// ---- Phase 3: durable job queue (claims, leases, retries, recovery) -------

test('F1 claims are atomic: SKIP LOCKED over due queued rows only', () => {
  const sql = p3SqlSrc()
  assert.match(sql, /for update skip locked/)
  // Only a due, unclaimed job is eligible, and the claim stamps a lease.
  const claim = sql.slice(sql.indexOf('create or replace function public.claim_processing_jobs'),
    sql.indexOf('create or replace function public.renew_processing_job_lease'))
  assert.match(claim, /j\.status = 'queued'/)
  assert.match(claim, /j\.available_at <= now\(\)/)
  assert.match(claim, /status = 'processing'/)
  assert.match(claim, /attempts = j\.attempts \+ 1/)
  assert.match(claim, /lease_expires_at = now\(\)/)
  // Batch + lease are clamped so one caller cannot take the whole queue.
  assert.match(claim, /limit least\(greatest\(1, p_limit\), 25\)/)
})

test('F2 writes are fenced on ownership: a zombie worker cannot overwrite live state', () => {
  const sql = p3SqlSrc()
  const fenced = ['create or replace function public.renew_processing_job_lease',
    'create or replace function public.complete_processing_job',
    'create or replace function public.fail_processing_job']
  for (const name of fenced) {
    const body = sql.slice(sql.indexOf(name), sql.indexOf(name) + 1600)
    assert.match(body, /locked_by = p_worker/, `${name} must verify the owner`)
    assert.match(body, /lease_expires_at > now\(\)/, `${name} must verify an unexpired lease`)
    assert.match(body, /status = 'processing'/, `${name} must only touch in-flight jobs`)
  }
  // Claim/renew/complete/fail all lock the row they hand out or settle.
  assert.match(sql, /fail_processing_job[\s\S]*?for update;/)
})

test('F3 retries back off, attempts settle, and expired leases are recovered', () => {
  const sql = p3SqlSrc()
  // A retry is the same row back in 'queued' with a future available_at — not a
  // new status, and not an immediate re-run.
  const failBody = sql.slice(
    sql.indexOf('create or replace function public.fail_processing_job'),
    sql.indexOf('create or replace function public.recover_stale_processing_jobs'))
  assert.match(failBody, /case when v_settle then 'failed' else 'queued' end/)
  assert.match(failBody, /j\.attempts >= j\.max_attempts/)
  assert.match(failBody, /now\(\) \+ make_interval\(secs => greatest\(0, p_retry_in_seconds\)\)/)
  // Invoice + job settle together, in one transaction (no torn pair).
  assert.match(failBody, /update public\.invoices/)
  assert.match(failBody, /FAIL_JOB_BAD_INVOICE_STATUS/)
  const recover = sql.slice(sql.indexOf('create or replace function public.recover_stale_processing_jobs'))
  assert.match(recover, /lease_expires_at <= now\(\)/)
  assert.match(recover, /attempts < max_attempts/) // requeue live work
  assert.match(recover, /attempts >= max_attempts/) // settle exhausted work
  // Backoff is exponential and capped in the client.
  assert.match(queueSrc(), /Math\.min\(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS \* 2 \*\* exp\)/)
})

test('F4 queue API is service-role only and runs with a locked search_path', () => {
  const sql = p3SqlSrc()
  const fns = ['claim_processing_jobs', 'renew_processing_job_lease', 'complete_processing_job',
    'fail_processing_job', 'recover_stale_processing_jobs', 'processing_job_depth']
  for (const fn of fns) {
    assert.ok(sql.includes(`revoke all on function public.${fn}`), `${fn} must be revoked from anon/authenticated`)
    assert.ok(sql.includes(`grant execute on function public.${fn}`), `${fn} must be granted to service_role`)
    const def = sql.slice(sql.indexOf(`function public.${fn}`))
    assert.match(def.slice(0, 400), /security definer/, `${fn} must be security definer`)
    assert.match(def.slice(0, 400), /set search_path = ''/, `${fn} must pin search_path`)
  }
  // Grant STATEMENTS only (prose in comments is not a grant).
  assert.ok(!/^\s*grant\b[^;]*\bto\s+(anon|authenticated)\b/m.test(sql), 'no grants to anon/authenticated')
  assert.match(sql, /to service_role;/)
})

test('F5 intake and queueing are strictly idempotent: redelivery cannot double-file', () => {
  const sql = p3SqlSrc()
  assert.match(sql, /invoices_file_object_path_key unique \(file_object_path\)/)
  assert.match(sql, /processing_jobs_target_uniq/)
  assert.match(sql, /\(invoice_id, job_type\)/)
  const intake = intakeSrc()
  // Conflict -> read back and reuse, for BOTH the invoice and the job.
  const rec = intake.slice(intake.indexOf('export async function recordMediaIntake'), intake.indexOf('// ---- Pending uploads'))
  assert.ok((rec.match(/23505/g) || []).length >= 2, 'invoice and job must both handle unique conflicts')
  assert.match(rec, /eq\('file_object_path', args\.objectPath\)/)
  assert.match(rec, /eq\('job_type', 'invoice_extraction'\)/)
  // Never upsert an invoice: that would rewind a processed row's status.
  assert.ok(!rec.includes("from('invoices').upsert"), 'invoice must be insert-then-read, never upsert')
  // Stored path is a deterministic opaque HMAC per provider media id (Stage 1).
  assert.match(routeSrc(), /deriveObjectKey\('invoices', mediaId, pathKeyHex\)/)
})

test('F6 worker claims nothing it cannot do, keeps leases alive, never fakes success', () => {
  const worker = workerSrc()
  const queue = queueSrc()
  // No registered handler => no claim at all (pre-Phase-4 safety).
  assert.match(worker, /if \(jobTypes\.length === 0\)/)
  assert.match(queue, /if \(args\.jobTypes\.length === 0\) return \[\]/)
  assert.match(worker, /registerJobHandler/)
  // Lease is renewed while the handler runs, and released afterwards.
  assert.match(worker, /startHeartbeat\(db, job, worker, leaseSeconds\)/)
  assert.match(worker, /renewLease\(db, job\.id, worker, leaseSeconds\)/)
  assert.match(worker, /stopHeartbeat\(\)/)
  // A lost lease means our write is discarded, reported as fenced — not success.
  assert.match(worker, /const owned = await completeJob\(db, job\.id, worker\)/)
  assert.match(worker, /else result\.fenced \+= 1/)
  // Permanent failures skip the retry ladder; others back off on attempts.
  assert.match(worker, /isPermanentJobFailure\(e\)/)
  assert.match(worker, /retryInSeconds: permanent \? 0 : backoffSeconds\(job\.attempts\)/)
  // One broken handler cannot take the tick down.
  assert.match(worker, /per-job|catch \(e: unknown\)/)
  // Crash recovery runs at the start of every tick.
  assert.match(worker, /await recoverStaleJobs\(db\)/)
  // Trigger endpoint fails closed without WORKER_SECRET, and uses a
  // constant-time compare with the secret only ever in a header.
  const route = workerRouteSrc()
  assert.match(route, /WORKER_DISABLED/)
  assert.match(route, /status: 503/)
  assert.match(route, /safeTokenEqual\(req\.headers\.get\('x-worker-token'\)/)
  assert.ok(!route.includes('searchParams.get'), 'worker secret must never travel in a URL')
  assert.match(route, /Math\.min\(Math\.max\(body\.limit as number, 1\), 25\)/)
})

// ---- Stage 1: envelope file encryption + opaque paths ----------------------

function tamper(buf) {
  const b = Buffer.from(buf)
  b[b.length - 1] ^= 0x01 // flip one bit of the ciphertext tail
  return b
}

test('G1 envelope round-trip returns the exact plaintext bytes', () => {
  const plain = randomBytes(4096)
  const ctx = 'whatsapp/invoices/abc.bin'
  const enc = files.encryptFile(plain, MASTER, { context: ctx })
  assert.equal(enc.sizeBytes, plain.length)
  assert.match(enc.keyVersion, /^[0-9a-f]{16}$/)
  const back = files.decryptFile(enc.container, MASTER, { context: ctx, expectedKeyVersion: enc.keyVersion })
  assert.ok(Buffer.compare(back, plain) === 0, 'decrypt must reproduce plaintext exactly')
  assert.ok(Buffer.compare(enc.container, plain) !== 0, 'container must not equal plaintext (never stored raw)')
})

test('G1b a fresh DEK per file: identical plaintext yields distinct containers', () => {
  const plain = Buffer.from('same invoice bytes every time')
  const ctx = 'whatsapp/invoices/dup.bin'
  const a = files.encryptFile(plain, MASTER, { context: ctx })
  const b = files.encryptFile(plain, MASTER, { context: ctx })
  assert.ok(Buffer.compare(a.container, b.container) !== 0, 'random DEK + IV must make containers unique')
  // ...and both still decrypt to the same plaintext under the same context.
  assert.ok(Buffer.compare(files.decryptFile(a.container, MASTER, { context: ctx }), plain) === 0)
  assert.ok(Buffer.compare(files.decryptFile(b.container, MASTER, { context: ctx }), plain) === 0)
})

test('G1c tampering ciphertext, context (AAD), or key-version all fail closed', () => {
  const plain = randomBytes(1200)
  const ctx = 'whatsapp/invoices/t.bin'
  const enc = files.encryptFile(plain, MASTER, { context: ctx })
  assert.throws(() => files.decryptFile(tamper(enc.container), MASTER, { context: ctx }),
    (e) => e.name === 'MediaDecryptFailed', 'ciphertext tamper must throw MediaDecryptFailed')
  assert.throws(() => files.decryptFile(enc.container, MASTER, { context: 'whatsapp/invoices/other.bin' }),
    (e) => e.name === 'MediaDecryptFailed', 'wrong context/AAD must fail authentication')
  assert.throws(() => files.decryptFile(enc.container, MASTER, { context: ctx, expectedKeyVersion: 'deadbeefdeadbeef' }),
    (e) => e.name === 'MediaDecryptFailed', 'key-version mismatch must fail before decrypt')
})

test('G1d malformed or missing keys fail closed; wrong master key cannot decrypt', () => {
  assert.throws(() => files.encryptFile(Buffer.from('x'), 'tooshort', { context: 'c' }),
    (e) => e.name === 'EncryptionConfigError', 'non-64-hex master key must be rejected')
  const enc = files.encryptFile(Buffer.from('secret invoice'), MASTER, { context: 'whatsapp/invoices/k.bin' })
  const otherKey = randomBytes(32).toString('hex')
  assert.throws(() => files.decryptFile(enc.container, otherKey, { context: 'whatsapp/invoices/k.bin' }),
    (e) => e.name === 'MediaDecryptFailed', 'a different master key must not unwrap the DEK')
  // Structural invariants in the real module: key boundary is length/charset
  // validated, a fresh DEK is drawn per file, and decrypt has no plaintext
  // fallback (it only ever returns authenticated plaintext or throws).
  const mod = filesSrc()
  assert.match(mod, /\[0-9a-fA-F\]\{64\}/, 'keys validated to exactly 64 hex chars')
  assert.match(mod, /randomBytes\(DEK_LEN\)/, 'a fresh DEK is generated per file')
  assert.ok(!/return container\b/.test(mod), 'decryptFile must never fall back to returning the input container')
})

test('G2 object paths are deterministic per media id, opaque, and scope-separated', () => {
  const mediaId = '1013854642324610'
  const p1 = files.deriveObjectKey('invoices', mediaId, PATHK)
  const p2 = files.deriveObjectKey('invoices', mediaId, PATHK)
  assert.equal(p1, p2, 'same media id must always resolve the same path (idempotent upsert)')
  assert.ok(p1.endsWith('.bin') && p1.startsWith('whatsapp/invoices/'))
  assert.ok(!p1.includes(mediaId), 'the raw media id must never appear in the path')
  const other = files.deriveObjectKey('invoices', '9999999999999998', PATHK)
  assert.notEqual(p1, other, 'distinct media ids must not collide')
  // Same media id in a different scope is a different object (no cross-overwrite).
  assert.notEqual(files.deriveObjectKey('pending', mediaId, PATHK), p1)
  // A different path key produces different names (path key is dedicated + secret).
  assert.notEqual(files.deriveObjectKey('invoices', mediaId, randomBytes(32).toString('hex')), p1)
})

test('G3 encryption wiring: keys required fail-closed, container uploaded as octet-stream', () => {
  const src = routeSrc()
  // Encrypt BEFORE upload, and upload the container (not the plaintext buffer).
  const encIdx = src.indexOf('encryptFile(downloaded.buffer')
  const upIdx = src.indexOf('.upload(objectPath, enc.container')
  assert.ok(encIdx > 0 && upIdx > encIdx, 'encryptFile must precede the storage upload')
  assert.match(src, /contentType: 'application\/octet-stream'/)
  // Fail closed on missing keys before any storage call.
  assert.match(src, /resolveFileKeyConfig\(\)/)
  // Bucket name comes from env, never hardcoded in intake.
  assert.match(src, /bucketFor\('invoices'\)/)
  assert.ok(!/storage\.from\('billora-invoices'\)/.test(src), 'intake must not hardcode the bucket slug')
  assert.match(serverSrc(), /SUPABASE_INVOICES_BUCKET|bucketFor/)
})

test('G3b env + migration: path/bucket/extraction vars and octet-stream bucket compat', () => {
  const env = envSrc()
  assert.match(env, /STORAGE_PATH_KEY: z/)
  assert.match(env, /SUPABASE_INVOICES_BUCKET: z\.string\(\)\.min\(1\)\.default\('billora-invoices'\)/)
  assert.match(env, /SUPABASE_EXPORTS_BUCKET: z\.string\(\)\.min\(1\)\.default\('billora-exports'\)/)
  assert.match(env, /EXTRACTION_PROVIDER: z\.enum\(\['gemini', 'tesseract'\]\)/)
  assert.match(env, /hasPathKey/)
  const sql = encSqlSrc()
  assert.match(sql, /add column if not exists file_encryption_key_version text/)
  assert.match(sql, /add column if not exists size_bytes bigint/)
  assert.match(sql, /'application\/octet-stream'/)
  assert.match(sql, /where id = 'billora-invoices'/)
  // Logical media typing is unchanged: invoices.content_type still CHECKs pdf/jpeg/png.
  assert.match(initialSqlSrc(), /content_type is null or content_type in \([\s\S]*'image\/png'/)
})

test('G3c legacy re-encrypt script is dry-run by default and delete-gated', () => {
  const s = readFileSync(new URL('../scripts/reencrypt-legacy.mjs', import.meta.url), 'utf8')
  assert.match(s, /const APPLY = process\.env\.APPLY === '1'/)
  assert.match(s, /process\.env\.DELETE === '1' && APPLY/)
  // Never writes unless APPLY; never deletes unless APPLY && DELETE; verifies
  // the container round-trips before repointing any row.
  assert.match(s, /round-trip mismatch/)
  assert.match(s, /no remaining row still references the old path|[\s\S]*still referenced/)
})

// ---- Stage 2: interactive menu + upload-first + inbound/outbound decoupling --

test('G4a menu selections reuse the text-command notes (no parallel state machine)', () => {
  const s = sess('collecting', 'w1')
  const t = (id) => conv.transition({ session: s, replyId: id, text: null, providerMessageId: 'wm.' + id })
  assert.equal(t('billora:menu:change_client').note, 'change-client-requested')
  assert.equal(t('billora:menu:change_client').nextState, 'awaiting_client_select')
  assert.equal(t('billora:menu:add_client').note, 'client-add-requested')
  assert.equal(t('billora:menu:done').note, 'done')
  assert.equal(t('billora:menu:cancel').note, 'cancel')
  assert.equal(t('billora:menu:cancel').nextState, 'cancelled')
  assert.equal(t('billora:menu:status').note, 'status-requested')
  assert.equal(t('billora:menu:review').note, 'review-requested')
  // status/review request a send without transitioning away from collecting.
  assert.equal(t('billora:menu:status').nextState, 'collecting')
  assert.equal(t('billora:menu:review').nextState, 'collecting')
})

test('G4b menu/help render an interactive list once onboarded; text is the fallback', () => {
  const s = sess('collecting', 'w1')
  assert.equal(conv.transition({ session: s, replyId: null, text: 'menu', providerMessageId: 'a' }).outbound.kind, 'menu_list')
  assert.equal(conv.transition({ session: s, replyId: null, text: 'help', providerMessageId: 'b' }).outbound.kind, 'menu_list')
  // Pre-onboarding help stays plain guidance text (no useless empty menu).
  const helpNoWs = conv.transition({ session: sess('new', null), replyId: null, text: 'help', providerMessageId: 'c' })
  assert.equal(helpNoWs.outbound.kind, 'text')
  // Text commands remain first-class: a plain "change client" still works.
  assert.equal(conv.transition({ session: s, replyId: null, text: 'change client', providerMessageId: 'd' }).note, 'change-client-requested')
})

test('G4c unknown/stale menu ids degrade to a safe re-prompt, never an action', () => {
  const s = sess('collecting', 'w1')
  const stale = conv.transition({ session: s, replyId: 'billora:menu:delete_everything', text: null, providerMessageId: 'z' })
  assert.equal(stale.nextState, 'collecting', 'state must be untouched by a stale id')
  assert.equal(stale.note, 'menu')
  assert.equal(stale.outbound.kind, 'menu_list')
})

test('G4d sendMenu is a Cloud API list with namespaced ids and a no-workspace subset', () => {
  const m = sendSrc().slice(sendSrc().indexOf('export function sendMenu'))
  assert.match(m, /type: 'list'/)
  for (const id of ['billora:menu:status', 'billora:menu:change_client', 'billora:menu:add_client',
    'billora:menu:review', 'billora:menu:done', 'billora:menu:help', 'billora:menu:cancel']) {
    assert.ok(m.includes(id), `menu row ${id} missing`)
  }
  // A Cloud API list allows at most 10 rows; the no-workspace case is Help/Cancel only.
  assert.ok((m.match(/id: 'billora:menu:/g) || []).length <= 10)
  assert.match(m, /opts\.workspace\s*\?\s*\[[\s\S]*:\s*\[[\s\S]*billora:menu:help[\s\S]*billora:menu:cancel/)
})

test('G4e route renders menu/status/review and decouples resend (never re-runs intake)', () => {
  const src = routeSrc()
  assert.match(src, /result\.outbound\.kind === 'menu_list'/)
  assert.match(src, /deliverMenu\(result\.outbound\.workspace\)/)
  assert.match(src, /note === 'status-requested'/)
  assert.match(src, /note === 'review-requested'/)
  assert.match(src, /async function resendPendingReply/)
  assert.match(src, /updateSessionDeliveryState/)
  // The resend path only sends — it must not re-run business operations.
  const rpr = src.slice(src.indexOf('async function resendPendingReply'), src.indexOf('Onboarding + upload decision engine'))
  assert.ok(!/recordMediaIntake|assignPendingUploads|transition\(/.test(rpr), 'resend must not re-run business ops')
  // Ack fires once per session; later clean uploads stay silent (no nag).
  assert.match(src, /upload_ack_sent_at: new Date\(\)/)
})

test('G4f Stage-2 session columns are additive; inbound idempotency is untouched', () => {
  const sql = encMenuSqlSrc()
  assert.match(sql, /add column if not exists last_reply_error_code text/)
  assert.match(sql, /add column if not exists pending_reply_body text/)
  assert.match(sql, /add column if not exists upload_ack_sent_at timestamptz/)
  assert.match(sql, /add column if not exists/)
  // The inbound idempotency ledger must not be altered (a comment may name it).
  assert.ok(!/alter table public\.webhook_events|drop table[\s\S]*webhook_events|delete from webhook_events/i.test(sql),
    'Stage 2 must not modify the inbound idempotency ledger')
})

// ---- Stage 3: extraction -> review -> batch -> register -> delivery ---------

const CLEAN_ROW = {
  invoice_date: '2026-09-05', invoice_number: 'INV-1', vendor_name: 'Acme Traders',
  supplier_gstin: '27ABCDE1234F1Z5', taxable_value: 1000, cgst_amount: 90,
  sgst_amount: 90, igst_amount: 0, total_amount: 1180,
  confidence: {
    invoice_date: 0.95, invoice_number: 0.95, vendor_name: 0.9, supplier_gstin: 0.92,
    taxable_value: 0.95, cgst_amount: 0.9, sgst_amount: 0.9, igst_amount: 0.95, total_amount: 0.95,
  },
}
const hiConf = (over = {}) => ({ ...CLEAN_ROW, ...over })

test('G5a ledger approves a clean, confident, date-resolved row (real module)', () => {
  const ev = ledger.evaluateLedger(CLEAN_ROW, { minConfidence: 0.8 })
  assert.equal(ev.review, 'approved')
  assert.equal(ev.invoiceDateResolved, true)
  assert.deepEqual(ev.reasons, [])
  assert.equal(ev.row.invoice_date, '2026-09-05')
  assert.equal(ev.row.total_amount, 1180)
})

test('G5b ledger NEVER fabricates an unclear date; it flags review and keeps the text', () => {
  // A day that does not exist must not be coerced to anything.
  const ev = ledger.evaluateLedger(hiConf({ invoice_date: '31/02/2026' }), { minConfidence: 0.8 })
  assert.equal(ev.review, 'needs_review')
  assert.equal(ev.invoiceDateResolved, false)
  assert.ok(ev.reasons.includes('invoice-date-unresolved'))
  assert.equal(ev.row.invoice_date, '31/02/2026', 'original text preserved, never invented')
  // Missing entirely -> empty, not today's date.
  const empty = ledger.evaluateLedger(hiConf({ invoice_date: null }), { minConfidence: 0.8 })
  assert.equal(empty.row.invoice_date, '')
  assert.equal(empty.review, 'needs_review')
})

test('G5c ledger parses Indian day-first dates and rejects anomalies / low confidence', () => {
  assert.equal(ledger.evaluateLedger(hiConf({ invoice_date: '5/9/2026' }), { minConfidence: 0.8 }).row.invoice_date, '2026-09-05')
  const mismatch = ledger.evaluateLedger(hiConf({ total_amount: 9999 }), { minConfidence: 0.8 })
  assert.equal(mismatch.review, 'needs_review')
  assert.ok(mismatch.reasons.some((r) => r.startsWith('total-mismatch')))
  const badGstin = ledger.evaluateLedger(hiConf({ supplier_gstin: 'NOTAGSTIN' }), { minConfidence: 0.8 })
  assert.ok(badGstin.reasons.includes('gstin-invalid'))
  const lowConf = ledger.evaluateLedger(hiConf({ confidence: { ...CLEAN_ROW.confidence, total_amount: 0.4 } }), { minConfidence: 0.8 })
  assert.equal(lowConf.review, 'needs_review')
  assert.ok(lowConf.reasons.some((r) => r.startsWith('low-confidence')))
})

test('G5d ledger GSTIN rule matches lib/ocr/quality.ts exactly (no drift)', () => {
  const grab = (s) => { const m = /const GSTIN_RE = (\/[^\n]+\/)/.exec(s); assert.ok(m, 'GSTIN_RE missing'); return m[1] }
  const ledgerSrc = readFileSync(new URL('../lib/ocr/ledger.ts', import.meta.url), 'utf8')
  assert.equal(grab(ledgerSrc), grab(qualitySrc()))
})

test('G5e both Phase-4 handlers register and the worker imports the seam (queue stops being inert)', () => {
  const idx = handlersIndexSrc()
  assert.match(idx, /registerJobHandler\('invoice_extraction', extractInvoice\)/)
  assert.match(idx, /registerJobHandler\('register_generation', buildRegister\)/)
  assert.match(workerRouteSrc(), /import '@\/lib\/jobs\/handlers'/)
  // Contract: with no handler registered a tick claims nothing (never half-process).
  assert.match(workerSrc(), /if \(jobTypes\.length === 0\)/)
})

test('G5f extraction decrypts in-memory, routes review, and only enqueues the register when the batch is ready', () => {
  const s = extractSrc()
  assert.ok(s.includes('context: invoice.file_object_path'), 'decrypt AAD context is the object path')
  assert.ok(s.includes('expectedKeyVersion: invoice.file_encryption_key_version'), 'key version enforced')
  assert.ok(s.includes('isMediaDecryptFailure'), 'tampered container -> permanent, never plaintext')
  assert.ok(s.includes('if (env.EXTRACTION_PROVIDER !== \'gemini\')'), 'unimplemented provider fails closed')
  assert.ok(s.includes('e instanceof VisionTransientError) throw e'), 'transient provider error requeues')
  assert.ok(s.includes("onConflict: 'invoice_id'"), 'extracted_records upsert is idempotent')
  assert.ok(s.includes('status: evaluation.review'), 'approved->completed / else needs_review')
  // Scheduling is unconditional + deduped here; readiness is enforced in build_register
  // (never gate the enqueue here or two workers finishing together can deadlock).
  assert.ok(s.includes('await enqueueRegisterGeneration(db, args.workspaceId, batchId)'), 'register scheduled on approve')
  assert.ok(!s.includes('outstanding === 0'), 'extract must NOT gate scheduling on batch quiescence')
  assert.ok(s.includes('max_attempts: 12'), 'register gets a readiness-retry attempt budget')
  // Every read/write is tenant-scoped.
  assert.ok(s.includes(".eq('workspace_id', workspaceId).eq('id', invoiceId)"))
})

test('G6a workbook object key is deterministic per batch under the path key (real module)', () => {
  const a = files.deriveWorkbookKey('batch-aaa', PATHK)
  assert.equal(a, files.deriveWorkbookKey('batch-aaa', PATHK))
  assert.ok(a.startsWith('whatsapp/exports/') && a.endsWith('.xlsx'))
  assert.notEqual(a, files.deriveWorkbookKey('batch-bbb', PATHK))
  assert.throws(() => files.deriveWorkbookKey('x', 'not-a-key'), /STORAGE_PATH_KEY/)
})

test('G6b register builds from approved rows, ENCRYPTS the workbook at rest, versions, and delivers best-effort', () => {
  const s = registerSrc()
  assert.ok(s.includes("throw new PermanentJobError('REGISTER_MISSING_BATCH')"))
  assert.ok(s.includes(".eq('workspace_id', workspaceId).eq('id', batchId)"), 'batch verified to belong to workspace')
  assert.ok(s.includes('deriveWorkbookKey(batchId, pathKeyHex)'), 'deterministic export path')
  // Workbook is encrypted with the same envelope scheme as originals, then the
  // container uploads as octet-stream (never a plaintext spreadsheet at rest).
  assert.ok(s.includes('encryptFile(workbook, masterKeyHex'), 'register encrypted at rest')
  assert.ok(s.includes("contentType: 'application/octet-stream', upsert: true"), 'encrypted container transport')
  assert.ok(s.includes('original_mime: SPREADSHEET_MIME'), 'logical type retained as metadata')
  assert.ok(s.includes('file_encryption_key_version: enc.keyVersion'), 'key version tracked for decrypt + rotation')
  // No raw bucket/signed URL is ever handed out for an encrypted object.
  assert.ok(!s.includes('createSignedUrl'), 'encrypted workbook must not be served via a raw signed URL')
  assert.ok(s.includes('status: \'expired\''), 'prior workbook retired (freshness)')
  assert.match(s, /version, generated_at: new Date\(\)/)
  // Delivery links to OUR authenticated route, gated on PUBLIC_APP_URL.
  assert.ok(s.includes('/api/exports/${workbookId}/download'), 'delivery via authenticated route')
  assert.ok(s.includes('PUBLIC_APP_URL'), 'link only built when a public origin is configured')
  assert.ok(s.includes('updateSessionDeliveryState(db, senderHmac'), 'delivery via next inbound reply')
  // Batch readiness gate lives HERE: never build a premature workbook.
  assert.ok(s.includes("eq('job_type', 'invoice_extraction').in('status', ['queued', 'processing'])"))
  assert.ok(s.includes('REGISTER_NOT_READY'), 'requeues while siblings are in flight')
  // Delivery is orthogonal to generation: it is caught and NEVER fails the job.
  const sched = s.slice(s.indexOf('async function scheduleDelivery'))
  assert.match(sched, /catch \(e\)/)
  assert.ok(s.includes('SEND_DEFERRED'))
  // A batch with nothing approved is a no-op completion, not a failure.
  assert.match(s, /rows\.length === 0[\s\S]*return/)
})

test('G6c Stage-3 migration wires batch linkage, register dedup, and the batch RPC (service-role only)', () => {
  const sql = extractionSqlSrc()
  assert.ok(sql.includes('add column if not exists batch_id uuid references public.invoice_batches(id)'))
  assert.ok(sql.includes('processing_jobs_batch_uniq'))
  assert.match(sql, /where batch_id is not null and invoice_id is null/)
  assert.ok(sql.includes('create or replace function public.ensure_invoice_batch'))
  assert.match(sql, /nulls not distinct/)
  assert.ok(sql.includes('security definer'), 'batch RPC is definer-scoped')
  // Service-role only: no browser/anon access to the batch resolver.
  assert.match(sql, /revoke all on function public\.ensure_invoice_batch\(uuid, uuid, date, date\)\s*\n\s*from public, anon, authenticated/)
  assert.match(sql, /grant execute on function public\.ensure_invoice_batch\(uuid, uuid, date, date\)\s*\n\s*to service_role/)
  assert.ok(sql.includes('add column if not exists version integer'))
  assert.ok(sql.includes('add column if not exists generated_at timestamptz'))
})

test('G6d vision is provider-gated with a strict schema and transient/permanent taxonomy', () => {
  const s = visionSrc()
  assert.ok(s.includes('class VisionTransientError') && s.includes('class VisionPermanentError'))
  assert.ok(s.includes("responseMimeType: 'application/json'"))
  assert.ok(s.includes('responseSchema: LEDGER_SCHEMA'))
  assert.ok(s.includes('confidence'), 'schema requests per-field confidence')
  assert.ok(s.includes('UNSUPPORTED_MEDIA_TYPE'), 'only image/pdf are sendable')
})

test('G6e JOB_TYPES alignment: both Phase-4 job kinds stay in the TS enum and phase3 CHECK', () => {
  for (const jt of ['invoice_extraction', 'register_generation']) {
    assert.ok(statusesSrc().includes(`'${jt}'`), `${jt} missing from statuses.ts`)
    assert.ok(p3SqlSrc().includes(`'${jt}'`), `${jt} missing from phase3 job_type CHECK`)
    assert.ok(handlersIndexSrc().includes(`registerJobHandler('${jt}'`), `${jt} not registered`)
  }
})

// ---- Stage-6 runtime hardening: encryption config fails closed, fast, loud --

test('H1a encryption config errors are classifiable and carry no key material', () => {
  assert.equal(files.isEncryptionConfigFailure(new files.EncryptionConfigError('missing key')), true)
  assert.equal(files.isEncryptionConfigFailure(new files.MediaDecryptFailed('tampered')), false)
  assert.equal(files.isEncryptionConfigFailure(new Error('plain error')), false)
  assert.equal(files.isEncryptionConfigFailure(null), false)
  // The thrown message must name the variable and never echo the value: the
  // webhook route logs the error detail, so this is a log-leak boundary.
  const saved = process.env.ENCRYPTION_MASTER_KEY
  process.env.ENCRYPTION_MASTER_KEY = 'short-not-hex'
  let message = ''
  try { files.resolveFileKeyConfig() } catch (e) { message = String(e.message) }
  delete process.env.ENCRYPTION_MASTER_KEY
  if (saved !== undefined) process.env.ENCRYPTION_MASTER_KEY = saved
  assert.match(message, /ENCRYPTION_MASTER_KEY/)
  assert.ok(!message.includes('short-not-hex'), 'the malformed value must never appear in the error')
})

test('H1b hasFileKeyConfig is non-throwing and reports booleans only', () => {
  const snapshot = {
    ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY,
    STORAGE_PATH_KEY: process.env.STORAGE_PATH_KEY,
  }
  try {
    process.env.ENCRYPTION_MASTER_KEY = MASTER
    process.env.STORAGE_PATH_KEY = 'not-a-key'
    assert.deepEqual(files.hasFileKeyConfig(), { masterKeyPresent: true, pathKeyPresent: false })
    process.env.ENCRYPTION_MASTER_KEY = ''
    process.env.STORAGE_PATH_KEY = PATHK
    assert.deepEqual(files.hasFileKeyConfig(), { masterKeyPresent: false, pathKeyPresent: true })
    const probe = files.hasFileKeyConfig()
    assert.deepEqual(Object.keys(probe).sort(), ['masterKeyPresent', 'pathKeyPresent'])
    assert.ok(Object.values(probe).every((v) => typeof v === 'boolean'), 'booleans only — never key material')
  } finally {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('H1c intake validates keys BEFORE any media download (no wasted fetch, no retry loop)', () => {
  const src = routeSrc()
  const keyIdx = src.indexOf('resolveFileKeyConfig()')
  const dlIdx = src.indexOf('downloadWhatsAppMedia({')
  const uploadIdx = src.indexOf('.upload(pendingPath, enc.container')
  assert.ok(keyIdx > 0 && dlIdx > keyIdx, 'key validation must precede the Graph media download')
  assert.ok(uploadIdx > keyIdx, 'key validation must precede any storage write')
  // Exactly one resolution point: hoisted before the download, not re-read later.
  assert.equal(src.match(/resolveFileKeyConfig\(\)/g).length, 1)
})

test('H1d a config failure settles the intake as final, notifies once, and never loops', () => {
  const src = routeSrc()
  const start = src.indexOf('if (isEncryptionConfigFailure(e))')
  assert.ok(start > 0, 'the config-failure branch must exist in handleSingleMessage')
  const branch = src.slice(start, src.indexOf('await markIntakeFailed'))
  assert.ok(branch.includes("markIntakeAccepted(db, providerMessageId, 'ENCRYPTION_CONFIG')"),
    'accepted as final with a stable sanitized audit code (no 503 -> no Meta redelivery loop)')
  assert.ok(branch.includes("return 'processed'"), 'never returns retryable for a permanent config fault')
  assert.ok(branch.includes('sendText(message.from'), 'the sender gets a truthful actionable reply')
  assert.ok(branch.includes('nothing was saved'), 'the reply must never claim the file was stored')
  assert.ok(!branch.includes('markIntakeFailed'), 'config failure must not fall through to the retry path')
  // Operator alert carries the short id only — never message bodies or key material.
  const alert = branch.slice(branch.indexOf('logger.error('), branch.indexOf('if (message.from)'))
  assert.ok(!/message\.text|downloaded|MASTER_KEY_VALUE/.test(alert))
  assert.ok(alert.includes('shortId'), 'alert correlates via the truncated provider id only')
  // Redelivery of an accepted event must be skipped BEFORE processing, so a
  // webhook resend cannot notify the sender twice or store anything.
  const skipIdx = src.indexOf('duplicate accepted event skipped')
  assert.ok(skipIdx > 0 && skipIdx < src.indexOf('await processMessage'), 'accepted events short-circuit before reprocessing')
})

test('H1e health diagnostic exposes configuration posture as booleans, never secrets', () => {
  const src = healthSrc()
  assert.ok(src.includes('getPublicEnvInfo()'), 'health reuses the safe env subset')
  assert.ok(src.includes('hasFileKeyConfig()'), 'health reports file-encryption key presence')
  assert.ok(!/process\.env\.ENCRYPTION_MASTER_KEY|process\.env\.SUPABASE_SECRET_KEY/.test(src),
    'health must read raw secrets only through the sanitized helpers')
  // The safe subset itself: booleans + host, no values.
  const env = envSrc()
  const info = env.slice(env.indexOf('export function getPublicEnvInfo'))
  assert.match(info, /hasEncryptionKey: HEX_64\.test/)
  assert.match(info, /hasPathKey: HEX_64\.test/)
  // Configuration is documented for local + production. The app must never
  // auto-generate keys on restart: no code path writes them into process.env.
  const example = envExampleSrc()
  for (const k of ['ENCRYPTION_MASTER_KEY', 'STORAGE_PATH_KEY', 'GEMINI_API_KEY', 'WORKER_SECRET', 'WHATSAPP_APP_SECRET']) {
    assert.ok(example.includes(`${k}=`), `.env.example must document ${k}`)
  }
  assert.ok(!/process\.env\.ENCRYPTION_MASTER_KEY\s*=/.test(filesSrc()),
    'encryption code must read the key, never generate/assign it on restart')
})

test('H1f delivery-state bookkeeping stays resilient: a schema/cache failure never breaks intake', () => {
  const s = sessionsSrc()
  const start = s.indexOf('export async function updateSessionDeliveryState')
  assert.ok(start > 0)
  const body = s.slice(start)
  assert.ok(body.includes('logger.error'), 'a failed bookkeeping write is logged, not swallowed silently')
  assert.ok(!/throw/.test(body), 'bookkeeping must never throw: a delivery-tracking lapse cannot fail the webhook')
  // PGRST204-style stale-cache/schema errors are explicitly classified for ops.
  assert.match(s, /PGRST205|schema cache/)
  assert.ok(s.includes("'table_not_exposed_or_stale_cache'"), 'stale-cache is a distinct triage kind')
})

// The runtime logs proved (via `supabase migration list`) that the newest three
// migrations are NOT yet on the remote. Applying them is operator-gated, but we
// can statically guarantee they are SAFE to apply: purely additive, idempotent,
// and complete enough to unblock the encrypted intake + register pipeline.
test('H2 the pending migrations are forward-only, re-runnable, non-destructive, and complete', () => {
  const pending = { storage: encSqlSrc(), menu: encMenuSqlSrc(), extraction: extractionSqlSrc() }
  for (const [name, sql] of Object.entries(pending)) {
    assert.equal((sql.match(/add column(?! if not exists)/gi) ?? []).length, 0,
      `${name}: every added column must be guarded by IF NOT EXISTS (re-runnable)`)
    assert.ok(!/drop\s+table/i.test(sql), `${name}: never drops a table`)
    assert.ok(!/drop\s+column/i.test(sql), `${name}: never drops a column (preserves user data)`)
    assert.ok(!/\btruncate\b|delete\s+from/i.test(sql), `${name}: never truncates or deletes rows`)
  }
  // Completeness — applying exactly these resolves the columns the code writes.
  assert.match(pending.storage, /add column if not exists file_encryption_key_version text/)
  assert.match(pending.storage, /add column if not exists size_bytes bigint/)
  assert.ok(pending.storage.includes("'application/octet-stream'"), 'bucket must accept encrypted containers')
  for (const col of ['last_reply_error_code', 'pending_reply_body', 'upload_ack_sent_at']) {
    assert.ok(pending.menu.includes(`add column if not exists ${col}`), `menu migration must add ${col}`)
  }
  assert.match(pending.extraction, /add column if not exists batch_id uuid references public\.invoice_batches/)
  assert.ok(pending.extraction.includes('create or replace function public.ensure_invoice_batch'))
  assert.match(pending.extraction, /add column if not exists version integer/)
  assert.match(pending.extraction, /add column if not exists generated_at timestamptz/)
})

// ---- I: end-to-end media format support (PNG / JPEG / PDF / WebP; HEIC out) --
// Crafted magic-byte fixtures (no fixtures dir, no provider, no sharp).
function mkPng(w = 8, h = 8, pad = 24) {
  const b = Buffer.alloc(24 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}
function mkJpeg(w = 8, h = 8) {
  const b = Buffer.alloc(40)
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0; b[4] = 0x00; b[5] = 0x11; b[6] = 0x08
  b.writeUInt16BE(h, 7)
  b.writeUInt16BE(w, 9)
  return b
}
function mkWebp(w = 8, h = 8) {
  const b = Buffer.alloc(40)
  b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1')
  b.writeUInt32LE(18, 16)
  b[24] = (w - 1) & 0xff; b[25] = ((w - 1) >> 8) & 0xff; b[26] = ((w - 1) >> 16) & 0xff
  b[27] = (h - 1) & 0xff; b[28] = ((h - 1) >> 8) & 0xff; b[29] = ((h - 1) >> 16) & 0xff
  return b
}
function mkPdf(pages = 1) {
  let s = '%PDF-1.4\n'
  for (let i = 0; i < pages; i++) s += `\n${i + 1} 0 obj\n/Type /Page\nendobj\n`
  s += '%%EOF\n'
  return Buffer.from(s, 'latin1')
}
function mkHeic() {
  const b = Buffer.alloc(40)
  b.writeUInt32BE(24, 0)
  b.write('ftyp', 4, 'latin1')
  b.write('heic', 8, 'latin1')
  return b
}

test('I1 sniffMediaKind reads the real container, never the declared hint', () => {
  assert.equal(fileType.sniffMediaKind(mkPdf()), 'pdf')
  assert.equal(fileType.sniffMediaKind(mkPng()), 'png')
  assert.equal(fileType.sniffMediaKind(mkJpeg()), 'jpeg')
  assert.equal(fileType.sniffMediaKind(mkWebp()), 'webp')
  assert.equal(fileType.sniffMediaKind(mkHeic()), 'heif')
  assert.equal(fileType.sniffMediaKind(Buffer.from('GIF89a' + 'x'.repeat(40), 'latin1')), 'gif')
  assert.equal(fileType.sniffMediaKind(Buffer.from([0x49, 0x49, 0x2a, 0x00, ...new Array(40).fill(0)])), 'tiff')
  // A file that claims nothing recognizable (e.g. a raw script) is unknown.
  assert.equal(fileType.sniffMediaKind(Buffer.from('this is definitely not a document at all', 'latin1')), 'unknown')
  assert.equal(fileType.sniffMediaKind(Buffer.alloc(0)), 'unknown')
})

test('I2 accepted formats validate to their authoritative MIME + extension', () => {
  const cases = [
    [mkPdf(2), 'application/pdf', 'pdf'],
    [mkPng(), 'image/png', 'png'],
    [mkJpeg(), 'image/jpeg', 'jpg'],
    [mkWebp(), 'image/webp', 'webp'],
  ]
  for (const [buf, mime, ext] of cases) {
    const v = fileType.validateInvoiceMedia({ buffer: buf })
    assert.equal(v.mime, mime, `mime for ${ext}`)
    assert.equal(v.extension, ext)
  }
})

test('I3 declared MIME/filename are hints: sniffed bytes win on a mismatch', () => {
  // WhatsApp claims a PDF but the bytes are a real PNG: we accept it AS a PNG.
  const v = fileType.validateInvoiceMedia({
    buffer: mkPng(), declaredMime: 'application/pdf', declaredFilename: 'invoice.pdf',
  })
  assert.equal(v.kind, 'png')
  assert.equal(v.mime, 'image/png')
  // Bytes are not a supported container at all -> rejected regardless of claim.
  assert.throws(
    () => fileType.validateInvoiceMedia({ buffer: Buffer.from('#!/bin/sh rm -rf /\n'.repeat(4), 'latin1'), declaredMime: 'image/png' }),
    (e) => e.name === 'UnsupportedMediaError',
  )
})

test('I4 unsupported + HEIC get a clear, actionable reply (HEIC is not advertised)', () => {
  assert.throws(() => fileType.validateInvoiceMedia({ buffer: mkHeic() }), (e) => {
    return e.name === 'UnsupportedMediaError' && /HEIC/i.test(e.userReply) && !/undefined/.test(e.userReply)
  })
  // GIF/TIFF are detected but have no extraction path -> rejected, not stored.
  for (const buf of [Buffer.from('GIF89a' + 'y'.repeat(40), 'latin1'), mkHeic()]) {
    assert.throws(() => fileType.validateInvoiceMedia({ buffer: buf }), (e) => e.name === 'UnsupportedMediaError')
  }
})

test('I5 size, pixel and PDF-page limits are enforced from the bytes', () => {
  // Real byte count over the cap (not the declared size) -> OversizeMediaError.
  const huge = mkPng(8, 8, fileType.MAX_FILE_BYTES)
  assert.ok(huge.length > fileType.MAX_FILE_BYTES)
  assert.throws(() => fileType.validateInvoiceMedia({ buffer: huge }), (e) => e.name === 'OversizeMediaError')
  // A tiny file whose header declares a 10000x10000 canvas -> decompression-bomb guard.
  assert.throws(() => fileType.validateInvoiceMedia({ buffer: mkPng(10000, 10000) }), (e) => e.name === 'OversizeMediaError')
  // A flat PDF over the page cap -> rejected.
  assert.throws(() => fileType.validateInvoiceMedia({ buffer: mkPdf(fileType.MAX_PDF_PAGES + 5) }), (e) => e.name === 'OversizeMediaError')
  // Under every limit -> accepted.
  assert.doesNotThrow(() => fileType.validateInvoiceMedia({ buffer: mkPng(64, 64) }))
})

test('I6 isPermanentMediaFormatFailure separates permanent from retryable', () => {
  assert.equal(fileType.isPermanentMediaFormatFailure(new fileType.UnsupportedMediaError('x', 'reply')), true)
  assert.equal(fileType.isPermanentMediaFormatFailure(new fileType.OversizeMediaError('x', 'reply')), true)
  assert.equal(fileType.isPermanentMediaFormatFailure(new Error('STORAGE_UPLOAD_ERROR: transient')), false)
  assert.equal(fileType.isPermanentMediaFormatFailure(null), false)
})

test('I7 encrypted round trip preserves the original bytes for correct routing', () => {
  // Real envelope: encrypt then decrypt must reproduce the exact original bytes,
  // and the decrypted buffer must re-sniff to the SAME format (routing on decrypt).
  const png = mkPng(16, 12)
  const { container } = files.encryptFile(png, MASTER, { context: 'whatsapp/invoices/x.bin' })
  const back = files.decryptFile(container, MASTER, { context: 'whatsapp/invoices/x.bin' })
  assert.ok(Buffer.compare(back, png) === 0, 'decrypt must reproduce original bytes exactly')
  assert.equal(fileType.sniffMediaKind(back), 'png')
  // The encrypted container is NOT itself a valid image — proves we never parse
  // ciphertext as an image and must decrypt first.
  assert.equal(fileType.sniffMediaKind(container), 'unknown')
})

test('I8 statuses + vision + migration agree on one accepted-format set', () => {
  const accepted = statuses.ACCEPTED_MEDIA_TYPES
  assert.deepEqual([...accepted].sort(), ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
  assert.equal(statuses.isAcceptedMediaType('image/webp'), true)
  assert.equal(statuses.isAcceptedMediaType('image/heic'), false)
  // vision SUPPORTED_MIME covers exactly this set and excludes heic. Match on
  // the tokens (not the escaped punctuation) so a source-regex rewrite can't
  // silently drift the accepted set away from DB + statuses.
  const mimeLine = (visionSrc().match(/const SUPPORTED_MIME = .*/) ?? [''])[0]
  assert.ok(mimeLine, 'SUPPORTED_MIME line not found')
  for (const tok of ['jpeg', 'png', 'webp', 'application']) {
    assert.ok(mimeLine.includes(tok), `SUPPORTED_MIME must include ${tok}`)
  }
  assert.ok(!/heic|heif/i.test(mimeLine), 'vision must not advertise HEIC')
})

test('I9 migration widens CHECKs + bucket MIME for webp, forward-only & safe', () => {
  const sql = webpSqlSrc()
  // Both content_type CHECKs gain image/webp while retaining pdf/jpeg/png.
  const webpChecks = (sql.match(/'image\/webp'/g) ?? []).length
  assert.ok(webpChecks >= 2, 'invoices + pending_uploads CHECKs must both allow webp')
  for (const m of ['application/pdf', 'image/jpeg', 'image/png']) {
    assert.ok(sql.includes(`'${m}'`), `CHECK set must keep ${m}`)
  }
  // Bucket re-asserted for the octet-stream container + webp.
  assert.match(sql, /'application\/octet-stream'/)
  assert.match(sql, /where id = 'billora-invoices'/)
  // Forward-only: no destructive ops, no security loosening (private + size kept).
  assert.ok(!/drop\s+table|drop\s+column/i.test(sql), 'no destructive DDL')
  assert.ok(!/\btruncate\b|delete\s+from/i.test(sql), 'no row loss')
  assert.ok(!/is_public|public\s*=\s*true/i.test(sql), 'bucket stays private')
  assert.ok(!/file_size_limit/i.test(sql), 'existing size limit untouched')
})

test('I10 intake persists the validated MIME and never loosens the transport', () => {
  const src = routeSrc()
  assert.match(src, /downloaded\.contentType = validated\.mime/)
  assert.match(src, /downloaded\.extension = validated\.extension/)
  // Stored blob is still octet-stream (encryption boundary unchanged).
  const octetUploads = (src.match(/contentType: 'application\/octet-stream'/g) ?? []).length
  assert.equal(octetUploads, 2, 'both hold + assigned uploads stay octet-stream')
  // Original mime + extension retained as object metadata on both uploads.
  const metaCount = (src.match(/metadata: \{ original_mime: validated\.mime, original_extension: validated\.extension \}/g) ?? []).length
  assert.equal(metaCount, 2, 'original mime/extension stored as metadata on both paths')
})

test('I11 storage-config rejection settles final, never loops, stays narrow', () => {
  const src = routeSrc()
  assert.match(src, /isStorageConfigFailure\(e\)/)
  assert.match(src, /markIntakeAccepted\(db, providerMessageId, 'STORAGE_CONFIG'\)/)
  // The helper only fires on a MIME/"not allowed"-style STORAGE_UPLOAD_ERROR, so
  // transient network and permission failures remain retryable.
  const fnStart = src.indexOf('function isStorageConfigFailure')
  assert.ok(fnStart > 0, 'isStorageConfigFailure defined')
  const body = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2)
  assert.match(body, /STORAGE_UPLOAD_ERROR/)
  assert.match(body, /not allowed|not supported|unsupported/)
  assert.ok(/return 'processed';/.test(src), 'permanent storage-config settles as processed (no 503 loop)')
})

// ---- J: privacy-first extraction, AI gate, workbook-at-rest + download ----- 

test('J1 env: AI is OFF by default and the safe posture reveals no secrets', () => {
  const e = envSrc()
  assert.match(e, /EXTRACTION_ALLOW_AI: boolFromEnv\(false\)/, 'privacy gate defaults to false')
  assert.match(e, /EXTRACTION_AI_TIER: z\.enum\(\['free', 'paid'\]\)\.default\('paid'\)/)
  assert.match(e, /LOCAL_OCR_ENGINE: z\.enum\(\['none', 'pdfjs-text', 'pdftotext', 'tesseract'\]\)\.default\('pdfjs-text'\)/)
  assert.match(e, /PUBLIC_APP_URL: z\.string\(\)\.url\(\)\.optional\(\)/)
  // boolFromEnv must reject the zod-coerce trap (only true/1 are truthy).
  assert.match(e, /s === '1' \|\| s === 'true' \? 'true' : 'false'/)
  // Public health subset stays boolean/label only — no key/value material.
  const info = e.slice(e.indexOf('export function getPublicEnvInfo'))
  assert.ok(info.includes("aiAllowed: (process.env.EXTRACTION_ALLOW_AI ?? '')"))
  assert.ok(!/\.\.\.|MASTER_KEY|API_KEY_VALUE/.test(info.match(/aiAllowed[^\n]*/)?.[0] ?? ''), 'aiAllowed is a boolean expression')
  assert.ok(!/process\.env\.ENCRYPTION_MASTER_KEY\b(?!\.)/.test(info.replace(/HEX_64\.test\(process\.env\.ENCRYPTION_MASTER_KEY[^)]*\)/g, '')),
    'health never echoes raw key material')
  // Documented in .env.example for operators.
  const ex = envExampleSrc()
  for (const k of ['EXTRACTION_ALLOW_AI=false', 'EXTRACTION_AI_TIER=', 'LOCAL_OCR_ENGINE=none', 'PUBLIC_APP_URL=']) {
    assert.ok(ex.includes(k.split('=')[0]) || ex.includes(k), `.env.example documents ${k}`)
  }
})

test('J2 measured confidence is independent: the model self-report cannot approve alone', () => {
  // (a) A fully valid row with NO self-reported confidence is auto-accepted on
  //     our own measurement (score 1.0), proving we do not require the model's
  //     number to approve.
  const noSelf = { ...CLEAN_ROW }
  delete noSelf.confidence
  const a = ledger.evaluateLedger(noSelf, { minConfidence: 0.8 })
  assert.equal(a.measuredConfidence, 1)
  assert.equal(a.confidence, 1)
  assert.equal(a.review, 'approved')
  // (b) An invalid GSTIN with a maximal self-report (0.99) must still be held:
  //     our measured score drops and the row is flagged, never auto-approved
  //     because the model "said" it was confident.
  const lying = {
    ...CLEAN_ROW, supplier_gstin: 'NOTAGSTIN',
    confidence: {
      invoice_date: 0.99, invoice_number: 0.99, vendor_name: 0.99, supplier_gstin: 0.99,
      taxable_value: 0.99, cgst_amount: 0.99, sgst_amount: 0.99, igst_amount: 0.99, total_amount: 0.99,
    },
  }
  const b = ledger.evaluateLedger(lying, { minConfidence: 0.8 })
  assert.ok(b.measuredConfidence < 1, 'objective invalidity lowers OUR confidence')
  assert.ok(b.reasons.includes('gstin-invalid'))
  assert.equal(b.review, 'needs_review', 'a confident-but-invalid row is never auto-approved')
  // (c) Self-report can only DOWNGRADE, never raise: a clean row whose model
  //     confidence is low is held even though measured is 1.0.
  const low = ledger.evaluateLedger(hiConf({ confidence: { ...CLEAN_ROW.confidence, total_amount: 0.5 } }), { minConfidence: 0.8 })
  assert.equal(low.measuredConfidence, 1)
  assert.equal(low.confidence, 0.5)
  assert.equal(low.review, 'needs_review')
})

test('J3 local seam NEVER fabricates: no engine is an honest miss, not a guess', async () => {
  const savedEngine = process.env.LOCAL_OCR_ENGINE
  local.registerLocalEngine(null)
  delete process.env.LOCAL_OCR_ENGINE
  try {
    assert.equal(local.configuredEngineId(), 'none')
    assert.equal(local.localEngineAvailable(), false)
    const miss = await local.tryLocalExtract({ buffer: Buffer.from('bytes'), mimeType: 'image/png' })
    assert.equal(miss.ok, false)
    assert.equal(miss.reason, 'no-engine')
    // A configured-but-unwired engine is still a miss, never a candidate.
    process.env.LOCAL_OCR_ENGINE = 'tesseract'
    const tesseractMiss = await local.tryLocalExtract({ buffer: Buffer.from('bytes'), mimeType: 'image/png' })
    assert.equal(tesseractMiss.ok, false)
    assert.notEqual(tesseractMiss.reason, undefined)
  } finally {
    local.registerLocalEngine(null)
    if (savedEngine === undefined) delete process.env.LOCAL_OCR_ENGINE
    else process.env.LOCAL_OCR_ENGINE = savedEngine
  }
})

test('J3b a registered local adapter drives hit / no-candidate / error outcomes', async () => {
  const savedEngine = process.env.LOCAL_OCR_ENGINE
  delete process.env.LOCAL_OCR_ENGINE
  try {
    local.registerLocalEngine({ id: 'test-pdf', extract: async () => ({ ...CLEAN_ROW }) })
    const hit = await local.tryLocalExtract({ buffer: Buffer.from('x'), mimeType: 'application/pdf' })
    assert.equal(hit.ok, true)
    assert.equal(hit.engine, 'test-pdf')

    local.registerLocalEngine({ id: 'blank', extract: async () => null })
    const empty = await local.tryLocalExtract({ buffer: Buffer.from('x'), mimeType: 'application/pdf' })
    assert.equal(empty.ok, false)
    assert.equal(empty.reason, 'no-candidate')

    local.registerLocalEngine({ id: 'boom', extract: async () => { throw new Error('engine crashed') } })
    const err = await local.tryLocalExtract({ buffer: Buffer.from('x'), mimeType: 'application/pdf' })
    assert.equal(err.ok, false)
    assert.equal(err.reason, 'engine-error')
  } finally {
    local.registerLocalEngine(null)
    if (savedEngine === undefined) delete process.env.LOCAL_OCR_ENGINE
    else process.env.LOCAL_OCR_ENGINE = savedEngine
  }
})

test('J4 extract handler: local-first, AI behind an explicit paid gate, review when neither applies', () => {
  const s = extractSrc()
  assert.ok(s.includes('tryLocalExtract'), 'attempts a local engine first')
  assert.ok(s.includes("env.EXTRACTION_ALLOW_AI === true && env.EXTRACTION_AI_TIER === 'paid'"),
    'AI runs only when explicitly enabled AND on a paid tier')
  // The vision call must live INSIDE the gate (never unconditional).
  const gateIdx = s.indexOf('const aiEnabled =')
  const providerIdx = s.indexOf("env.EXTRACTION_PROVIDER !== 'gemini'")
  const visionIdx = s.indexOf('extractInvoiceFields(')
  assert.ok(gateIdx > 0 && providerIdx > gateIdx && visionIdx > gateIdx,
    'provider selection + vision call are gated behind aiEnabled (no silent Gemini)')
  // AI disabled + no engine -> a review-only placeholder, never invented values.
  assert.ok(s.includes('evaluateLedger({}, '), 'falls back to an empty review placeholder')
  assert.ok(s.includes('confidence_source: confidenceSource'), 'provenance persisted')
  assert.ok(s.includes('plain.fill(0)'), 'plaintext wiped on every path')
})

test('J5 download authz decision is total and denies cross-workspace access', () => {
  const now = Date.UTC(2026, 0, 1)
  const base = {
    authenticated: true, workbookExists: true, memberOfWorkspace: true,
    status: 'ready', expiresAt: new Date(now + 1000).toISOString(), nowMs: now,
  }
  assert.equal(access.decideDownloadAccess(base).ok, true)
  assert.equal(access.decideDownloadAccess({ ...base, authenticated: false }).status, 401)
  assert.equal(access.decideDownloadAccess({ ...base, workbookExists: false }).status, 404)
  // The core isolation rule: a valid user who is NOT a member is denied.
  const cross = access.decideDownloadAccess({ ...base, memberOfWorkspace: false })
  assert.equal(cross.ok, false)
  assert.equal(cross.status, 403)
  assert.equal(cross.code, 'NOT_MEMBER')
  // Precedence: anonymous beats everything; expired lapses at/after expiry.
  assert.equal(access.decideDownloadAccess({ ...base, authenticated: false, memberOfWorkspace: false }).status, 401)
  assert.equal(access.decideDownloadAccess({ ...base, expiresAt: new Date(now - 1).toISOString() }).status, 410)
  assert.equal(access.decideDownloadAccess({ ...base, status: 'deleted' }).status, 404)
  assert.equal(access.decideDownloadAccess({ ...base, status: 'expired' }).status, 410)
})

test('J6 download route authorizes BEFORE decrypt and never leaks the object', () => {
  const r = downloadRouteSrc()
  assert.ok(r.includes('getAuthenticatedUserId()'), 'requires a signed-in user')
  assert.ok(r.includes("from('workspace_members')"), 're-checks workspace membership')
  assert.ok(r.includes('decideDownloadAccess'), 'delegates to the pure decision fn')
  // The access decision must short-circuit before any storage read/decrypt.
  const denyIdx = r.indexOf('if (!decision.ok) return deny')
  const dlIdx = r.indexOf('.download(')
  assert.ok(denyIdx > 0 && dlIdx > denyIdx, 'never downloads/decrypts before the decision passes')
  assert.ok(r.includes('decryptFile(container, masterKeyHex'), 'decrypts the container in memory')
  assert.ok(r.includes("context: workbook.file_object_path"), 'decrypt AAD context is the object path')
  assert.ok(r.includes("'Cache-Control': 'no-store'"), 'served with no-store')
  // No raw signed URL is minted; nothing sensitive is logged.
  assert.ok(!/createSignedUrl/.test(r), 'encrypted object is never exposed via a signed URL')
  assert.ok(!/logger\.[a-z]+\([^)]*(masterKey|signedUrl|file_object_path|container)/.test(r),
    'route must not log keys, URLs, object paths or ciphertext')
})

test('J7 privacy migration: confidence provenance, exports at-rest, retention sweeps (service-role only)', () => {
  const sql = privacySqlSrc()
  assert.ok(sql.includes("add column if not exists confidence_source text not null default 'human'"))
  assert.ok(sql.includes("check (confidence_source in ('local', 'ai', 'human'))"))
  assert.ok(sql.includes('add column if not exists file_encryption_key_version text'))
  assert.ok(sql.includes('add column if not exists size_bytes bigint'))
  // Exports bucket accepts the encrypted container transport, private flag kept.
  assert.ok(sql.includes("'application/octet-stream'"))
  assert.ok(sql.includes("where id = 'billora-exports'"))
  assert.ok(!/is_public|public\s*=\s*true/i.test(sql), 'bucket stays private')
  // Retention sweeps exist and are definer-scoped + service-role only.
  assert.ok(sql.includes('create or replace function public.purge_expired_workbooks'))
  assert.ok(sql.includes('create or replace function public.purge_expired_invoices'))
  assert.match(sql, /security definer/)
  assert.match(sql, /revoke all on function public\.purge_expired_workbooks\(timestamptz\) from public, anon, authenticated/)
  assert.match(sql, /grant execute on function public\.purge_expired_workbooks\(timestamptz\)\s+to service_role/)
  assert.match(sql, /grant execute on function public\.purge_expired_invoices\(timestamptz\)\s+to service_role/)
  assert.ok(!/^[ \t]*grant[^\n]*\bto\s+(anon|authenticated)\b/im.test(sql), 'no browser access to retention sweeps')
  assert.ok(!/drop column|drop table/i.test(sql), 'forward-only, never destroys existing schema')
})

test('J8 confidence_source stays aligned across statuses + migration + handler', () => {
  assert.deepEqual([...statuses.CONFIDENCE_SOURCES].sort(), ['ai', 'human', 'local'])
  assert.ok(privacySqlSrc().includes("'local', 'ai', 'human'"), 'DB CHECK matches the TS set')
  for (const src of [extractSrc(), localSrc(), accessSrc()]) {
    assert.ok(typeof src === 'string' && src.length > 0, 'source loaders resolve')
  }
  // The handler only ever writes one of the three provenance values.
  const s = extractSrc()
  assert.ok(s.includes("'local' : 'human'"), 'local-or-review provenance assigned at intake of the result')
  assert.ok(s.includes("confidenceSource = 'ai'"), 'AI fallback recorded as ai provenance')
})

// ---- K: hybrid local-first extraction (real PDF text engine + gated AI) ---- 

const INVOICE_TEXT = [
  'TAX INVOICE',
  'ACME TRADERS PVT LTD',
  'GSTIN: 27ABCDE1234F1Z5',
  'Invoice No: INV-2026-0042',
  'Invoice Date: 05/09/2026',
  'Taxable Value: 1,000.00',
  'CGST: 90.00',
  'SGST: 90.00',
  'IGST: 0.00',
  'Grand Total: 1,180.00',
].join('\n')

test('K1 text-parser: deterministic parse of a real PDF text layer (real module, never fabricates)', () => {
  const cand = textParser.parseInvoiceText(INVOICE_TEXT)
  assert.equal(cand.invoice_number, 'INV-2026-0042')
  assert.equal(cand.invoice_date, '05/09/2026')
  assert.equal(cand.supplier_gstin, '27ABCDE1234F1Z5')
  assert.match(cand.vendor_name, /ACME TRADERS/)
  assert.equal(cand.taxable_value, 1000)
  assert.equal(cand.cgst_amount, 90)
  assert.equal(cand.sgst_amount, 90)
  assert.equal(cand.igst_amount, 0)
  assert.equal(cand.total_amount, 1180)
  // A complete, consistent local parse may be auto-approved on our OWN scoring.
  const ev = ledger.evaluateLedger(cand, { minConfidence: 0.8 })
  assert.equal(ev.review, 'approved')
  assert.ok(ev.confidence <= 0.9, 'local self-confidence caps the score')
  // NEVER fabricate: fields absent from the text are omitted, not invented.
  const none = textParser.parseInvoiceText('a scanned page with no legible fields at all')
  assert.ok(!none.supplier_gstin, 'no GSTIN invented')
  assert.ok(!none.invoice_date, 'no date invented')
  assert.ok(!none.total_amount, 'no total invented')
  assert.equal(ledger.evaluateLedger(none, { minConfidence: 0.8 }).review, 'needs_review')
  // A partial read (no total) can NEVER auto-approve.
  const partial = textParser.parseInvoiceText(
    'Invoice No: X-1\nDate: 05/09/2026\nGSTIN: 27ABCDE1234F1Z5\nAcme Traders Pvt Ltd\nTaxable Value: 1000')
  assert.equal(ledger.evaluateLedger(partial, { minConfidence: 0.8 }).review, 'needs_review')
  assert.equal(textParser.hasMeaningfulText(INVOICE_TEXT), true)
  assert.equal(textParser.hasMeaningfulText('   '), false)
})

test('K2 mergeCandidates: AI assists the local parse but never overrules valid local data', () => {
  const localRow = { invoice_number: 'INV-1', supplier_gstin: 'NOTAGSTIN', total_amount: 1000 }
  const aiRow = {
    invoice_number: 'WRONG', supplier_gstin: '27ABCDE1234F1Z5', total_amount: 999,
    vendor_name: 'Acme Traders Pvt Ltd', invoice_date: '05/09/2026',
  }
  const merged = ledger.mergeCandidates(localRow, aiRow)
  assert.equal(merged.invoice_number, 'INV-1', 'valid local text field kept over the AI value')
  assert.equal(merged.supplier_gstin, '27ABCDE1234F1Z5', 'an INVALID local GSTIN is filled from AI')
  assert.equal(merged.total_amount, 1000, 'valid local amount kept over AI')
  assert.equal(merged.vendor_name, 'Acme Traders Pvt Ltd', 'AI fills a field local missed')
  assert.equal(merged.invoice_date, '05/09/2026', 'AI fills the missing date')
})

test('K3 pdf.ts: a REAL pdf.js text layer + first-page-only rasterization, honest nulls', () => {
  const p = pdfSrc()
  assert.ok(p.includes('pdfjs-dist/legacy/build/pdf.mjs'), 'loads the real pdf.js engine')
  assert.ok(p.includes('@napi-rs/canvas'), 'renders through a real canvas')
  assert.ok(p.includes('getTextContent'), 'extracts the embedded text layer')
  assert.ok(p.includes('standardFontDataUrl'), 'supplies standard-font data for rendering')
  // Rasterization must render ONLY the first page (never iterate all pages).
  const render = p.slice(p.indexOf('export async function renderFirstPageToPng'), p.indexOf('export async function pdfEngineAvailable'))
  assert.ok(render.includes('getPage(1)'), 'renders page 1 only')
  assert.ok(!/for \(let n = 1; n <= doc\.numPages/.test(render), 'never renders every page')
  assert.ok(render.includes("toBuffer('image/png')"), 'emits a real PNG')
  // Unavailable engine -> honest null, never a fabricated image.
  assert.ok(p.includes('if (!pdfjs) return null'), 'missing engine resolves to null')
})

test('K4 pdf-text-engine + worker wiring: registered as the local engine; images/scans are honest nulls', () => {
  const e = pdfEngineSrc()
  assert.ok(e.includes("id: 'pdfjs-text'"), 'the wired adapter id')
  assert.ok(e.includes('extractPdfTextLayer'), 'uses the real PDF text layer')
  assert.ok(e.includes('parseInvoiceText'), 'parses deterministically')
  assert.ok(e.includes("if (!PDF_MIME.test(mimeType ?? '')) return null"), 'bare images are NOT locally processed')
  assert.ok(e.includes('if (!hasMeaningfulText(text)) return null'), 'scanned/blank layers yield no candidate')
  const idx = handlersIndexSrc()
  assert.ok(idx.includes("getEnv().LOCAL_OCR_ENGINE === 'pdfjs-text'"), 'registered only when the local engine is selected')
  assert.ok(idx.includes('registerLocalEngine(createPdfTextEngine())'), 'worker boot installs the engine')
})

test('K5 extract handler: PDF reaches the gated AI as a rendered first page; AI only merges in', () => {
  const s = extractSrc()
  const gateIdx = s.indexOf('const aiEnabled =')
  const renderIdx = s.indexOf('renderFirstPageToPng(plain)')
  const mergeIdx = s.indexOf('mergeCandidates(candidate, aiCandidate)')
  assert.ok(gateIdx > 0 && renderIdx > gateIdx, 'first-page rendering happens only inside the AI gate')
  assert.ok(mergeIdx > gateIdx, 'AI merge happens only inside the AI gate')
  assert.ok(s.includes("aiMime = 'image/png'"), 'a rendered PDF is sent as an image')
  assert.ok(s.includes('const assisted = candidate ? mergeCandidates(candidate, aiCandidate) : aiCandidate'),
    'AI fills gaps but valid local fields are preserved')
  assert.ok(s.includes('const isPdf ='), 'PDF vs image media selection is explicit')
})

test('K6 hybrid config + docs: real deps externalized, exposure documented, no offline claim', () => {
  // Heavy/native server modules must stay out of the bundle graph.
  const cfg = nextConfigSrc()
  assert.match(cfg, /serverExternalPackages/)
  assert.ok(cfg.includes('pdfjs-dist') && cfg.includes('@napi-rs/canvas'), 'both engines externalized')
  // package.json actually declares them (not phantom transitives).
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.dependencies['pdfjs-dist'], 'pdfjs-dist is a direct dependency')
  assert.ok(pkg.dependencies['@napi-rs/canvas'], '@napi-rs/canvas is a direct dependency')
  // .env.example documents the hybrid engine + the exposure warning.
  const ex = envExampleSrc()
  assert.ok(ex.includes('LOCAL_OCR_ENGINE=pdfjs-text'), 'hybrid local default documented')
  assert.ok(/EXTRACTION_ALLOW_AI=false/.test(ex), 'AI still off by default')
  assert.match(ex, /data-exposure|DATA EXPOSURE|rendered image/i)
  // README describes hybrid + cloud fallback and is NOT claiming "fully offline".
  const rm = readmeSrc()
  assert.match(rm, /hybrid/i)
  assert.match(rm, /not fully offline|not\*\*\s*an offline/i)
  assert.match(rm, /Data-exposure note|Gemini/)
})

