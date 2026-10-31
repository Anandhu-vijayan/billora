// tests/workbook-deliveries.test.mjs — the durable delivery outbox contract.
//
// Two layers:
//   1. STATIC CONTRACT (always runs): the migration SQL and the runtime modules
//      must keep the invariants that make delivery durable, atomic, tenant-scoped
//      and PII-safe. These pin the FIX for the lost-register race without a DB.
//   2. LIVE-DB INTEGRATION (opt-in): exercises the real claim/settle/recover RPCs
//      against a pushed Supabase instance. Skipped unless DELIVERY_LIVE_DB=1 so
//      the standard gate stays green with no database, mirroring the Gemini live
//      test's gating. Run with the migrations applied (npx supabase db push).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = () => readFileSync(new URL('../supabase/migrations/20261030000000_workbook_deliveries.sql', import.meta.url), 'utf8')
const catSql = () => readFileSync(new URL('../supabase/migrations/20261030000100_workbook_category.sql', import.meta.url), 'utf8')
const outboxSrc = () => readFileSync(new URL('../lib/whatsapp/delivery-outbox.ts', import.meta.url), 'utf8')
const consumerSrc = () => readFileSync(new URL('../lib/jobs/handlers/deliver-register.ts', import.meta.url), 'utf8')
const routeSrc = () => readFileSync(new URL('../app/api/whatsapp/route.ts', import.meta.url), 'utf8')
const workerSrc = () => readFileSync(new URL('../lib/jobs/worker.ts', import.meta.url), 'utf8')

