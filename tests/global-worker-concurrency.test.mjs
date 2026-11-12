// Source-contract coverage for the database-enforced global worker admission policy.
// A real multi-connection PostgreSQL test is still required in staging.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const queue = () => read('../lib/jobs/queue.ts')
const env = () => read('../lib/env.ts')
const example = () => read('../.env.example')
const migration = () => read('../supabase/migrations/20261112120000_global_worker_concurrency.sql')

test('global and workspace concurrency are passed to the atomic claim RPC', () => {
  const src = queue()
  assert.match(src, /JOB_GLOBAL_CONCURRENCY = boundedConcurrency\(process\.env\.JOB_GLOBAL_CONCURRENCY, 5\)/)
  assert.match(src, /JOB_WORKSPACE_CONCURRENCY = boundedConcurrency\(process\.env\.JOB_WORKSPACE_CONCURRENCY, 2\)/)
  assert.match(src, /p_global_limit: JOB_GLOBAL_CONCURRENCY/)
  assert.match(src, /p_workspace_limit: JOB_WORKSPACE_CONCURRENCY/)
})

test('concurrency configuration is validated and documented with conservative defaults', () => {
  assert.match(env(), /JOB_GLOBAL_CONCURRENCY: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(25\)\.default\(5\)/)
  assert.match(env(), /JOB_WORKSPACE_CONCURRENCY: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(25\)\.default\(2\)/)
  assert.match(example(), /^JOB_GLOBAL_CONCURRENCY=5$/m)
  assert.match(example(), /^JOB_WORKSPACE_CONCURRENCY=2$/m)
})

test('Postgres serializes claim admission and counts all currently processing jobs', () => {
  const sql = migration()
  assert.match(sql, /pg_advisory_xact_lock\(74192, 1\)/)
  assert.match(sql, /where status = 'processing'/)
  assert.match(sql, /active_per_workspace as \([\s\S]*?group by workspace_id/)
  assert.match(sql, /row_number\(\) over \([\s\S]*?partition by j\.workspace_id/)
  assert.match(sql, /limit least\(greatest\(coalesce\(p_limit, 1\), 1\), 25, v_global_slots\)/)
  assert.match(sql, /for update of j skip locked/)
})

test('old four-argument worker deployments delegate to the same database limits', () => {
  const sql = migration()
  const legacySignature = sql.indexOf('p_job_types text[] default null')
  const legacyDelegate = sql.indexOf('p_worker, p_lease_seconds, p_limit, p_job_types, 5, 2')
  assert.ok(legacySignature > 0 && legacyDelegate > legacySignature, 'legacy signature delegates to default database caps')
  assert.match(sql, /revoke all on function public\.claim_processing_jobs\(text, integer, integer, text\[\]\)/)
  assert.match(sql, /grant execute on function public\.claim_processing_jobs\(text, integer, integer, text\[\]\)[\s\S]*?to service_role/)
})
