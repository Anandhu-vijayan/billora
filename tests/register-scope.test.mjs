// Zero-dependency source-contract tests for §register-scope (generation scope,
// not another delivery patch). The requirement: establish the intended register
// scope from (workspace/client + invoice month + accounting category), gather the
// approved canonical invoices for that scope ACROSS batches, validate each included
// invoice's month before generating, and derive the workbook's month + filename from
// that VALIDATED scope — never copied from one batch's period_start at read time.
//
// build-register.ts pulls runtime `@/` + crypto/storage deps and cannot be executed
// in this harness, so these tests pin the exact wiring; the reader + resolver
// behaviour is exercised for real in delivery-scope.test.mjs (D11/D12) and
// onboarding.test.mjs (N1/N7).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const registerSrc = () => src('../lib/jobs/handlers/build-register.ts')
const batchSrc = () => src('../lib/invoices/batch.ts')
const deliverSrc = () => src('../lib/exports/deliver.ts')
const downloadSrc = () => src('../app/api/exports/[id]/download/route.ts')
const finalizeSrc = () => src('../lib/whatsapp/finalize.ts')
const migrationSrc = () => src('../supabase/migrations/20261101000000_register_scope.sql')

test('RS1 the batch is a SCOPE ANCHOR: build-register reads its client + period', () => {
  const s = registerSrc()
  assert.ok(s.includes(".from('invoice_batches').select('id,workspace_id,status,client_id,period_start,period_end')"),
    'the gather needs client_id + the period to build the (client, month) scope')
  assert.ok(s.includes('const scopeMonth = monthToken(batch.period_start)'),
    'the intended month is the batch period rendered as a canonical YYYY-MM (never a raw copy)')
  assert.ok(s.includes('const scopeClientId = batch.client_id ?? null'),
    'the client half of the scope comes from the batch (null = the individual tenant)')
})

test('RS2 approved invoices are gathered for the scope ACROSS batches', () => {
  const s = registerSrc()
  assert.ok(s.includes(".eq('invoice_month', scopeMonth)"),
    'the cross-batch gather selects every invoice filed under the scope month')
  assert.ok(s.includes("? scopeBase.is('client_id', null)") && s.includes(": scopeBase.eq('client_id', scopeClientId)"),
    'the gather is client-scoped: orgs never mix clients, individuals key on a null client')
  assert.ok(s.includes('const invoiceIds = [...scopeIdSet]'),
    'the batch membership and the cross-batch scope set are UNIONED (a stray never lost)')
  // Tenant isolation is preserved: the additive scope read still filters workspace.
  const gather = s.slice(s.indexOf('const scopeBase'), s.indexOf('const invoiceIds = [...scopeIdSet]'))
  assert.ok(gather.includes(".eq('workspace_id', workspaceId)"), 'the scope read stays inside the workspace')
})

test('RS3 every included invoice is month-VALIDATED before the workbook is built', () => {
  const s = registerSrc()
  assert.ok(s.includes('const rowMonth = monthToken(typeof row.invoice_date === \'string\' ? row.invoice_date : null)'),
    'the authority is the invoice\'s OWN decrypted date, not the (possibly stale) column')
  assert.ok(s.includes('if (scopeMonth && rowMonth !== scopeMonth)') && s.includes('excludedWrongMonth += 1'),
    'an out-of-month approved row is counted as excluded')
  const guard = s.slice(s.indexOf('if (scopeMonth && rowMonth !== scopeMonth)'), s.indexOf('rows.push(row)'))
  assert.ok(guard.includes('continue'), 'the out-of-month row is dropped before it can render')
  // Never over-validate into data loss: an unresolvable scope month keeps every row.
  assert.ok(s.includes('if (scopeMonth &&'), 'validation only gates when a real month anchor exists')
})