// Executable SQL only (drop `--` comment lines) so prose never satisfies a check.
const execSql = (s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

// ==========================================================================
// 1) Migration contract: the outbox table + state machine + grants.
// ==========================================================================
test('DELIVERY-01 the outbox is one durable row per (workbook, recipient) with the full state machine', () => {
  const s = execSql(sql())
  assert.match(s, /create table if not exists public\.workbook_deliveries/, 'forward-only table')
  assert.match(s, /status\s+text not null default 'pending'\s+check \(status in \('pending', 'sending', 'sent', 'failed', 'unknown'\)\)/, 'exactly the pending->sending->sent|failed|unknown machine')
  assert.match(s, /unique \(workspace_id, workbook_id, recipient_sender_hmac\)/, 'one logical delivery per workbook+recipient (idempotent upsert)')
  assert.match(s, /claim_token\s+text/, 'a claim fence column exists')
  assert.match(s, /claim_expires_at\s+timestamptz/, 'a lease expiry column exists')
  assert.match(s, /provider_message_id\s+text/, 'the Meta message id is recorded for audit')
  assert.match(s, /attempt_count\s+integer not null default 0/, 'retry accounting is on the row')
})

test('DELIVERY-02 recipient is stored ONLY as an HMAC and a delivery cannot cross tenants', () => {
  const s = execSql(sql())
  assert.match(s, /recipient_sender_hmac\s+text not null/, 'the owner is the sender HMAC')
  // Scope the no-phone check to the COLUMN DEFINITIONS (the create-table block),
  // not the whole file — the migration's prose comments legitimately say "phone".
  const ct = s.slice(s.indexOf('create table if not exists public.workbook_deliveries'),
    s.indexOf('alter table public.workbook_deliveries enable row level security'))
  assert.ok(!/\b(phone|wa_id|msisdn)\b/i.test(ct), 'no raw phone column is ever introduced')
  // Composite FK pins the workbook to the SAME workspace, so a forged/guessed
  // workbook id from another tenant can never be attached to a delivery row.
  assert.match(s, /foreign key \(workbook_id, workspace_id\)\s+references public\.generated_workbooks\(id, workspace_id\) on delete cascade/, 'cross-tenant workbook id is impossible by FK')
})

test('DELIVERY-03 the claim RPC is atomic (SKIP LOCKED), fences with a token, and bumps attempts', () => {
  const s = execSql(sql())
  const fn = s.slice(s.indexOf('function public.claim_workbook_deliveries'))
  assert.match(fn, /for update skip locked/, 'a concurrent worker never grabs the same row (no double-send)')
  assert.match(fn, /claim_token\s+= gen_random_uuid\(\)::text/, 'each claim stamps a fresh ownership token')
  assert.match(fn, /attempt_count\s+= d\.attempt_count \+ 1/, 'a claim records the attempt')
  assert.match(fn, /status\s+in \('pending', 'failed'\)/, 'only due pending/failed rows are claimable (a sent row is never re-sent)')
  assert.match(fn, /next_attempt_at <= now\(\)/, 'backoff is honoured at claim time')
})

test('DELIVERY-04 settle/release/resolve are fenced by BOTH claim_token and sending status', () => {
  const s = execSql(sql())
  for (const name of ['mark_workbook_delivery_sent', 'release_workbook_delivery', 'resolve_workbook_delivery']) {
    const fn = s.slice(s.indexOf(`function public.${name}`))
    assert.match(fn, /claim_token = p_claim_token/, `${name}: only the current claimer may settle`)
    assert.match(fn, /status = 'sending'/, `${name}: a stale/expired worker no-ops on a row it no longer owns`)
    assert.match(fn, /return found/, `${name}: reports whether the fence held`)
  }
  // resolve only accepts a terminal state and NEVER re-arms to pending.
  const ri = s.indexOf('function public.resolve_workbook_delivery')
  const resolve = s.slice(ri, s.indexOf('$$;', s.indexOf('as $$', ri)))
  assert.match(resolve, /p_final_state not in \('unknown', 'sent', 'failed'\)/, 'resolve refuses a non-terminal target')
  assert.ok(!/'pending'/.test(resolve), 'an uncertain send is never blindly re-queued to pending')
})

test('DELIVERY-05 an expired lease parks as unknown (never auto-resent) and backfill only re-offers still-ready files', () => {
  const s = execSql(sql())
  const recover = s.slice(s.indexOf('function public.recover_expired_delivery_leases'), s.indexOf('function public.backfill_missing_deliveries'))
  assert.match(recover, /set status\s+= 'unknown'/, 'a lapsed sending row becomes unknown, not pending')
  assert.match(recover, /where status = 'sending'\s+and claim_expires_at <= now\(\)/, 'only lapsed leases are swept')
  assert.ok(!/set status\s+=\s+'pending'/.test(recover), 'recovery NEVER blindly re-sends (Meta may have already accepted)')

  const backfill = s.slice(s.indexOf('function public.backfill_missing_deliveries'))
  assert.match(backfill, /and w\.status = 'ready'/, 'legacy backfill only targets still-ready workbooks')
  assert.match(backfill, /not exists/, 'a workbook that already has a delivery row is never forked (a sent file is never re-sent)')
})

test('DELIVERY-06 the outbox is service-role only — RLS on, no anon/auth grant, no widening policy', () => {
  const s = execSql(sql())
  assert.match(s, /alter table public\.workbook_deliveries enable row level security/, 'RLS is on')
  assert.ok(!/create policy[\s\S]*workbook_deliveries/.test(s), 'no policy grants any non-service read/write')
  // Collapse runs of whitespace so the column-aligned grant/revoke lines match.
  const flat = s.replace(/\s+/g, ' ')
  const fns = [
    'claim_workbook_deliveries(text, integer, integer)',
    'mark_workbook_delivery_sent(uuid, text, text)',
    'release_workbook_delivery(uuid, text, integer, text)',
    'resolve_workbook_delivery(uuid, text, text)',
    'recover_expired_delivery_leases()',
    'backfill_missing_deliveries(uuid, text)',
  ]
  for (const f of fns) {
    assert.ok(flat.includes(`revoke all on function public.${f} from public, anon, authenticated`), `${f}: revoked from public/anon/authenticated`)
    assert.ok(flat.includes(`grant execute on function public.${f} to service_role`), `${f}: granted to service_role only`)
  }
  assert.ok(!/grant[^\n]*\bto\s+(anon|authenticated)\b/i.test(s), 'never granted to anon/authenticated')
})

test('DELIVERY-07 the accounting_category column is additive, nullable, and purchase-reading', () => {
  const s = execSql(catSql())
  assert.match(s, /add column if not exists accounting_category text/, 'additive + re-runnable, never destructive')
  assert.ok(!/not null/i.test(s.split('\n').filter((l) => /add column/.test(l)).join('\n')), 'nullable: legacy rows keep NULL (read as the historical purchase register)')
  assert.match(s, /create index generated_workbooks_batch_category_idx/, 'a partial index makes per-scope lookups cheap')
})

// ==========================================================================
// 2) Runtime contract: enqueue is idempotent + never reopens a sent row.
// ==========================================================================
test('DELIVERY-08 enqueue is an idempotent upsert that can never fork or reopen a delivery', () => {
  const s = outboxSrc()
  assert.match(s, /status: 'pending'/, 'a fresh enqueue is always pending (never writes sent/failed directly)')
  assert.match(s, /onConflict: 'workspace_id,workbook_id,recipient_sender_hmac'/, 'the unique triple makes a rebuild a no-op')
  assert.match(s, /ignoreDuplicates: true/, 'an existing (e.g. already-sent) row is NEVER overwritten back to pending')
  assert.match(s, /return !error/, 'a rejected write (migration not applied) surfaces as a deferral, not a throw')
  // fail-soft recovery: absent the migration these degrade to 0, never throwing.
  const recover = s.slice(s.indexOf('export async function recoverExpiredDeliveryLeases'))
  assert.match(recover, /if \(error\) return 0/, 'lease recovery is fail-soft when the table is absent')
  assert.match(recover, /if \(error\) return 0[\s\S]*backfill_missing_deliveries|return 0[\s\S]*/, 'recovery never throws')
})

test('DELIVERY-09 the consumer claims, delivers tenant-scoped, and settles per outcome — never leaking the fence', () => {
  const s = consumerSrc()
  assert.match(s, /claimDueDeliveries\(db, senderHmac/, 'claims due rows for the inbound owner only')
  assert.match(s, /expectedWorkspaceId: d\.workspace_id/, 'delivery is tenant-fenced (a claim can never resolve another workspace file)')
  assert.match(s, /r\.delivered[\s\S]*markDeliverySent\(db, d\.id, d\.claim_token/, 'a confirmed send settles sent under the fence')
  assert.match(s, /outcome === 'transient'[\s\S]*releaseDelivery\(/, 'a transient failure releases for retry')
  assert.match(s, /outcome === 'blocked'[\s\S]*releaseDelivery\(/, 'a credential block releases with a long backoff')
  assert.match(s, /resolveDelivery\(db, d\.id, d\.claim_token, 'unknown'\)/, 'a not-servable row parks as unknown (never resent)')
  assert.match(s, /backfillMissingDeliveries\(db, workspaceId, senderHmac\)/, 'legacy still-ready files are swept in opportunistically')
  assert.match(s, /return 0/, 'the whole flush never throws into the inbound reply path')
  // The claim fence is a secret: it must never be logged. Bound each capture to
  // the logger call's own argument list so a nearby d.claim_token cannot leak in.
  const loggedArgs = [...s.matchAll(/logger\.\w+\(([^)]*)\)/g)].map((m) => m[1])
  assert.ok(loggedArgs.length > 0, 'the consumer logs safe transitions (sanity: >=1 bounded log call)')
  for (const arg of loggedArgs) {
    assert.ok(!/claim_token/.test(arg), 'the claim token is never logged')
    assert.ok(!/\bsealed\b|decrypted/i.test(arg), 'no sealed/decrypted material is logged')
  }
})

test('DELIVERY-10 the outbox is driven from the inbound webhook and reclaimed by the worker tick', () => {
  const route = routeSrc()
  assert.match(route, /import \{ flushPendingDeliveries \} from '@\/lib\/jobs\/handlers\/deliver-register'/, 'route wires the consumer')
  assert.match(route, /flushPendingDeliveries\(db, senderHmac\(message\.from\), message\.from\)/, 'the owner is resolved from the live inbound sender')

  const worker = workerSrc()
  assert.match(worker, /import \{ recoverExpiredDeliveryLeases \} from '@\/lib\/whatsapp\/delivery-outbox'/, 'worker wires lease recovery')
  assert.match(worker, /await recoverExpiredDeliveryLeases\(db\)/, 'each tick reclaims lapsed sending leases to unknown')
})

// ==========================================================================
// 3) LIVE-DB integration (opt-in): DELIVERY_LIVE_DB=1 + migrations pushed.
// ==========================================================================
function readDotEnv() {
  try {
    return new Map(readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^(['"])(.*)\1$/, '$2')]))
  } catch {
    return new Map()
  }
}
const liveEnabled = process.env.DELIVERY_LIVE_DB === '1'
const localEnv = liveEnabled ? readDotEnv() : new Map()
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || localEnv.get('NEXT_PUBLIC_SUPABASE_URL')
const serviceKey = process.env.SUPABASE_SECRET_KEY || localEnv.get('SUPABASE_SECRET_KEY')
const liveAvailable = liveEnabled && !!supabaseUrl && !!serviceKey

async function adminClient() {
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

// A unique synthetic recipient HMAC; a still-'ready' workbook is fabricated in an
// existing workspace (FK requires a matching generated_workbooks row), and the
// cascade FK cleans every delivery up when the workbook row is deleted.
test('DELIVERY-LIVE claim -> settle -> fenced-replay -> lease-recovery behave correctly against Postgres', {
  skip: !liveAvailable, timeout: 60_000,
}, async () => {
  const db = await adminClient()
  const { data: ws } = await db.from('workspaces').select('id').limit(1)
  const workspaceId = ws?.[0]?.id
  assert.ok(workspaceId, 'live DB must contain at least one workspace to scope a fixture')

  // Probe the table; an un-pushed migration is a clean skip, not a failure.
  const probe = await db.from('workbook_deliveries').select('id').limit(1)
  assert.ok(!probe.error, `workbook_deliveries must exist (run npx supabase db push): ${probe.error?.message}`)

  const { data: wb, error: wbErr } = await db.from('generated_workbooks').insert({
    workspace_id: workspaceId, file_object_path: `__test__/delivery-${crypto.randomUUID()}.xlsx`, status: 'ready',
  }).select('id').single()
  assert.ok(!wbErr && wb, `fixture workbook insert failed: ${wbErr?.message}`)
  const workbookId = wb.id
  const recipient = `test-hmac:${crypto.randomUUID()}`
  try {
    const { enqueueWorkbookDelivery, claimDueDeliveries, markDeliverySent, recoverExpiredDeliveryLeases } =
      await (await import('../scripts/_ts-import.mjs')).importTs('lib/whatsapp/delivery-outbox.ts')

    assert.equal(await enqueueWorkbookDelivery(db, { workspaceId, workbookId, recipientSenderHmac: recipient }), true, 'enqueue records a pending row')
    // Idempotent: a second enqueue never forks a row nor reopens anything.
    await enqueueWorkbookDelivery(db, { workspaceId, workbookId, recipientSenderHmac: recipient })

    const claimed = await claimDueDeliveries(db, recipient, 5, 120)
    assert.equal(claimed.length, 1, 'exactly one due delivery is claimed')
    assert.equal(claimed[0].workbook_id, workbookId)
    assert.ok(claimed[0].claim_token, 'the claim returns a live fence token')
    assert.equal(claimed[0].status, 'sending', 'the row is now sending')

    // A second claim while it is checked out yields nothing (SKIP LOCKED + not due).
    const second = await claimDueDeliveries(db, recipient, 5, 120)
    assert.equal(second.length, 0, 'a checked-out row is never double-claimed')

    // Fenced settle: the wrong token no-ops, the right one wins.
    assert.equal(await markDeliverySent(db, claimed[0].id, 'not-the-token', null), false, 'a stale worker cannot settle a row it no longer owns')
    assert.equal(await markDeliverySent(db, claimed[0].id, claimed[0].claim_token, 'wa-provider-id'), true, 'the true claimer settles it sent')

    // Sent is terminal: nothing is claimable again (never blindly re-sent).
    assert.equal((await claimDueDeliveries(db, recipient, 5, 120)).length, 0, 'a sent delivery is never re-claimed')

    // Lease recovery: a fresh claim abandoned (no settle) with a lapsed lease -> unknown.
    await enqueueWorkbookDelivery(db, { workspaceId, workbookId, recipientSenderHmac: `${recipient}-lease` })
    const leased = await claimDueDeliveries(db, `${recipient}-lease`, 5, 1) // 1s lease
    assert.equal(leased.length, 1, 'a second row is claimable for the recovery probe')
    await new Promise((r) => setTimeout(r, 1500))
    const recovered = await recoverExpiredDeliveryLeases(db)
    assert.ok(recovered >= 1, 'the lapsed sending lease is swept')
    assert.equal((await claimDueDeliveries(db, `${recipient}-lease`, 5, 120)).length, 0, 'a recovered row becomes unknown, NEVER resent to pending')
  } finally {
    // Cascade removes the workbook's delivery rows; drop the fixture workbook.
    await db.from('generated_workbooks').delete().eq('id', workbookId)
  }
})
