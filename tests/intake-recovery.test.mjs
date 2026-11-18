import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const inboxSql = read('../supabase/migrations/20261112140000_durable_webhook_replay.sql')
const intakeSql = read('../supabase/migrations/20261112150000_atomic_quota_and_intake_reconciliation.sql')
const inbox = read('../lib/whatsapp/webhook-inbox.ts')
const media = read('../lib/whatsapp/media.ts')
const route = read('../app/api/whatsapp/route.ts')
const worker = read('../lib/jobs/worker.ts')
const consentRoute = read('../app/api/workspaces/[id]/ai-consent/route.ts')
const extraction = read('../lib/jobs/handlers/extract-invoice.ts')
const consentSql = read('../supabase/migrations/20261112160000_workspace_ai_consent.sql')

test('webhook inbox stores encrypted normalized data with bounded expiry and deletes on fenced acceptance', () => {
  assert.match(inboxSql, /encrypted_payload bytea not null/)
  assert.match(inboxSql, /interval '72 hours'/)
  assert.match(inboxSql, /claim_expires_at <= clock_timestamp\(\)/)
  assert.match(inboxSql, /delete from public\.whatsapp_webhook_payloads[\s\S]*if v_completed then/)
  assert.match(inbox, /encryptFile\(/)
  assert.match(inbox, /decryptFile\(/)
  assert.match(inbox, /createHmac\('sha256', appSecret\)/)
  assert.match(route, /storeReplayableWebhookMessage\(db, message\.id/)
  assert.match(worker, /replayPendingWebhookMessages\(db, 1\)/)
})

test('quota reservations serialize per workspace/day and storage cleanup is leased and reference-aware', () => {
  assert.match(intakeSql, /primary key \(scope_key, quota_date\)/)
  assert.match(intakeSql, /primary key \(provider_message_id, scope_key, quota_date\)/)
  assert.match(intakeSql, /pg_advisory_xact_lock/)
  assert.match(intakeSql, /reserved_count = c\.reserved_count \+ 1/)
  assert.match(intakeSql, /not exists \(select 1 from public\.invoices i where i\.file_object_path = s\.object_path\)/)
  assert.match(intakeSql, /not exists \(select 1 from public\.pending_uploads p where p\.object_path = s\.object_path\)/)
  assert.match(intakeSql, /p\.expires_at > clock_timestamp\(\)/)
  assert.match(intakeSql, /for update of s skip locked/)
  assert.match(intakeSql, /cleanup_claim_token = p_claim_token/)
  assert.match(worker, /reconcileOrphanedIntakeObjects\(db, 10\)/)
})

test('media download rejects declared and streamed oversize bodies before full buffering', () => {
  assert.match(media, /Number\(response\.headers\.get\('content-length'\)\)/)
  assert.match(media, /response\.body\.getReader\(\)/)
  assert.match(media, /total \+= value\.byteLength/)
  assert.match(media, /total > maxBytes/)
  assert.match(media, /reader\.cancel\(/)
  assert.match(media, /AbortController/)
})

test('Gemini requires current explicit workspace consent and owner/admin authorization', () => {
  assert.match(consentSql, /gemini_consent_at timestamptz/)
  assert.match(consentSql, /gemini_consent_version text/)
  assert.match(consentRoute, /getAuthenticatedUserId\(\)/)
  assert.match(consentRoute, /member\.role !== 'owner' && member\.role !== 'admin'/)
  assert.match(consentRoute, /CONSENT_CONFIRMATION_REQUIRED/)
  assert.match(consentRoute, /GEMINI_WORKSPACE_CONSENT_NOTICE/)
  assert.match(consentRoute, /gemini_consent_at: null/)
  assert.match(extraction, /AI_CONSENT_READ_ERROR/)
  assert.match(extraction, /consent\?\.gemini_consent_at != null/)
  assert.match(extraction, /GEMINI_WORKSPACE_CONSENT_VERSION/)
})

const testUrl = process.env.BILLORA_TEST_SUPABASE_URL
const serviceRoleKey = process.env.BILLORA_TEST_SUPABASE_SERVICE_ROLE_KEY
const integrationConfigured = Boolean(testUrl && serviceRoleKey)

test('PostgreSQL serializes concurrent claims, reclaims expired leases, and fences stale owners', {
  skip: !integrationConfigured && 'set BILLORA_TEST_SUPABASE_URL and BILLORA_TEST_SUPABASE_SERVICE_ROLE_KEY to run against an isolated test project',
  timeout: 120_000,
}, async () => {
  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(testUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const providerMessageId = `billora-test-claim:${randomUUID()}`
  const ids = [providerMessageId]
  try {
    const calls = await Promise.all(Array.from({ length: 24 }, () => db.rpc('claim_whatsapp_webhook_event', {
      p_provider_message_id: providerMessageId,
      p_claim_token: randomUUID(),
      p_lease_seconds: 30,
    })))
    for (const result of calls) assert.equal(result.error, null, result.error?.message)
    assert.equal(calls.filter((result) => result.data?.[0]?.claimed === true).length, 1)

    const { data: current, error: readError } = await db.from('webhook_events')
      .select('claim_token').eq('provider_message_id', providerMessageId).single()
    assert.equal(readError, null, readError?.message)
    const staleToken = current.claim_token
    const { error: expireError } = await db.from('webhook_events')
      .update({ claim_expires_at: new Date(0).toISOString() })
      .eq('provider_message_id', providerMessageId)
    assert.equal(expireError, null, expireError?.message)

    const replacementToken = randomUUID()
    const reclaimed = await db.rpc('claim_whatsapp_webhook_event', {
      p_provider_message_id: providerMessageId,
      p_claim_token: replacementToken,
      p_lease_seconds: 30,
    })
    assert.equal(reclaimed.error, null, reclaimed.error?.message)
    assert.equal(reclaimed.data?.[0]?.claimed, true)

    const staleCompletion = await db.rpc('complete_whatsapp_webhook_event', {
      p_provider_message_id: providerMessageId,
      p_claim_token: staleToken,
      p_error_code: null,
    })
    assert.equal(staleCompletion.error, null, staleCompletion.error?.message)
    assert.equal(staleCompletion.data, false)
  } finally {
    await db.from('whatsapp_webhook_payloads').delete().in('provider_message_id', ids)
    await db.from('webhook_events').delete().in('provider_message_id', ids)
  }
})

test('PostgreSQL admits exactly the configured number of concurrent workspace reservations', {
  skip: !integrationConfigured && 'set BILLORA_TEST_SUPABASE_URL and BILLORA_TEST_SUPABASE_SERVICE_ROLE_KEY to run against an isolated test project',
  timeout: 120_000,
}, async () => {
  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(testUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const scopeKey = `workspace:test:${randomUUID()}`
  const providerMessageIds = Array.from({ length: 24 }, () => `billora-test-quota:${randomUUID()}`)
  try {
    const results = await Promise.all(providerMessageIds.map((providerMessageId) =>
      db.rpc('reserve_whatsapp_daily_intake', {
        p_provider_message_id: providerMessageId,
        p_scope_key: scopeKey,
        p_limit: 5,
      })))
    for (const result of results) assert.equal(result.error, null, result.error?.message)
    assert.equal(results.filter((result) => result.data === true).length, 5)

    const winnerId = providerMessageIds[results.findIndex((result) => result.data === true)]
    const retry = await db.rpc('reserve_whatsapp_daily_intake', {
      p_provider_message_id: winnerId,
      p_scope_key: scopeKey,
      p_limit: 5,
    })
    assert.equal(retry.error, null, retry.error?.message)
    assert.equal(retry.data, true, 'redelivery reuses its reservation without consuming another slot')
  } finally {
    await db.from('whatsapp_intake_quota_reservations').delete().eq('scope_key', scopeKey)
    await db.from('whatsapp_daily_intake_counters').delete().eq('scope_key', scopeKey)
  }
})