test('RS4 the workbook carries its OWN validated period at publish', () => {
  const s = registerSrc()
  assert.ok(s.includes('period_start: scopeMonth ? (batch.period_start ? String(batch.period_start).slice(0, 10) : null) : null'),
    'the stamped start is the validated scope month, and NULL when unresolvable (legacy fallback intact)')
  assert.ok(s.includes('period_end: scopeMonth ? (batch.period_end ? String(batch.period_end).slice(0, 10) : null) : null'),
    'the stamped end rides the same validation gate')
  assert.ok(s.includes('accounting_category: p.category'), 'category (the third scope dimension) is still recorded per file')
})

test('RS5 resolveInvoiceBatch stamps invoice_month in lock-step with the batch link', () => {
  const s = batchSrc()
  const stamps = (s.match(/update\(\{ batch_id: batchId, invoice_month: iso\.slice\(0, 7\) \}\)/g) || []).length
  assert.equal(stamps, 2, 'BOTH link sites (new batch + cross-month move) set the canonical month')
  assert.ok(!/from\('invoices'\)\.update\(\{ batch_id: batchId \}\)/.test(s), 'no INVOICE link is written WITHOUT the scope month (the processing_jobs link legitimately stays month-less)')
})

test('RS6 all three readers prefer the workbook period, falling back to the batch', () => {
  for (const [name, s, expr] of [
    ['deliver.ts', deliverSrc(), 'wb.period_start ?? null'],
    ['download route', downloadSrc(), 'workbook.period_start ?? null'],
    ['finalize.ts', finalizeSrc(), 'r.period_start ?? (r.batch_id ? periodByBatch.get(r.batch_id) ?? null : null)'],
  ]) {
    assert.ok(s.includes(expr), `${name}: filename/label read from the workbook's own validated period`)
    assert.ok(s.includes(".from('invoice_batches').select('period_start'") || name === 'finalize.ts',
      `${name}: batch read retained ONLY as the legacy fallback`)
  }
})

test('RS7 the register-scope migration is additive, forward-only, service-role safe', () => {
  const sql = migrationSrc()
  const executable = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  assert.match(executable, /add column if not exists invoice_month text/, 'invoice_month is additive + re-runnable')
  assert.match(executable, /add column if not exists period_start date/, 'workbook period_start is additive')
  assert.match(executable, /add column if not exists period_end date/, 'workbook period_end is additive')
  assert.match(executable, /create index invoices_scope_month_idx/, 'the cross-batch gather is indexed')
  assert.match(executable, /set invoice_month = to_char\(b\.period_start, 'YYYY-MM'\)/, 'existing rows are backfilled from their batch')
  assert.ok(!/drop\s+(column|table|index)/i.test(executable), 'never destructive')
  assert.ok(!/\bgrant\b/i.test(executable), 'grants nothing new — no widened RLS surface')
})


test('RS8 a late invoice cannot be lost while its batch register is processing', () => {
  const batch = batchSrc()
  const finalize = finalizeSrc()
  const queueMigration = src('../supabase/migrations/20261111100000_register_job_followup.sql')
  const executable = queueMigration.split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')

  // Producers coalesce only queued work. A processing register must allow one
  // queued follow-up rather than swallowing the late invoice's rebuild request.
  assert.ok(batch.includes(".eq('job_type', 'register_generation').eq('status', 'queued')"))
  assert.ok(!batch.includes(".in('status', ['queued', 'processing'])"))
  assert.ok(finalize.includes(".eq('job_type', 'register_generation').eq('status', 'queued')"))
  assert.ok(!finalize.includes(".in('status', ['queued', 'processing'])"))

  // The DB allows one queued follow-up while retaining a processing job, and
  // the claim RPC will not start that follow-up until the processing job settles.
  assert.match(executable, /drop index if exists public\.processing_jobs_batch_uniq/i)
  assert.match(executable, /where batch_id is not null and invoice_id is null and job_type = 'register_generation' and status = 'queued'/i)
  assert.match(executable, /j\.job_type <> 'register_generation'.*not exists.*active\.status = 'processing'/i)
  assert.match(executable, /for update skip locked/i)
})
