// Phase 1 webhook-claim contract tests. Real race tests require PostgreSQL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importTs } from '../scripts/_ts-import.mjs'

const intake = await importTs('lib/whatsapp/intake.ts')
const intakeSource = readFileSync(new URL('../lib/whatsapp/intake.ts', import.meta.url), 'utf8')
const routeSource = readFileSync(new URL('../app/api/whatsapp/route.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20261112130000_atomic_webhook_claims.sql', import.meta.url), 'utf8')

test('claim RPC returns a UUID token only to the winner', async () => {
  let args
  const db = { rpc: async (name, input) => {
    assert.equal(name, 'claim_whatsapp_webhook_event'); args = input
    return { data: [{ claimed: true, created: true, event_id: 'event-1', provider_message_id: 'wamid.1',
      status: 'processing', attempts: 1, processed_at: null, claim_expires_at: '2026-11-12T12:03:00Z' }], error: null }
  } }
  const result = await intake.claimIntakeRow(db, 'wamid.1')
  assert.equal(args.p_provider_message_id, 'wamid.1')
  assert.match(args.p_claim_token, /^[0-9a-f-]{36}$/i)
  assert.equal(args.p_lease_seconds, 180)
  assert.equal(result.claimed, true)
  assert.equal(result.claimToken, args.p_claim_token)
  assert.equal(result.row.status, 'processing')
})

test('busy claim does not expose the active owner's token', async () => {
  const db = { rpc: async () => ({ data: [{ claimed: false, created: false, event_id: 'e',
    provider_message_id: 'wamid.1', status: 'processing', attempts: 1,
    processed_at: null, claim_expires_at: '2026-11-12T12:03:00Z' }], error: null }) }
  const result = await intake.claimIntakeRow(db, 'wamid.1')
  assert.equal(result.claimed, false)
  assert.equal(result.claimToken, null)
})

test('heartbeat and terminal transitions require the same claim token', async () => {
  const calls = []
  const db = { rpc: async (name, args) => {
    calls.push({ name, args })
    return { data: true, error: null }
  } }
  assert.equal(await intake.renewIntakeClaim(db, 'wamid.2', 'owner-token'), true)
  await intake.markIntakeAccepted(db, 'wamid.2', 'owner-token', 'CONFIG')
  await intake.markIntakeFailed(db, 'wamid.2', 'owner-token', 'TEMPORARY')
  assert.deepEqual(calls.map((c) => c.name), [
    'renew_whatsapp_webhook_event_claim',
    'complete_whatsapp_webhook_event',
    'fail_whatsapp_webhook_event',
  ])
  assert.ok(calls.every((c) => c.args.p_claim_token === 'owner-token'))
  assert.equal(calls[1].args.p_error_code, 'CONFIG')
  assert.equal(calls[2].args.p_error_code, 'TEMPORARY')
})

test('a stale owner cannot report successful completion', async () => {
  const db = { rpc: async () => ({ data: false, error: null }) }
  await assert.rejects(
    () => intake.markIntakeAccepted(db, 'wamid.3', 'stale-token'),
    /INTAKE_CLAIM_LOST/,
  )
  await assert.rejects(
    () => intake.markIntakeFailed(db, 'wamid.3', 'stale-token', 'ERROR'),
    /INTAKE_CLAIM_LOST/,
  )
})

test('heartbeat, completion and failure are fenced and attempts are not read-modify-written', () => {
  assert.match(intakeSource, /renew_whatsapp_webhook_event_claim/)
  assert.match(intakeSource, /complete_whatsapp_webhook_event/)
  assert.match(intakeSource, /fail_whatsapp_webhook_event/)
  assert.doesNotMatch(intakeSource, /const current = await claimIntakeRow/)
  assert.match(routeSource, /if \(!intake\.claimed\)[\s\S]*?return 'retryable'/)
  assert.match(routeSource, /renewIntakeClaim\(db, providerMessageId, claimToken\)/)
  assert.match(routeSource, /clearInterval\(heartbeat\)/)
  assert.match(routeSource, /markIntakeAccepted\(db, providerMessageId, claimToken/)
  assert.match(routeSource, /markIntakeFailed\(db, providerMessageId, claimToken, code\)/)
})

test('SQL claim is atomic, lease-reclaimable, token-fenced and service-role-only', () => {
  assert.match(migration, /on conflict \(provider_message_id\) do update/)
  assert.match(migration, /status in \('received', 'failed'\)/)
  assert.match(migration, /claim_expires_at <= clock_timestamp\(\)/)
  assert.match(migration, /claim_token = p_claim_token/)
  assert.match(migration, /claim_expires_at > clock_timestamp\(\)/)
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/i)
  assert.match(migration, /grant execute on function[\s\S]*to service_role/i)
  assert.match(migration, /check \(status in \('received', 'processing', 'accepted', 'failed'\)\)/)
})
