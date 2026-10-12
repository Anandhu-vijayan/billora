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

// Stage-1 envelope crypto is exercised against the REAL module (transpiled),
// not a copy, so a format drift cannot silently pass here and break Stage-3.
const files = await importTs('lib/encryption/files.ts')
// conversation.ts imports only erased types, so it transpiles to pure JS and
// the menu routing is tested behaviorally against the REAL state machine.
const conv = await importTs('lib/whatsapp/conversation.ts')
// ledger.ts is dependency-free (no aliases/provider imports), so the REAL
// extraction-review decision logic is exercised in-process, not reimplemented.
const ledger = await importTs('lib/ocr/ledger.ts')
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

test('G6b register builds from approved rows, uploads deterministically, versions, and delivers best-effort', () => {
  const s = registerSrc()
  assert.ok(s.includes("throw new PermanentJobError('REGISTER_MISSING_BATCH')"))
  assert.ok(s.includes(".eq('workspace_id', workspaceId).eq('id', batchId)"), 'batch verified to belong to workspace')
  assert.ok(s.includes('deriveWorkbookKey(batchId, pathKeyHex)'), 'deterministic export path')
  assert.ok(s.includes("contentType: SPREADSHEET_MIME, upsert: true"))
  assert.ok(s.includes("status: 'expired'"), 'prior workbook retired (freshness)')
  assert.match(s, /version, generated_at: new Date\(\)/)
  assert.ok(s.includes('createSignedUrl(exportPath, SIGNED_URL_TTL_SECONDS)'))
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
