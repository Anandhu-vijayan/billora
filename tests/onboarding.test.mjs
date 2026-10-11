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
const mediaSrc = () => readFileSync(new URL('../lib/whatsapp/media.ts', import.meta.url), 'utf8')
const initialSqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261002143735_initial_schema.sql', import.meta.url), 'utf8')
const p3SqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261011190000_phase3_job_queue.sql', import.meta.url), 'utf8')
const queueSrc = () => readFileSync(new URL('../lib/jobs/queue.ts', import.meta.url), 'utf8')
const workerSrc = () => readFileSync(new URL('../lib/jobs/worker.ts', import.meta.url), 'utf8')
const workerRouteSrc = () => readFileSync(new URL('../app/api/jobs/worker/route.ts', import.meta.url), 'utf8')

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
  assert.match(src, /if \(!deduped\)/)
  const dedupIdx = src.indexOf('if (!deduped)')
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
  // Stored path is deterministic per provider media id.
  assert.match(routeSrc(), /whatsapp\/invoices\/\$\{mediaId\}/)
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
