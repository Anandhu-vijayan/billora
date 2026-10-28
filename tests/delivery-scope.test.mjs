// Zero-dependency delivery-scope tests (§wrong-month fix, Parts 3 + 7).
// The production bug: an October "Done" could attach/links a September register
// because collectFinalizeState swept every 'ready' workbook workspace-wide and
// the route picked readyWorkbookIds[0]. These tests run the REAL finalize.ts
// against a filtering fake query builder and pin the new guarantees:
//   * client scope narrows batches -> workbooks (org + individual tenants);
//   * no scope keeps the legacy workspace-wide read (backward compatibility);
//   * a scope read failure fails CLOSED (nothing is offered, never a guess);
//   * pickPrimaryWorkbook is deterministic (latest accounting period wins);
//   * the route no longer uses an arbitrary [0] and logs each delivery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importTs } from '../scripts/_ts-import.mjs'

const finalize = await importTs('lib/whatsapp/finalize.ts')
const routeSrc = () => readFileSync(new URL('../app/api/whatsapp/route.ts', import.meta.url), 'utf8')
const sqlSrc = () => readFileSync(
  new URL('../supabase/migrations/20261027000000_delivery_scope_indexes.sql', import.meta.url), 'utf8')

const FUTURE = new Date(Date.now() + 3600_000).toISOString()

// ---- dataset: one workspace, two org clients + one client-less (individual) ----
const BATCHES = [
  { id: 'b-oct-c1', workspace_id: 'ws', client_id: 'C1', period_start: '2026-10-01' }, // Oct, client C1
  { id: 'b-sep-c1', workspace_id: 'ws', client_id: 'C1', period_start: '2026-09-01' }, // Sep, client C1
  { id: 'b-oct-c2', workspace_id: 'ws', client_id: 'C2', period_start: '2026-10-01' }, // Oct, OTHER client
  { id: 'b-sep-c2', workspace_id: 'ws', client_id: 'C2', period_start: '2026-09-01' }, // Sep, OTHER client
  { id: 'b-ind', workspace_id: 'ws', client_id: null, period_start: '2026-10-01' },    // individual batch
  { id: 'b-orphan', workspace_id: 'ws', client_id: 'C1', period_start: '2026-08-01' }, // no workbook (scoped-list member)
]
const WORKBOOKS = [
  { id: 'w-sep-c1', workspace_id: 'ws', batch_id: 'b-sep-c1', status: 'ready', file_object_path: 'p1', expires_at: FUTURE },
  { id: 'w-oct-c1', workspace_id: 'ws', batch_id: 'b-oct-c1', status: 'ready', file_object_path: 'p2', expires_at: FUTURE },
  { id: 'w-oct-c2', workspace_id: 'ws', batch_id: 'b-oct-c2', status: 'ready', file_object_path: 'p3', expires_at: FUTURE },
  { id: 'w-sep-c2', workspace_id: 'ws', batch_id: 'b-sep-c2', status: 'ready', file_object_path: 'p4', expires_at: FUTURE },
  { id: 'w-ind', workspace_id: 'ws', batch_id: 'b-ind', status: 'ready', file_object_path: 'p5', expires_at: FUTURE },
  { id: 'w-sent-c1', workspace_id: 'ws', batch_id: 'b-oct-c1', status: 'sent', file_object_path: 'p6', expires_at: FUTURE },
  { id: 'w-expired-c1', workspace_id: 'ws', batch_id: 'b-oct-c1', status: 'expired', file_object_path: 'p7', expires_at: FUTURE },
]
const FILED = [ // completed invoices per batch (for the per-month counts)
  { batch_id: 'b-oct-c1' }, { batch_id: 'b-oct-c1' }, { batch_id: 'b-sep-c1' },
  { batch_id: 'b-oct-c2' }, { batch_id: 'b-ind' },
]

/**
 * Filtering fake: honours eq / is / not(..,'is',..) / in exactly like PostgREST
 * would, so scope filters genuinely narrow rows (unlike the permissive fake in
 * onboarding.test.mjs, which returns whatever the resolver wants per call).
 */
function filteringDb({ failBatchRead = false } = {}) {
  const matches = (row, filters) => filters.every((f) => {
    if (f.eq) return row[f.eq[0]] === f.eq[1]
    if (f.is) return row[f.is[0]] === f.is[1]
    // Supabase `.not(col, 'is', null)` means "column is not null".
    if (f.not) return f.not[1] === 'is' && f.not[2] === null
      ? row[f.not[0]] !== null && row[f.not[0]] !== undefined
      : row[f.not[0]] !== f.not[2]
    if (f.in) return f.in[1].includes(row[f.in[0]])
    return true
  })
  const tableRows = (table) => {
    if (table === 'invoice_batches') return BATCHES
    if (table === 'generated_workbooks') return WORKBOOKS
    if (table === 'invoices') return [
      ...FILED.map((r) => ({ ...r, workspace_id: 'ws', status: 'completed' })),
      ...BATCHES.map((b) => ({ batch_id: b.id, workspace_id: 'ws', status: 'received' })), // every batch holds >=1 invoice, incl. b-orphan (no workbook yet)
    ]
    if (table === 'processing_jobs') return []
    return []
  }
  const mk = (table, verb, filters) => {
    const run = () => {
      if (table === 'invoice_batches' && verb === 'select' && failBatchRead) {
        return { data: null, error: { message: 'boom' } }
      }
      if (verb === 'delete' || verb === 'insert') return { data: null, error: null }
      let rows = tableRows(table).filter((r) => matches(r, filters))
      if (verb === 'count') return { count: rows.length, error: null }
      // status filter is chained via eq, but guard anyway for the ready sweep
      if (table === 'generated_workbooks' && verb === 'select') {
        rows = rows.filter((r) => r.file_object_path)
      }
      return { data: rows, error: null }
    }
    return {
      select(cols, opts) { return mk(table, opts && opts.count ? 'count' : verb === 'delete' ? 'delete' : 'select', filters) },
      insert() { return mk(table, 'insert', filters) },
      delete() { return mk(table, 'delete', filters) },
      eq(c, v) { return mk(table, verb, [...filters, { eq: [c, v] }]) },
      neq(c, v) { return mk(table, verb, [...filters, { neq: [c, v] }]) },
      in(c, v) { return mk(table, verb, [...filters, { in: [c, v] }]) },
      not(c, o, v) { return mk(table, verb, [...filters, { not: [c, o, v] }]) },
      is(c, v) { return mk(table, verb, [...filters, { is: [c, v] }]) },
      order() { return mk(table, verb, filters) },
      limit() { return mk(table, verb, filters) },
      maybeSingle() { return Promise.resolve(run()) },
      single() { return Promise.resolve(run()) },
      then(res, rej) { Promise.resolve(run()).then(res, rej) },
    }
  }
  return {
    from: (table) => mk(table, 'select', []),
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
}

test('D1 unscoped collectFinalizeState keeps the legacy workspace-wide ready read', async () => {
  const db = filteringDb()
  const c = await finalize.collectFinalizeState(db, 'ws')
  assert.equal(c.readyWorkbooks, 5, 'all live ready workbooks across clients are listed (backward compatible)')
  assert.ok(c.readyWorkbookIds.includes('w-sep-c2'))
})

test('D2 org scope: Done for client C1 only ever sees C1 batches — never C2, never another client\'s stale month', async () => {
  const db = filteringDb()
  const c = await finalize.collectFinalizeState(db, 'ws', { clientId: 'C1' })
  assert.deepEqual([...c.readyWorkbookIds].sort(), ['w-oct-c1', 'w-sep-c1'], 'only C1 owns these two months')
  assert.ok(!c.readyWorkbookIds.includes('w-oct-c2'), 'another client\'s register can never ride along')
  assert.ok(!c.readyWorkbookIds.includes('w-ind'), 'the individual batch is not the org client\'s either')
  assert.equal(c.readyWorkbooks, 2)
})

test('D3 individual scope (clientId null) only ever sees client-less batches', async () => {
  const db = filteringDb()
  const c = await finalize.collectFinalizeState(db, 'ws', { clientId: null })
  assert.deepEqual(c.readyWorkbookIds, ['w-ind'])
})

test('D4 the delivered summary link points at the LATEST period, not row order', async () => {
  const db = filteringDb()
  const c = await finalize.collectFinalizeState(db, 'ws', { clientId: 'C1' })
  const primary = finalize.pickPrimaryWorkbook(c.readyMonths ?? [])
  assert.equal(primary?.workbookId, 'w-oct-c1', 'October wins even though the September row was returned first')
  assert.equal(primary?.monthLabel, 'Oct 2026')
  // The stale sibling still exists and may be delivered as an extra attachment,
  // but it can never BE the link target.
  assert.notEqual(primary?.workbookId, 'w-sep-c1')
})

test('D5 a scope read failure fails CLOSED — no ready claim, never an unscoped fallback', async () => {
  const db = filteringDb({ failBatchRead: true })
  const c = await finalize.collectFinalizeState(db, 'ws', { clientId: 'C1' })
  assert.equal(c.readyWorkbooks, 0, 'a broken scope read must not widen to the whole workspace')
  assert.deepEqual(c.readyWorkbookIds, [])
  assert.deepEqual(c.readyMonths ?? [], [])
  assert.equal(finalize.pickPrimaryWorkbook(c.readyMonths ?? []), null, 'no link target exists')
})

test('D6 pickPrimaryWorkbook is pure + deterministic regardless of input order', () => {
  const months = [
    { workbookId: 'w-sep', monthLabel: 'Sep 2026', fileName: 'Billora_2026-09.xlsx', invoiceCount: 3, periodStart: '2026-09-01' },
    { workbookId: 'w-oct', monthLabel: 'Oct 2026', fileName: 'Billora_2026-10.xlsx', invoiceCount: 12, periodStart: '2026-10-01' },
    { workbookId: 'w-aug', monthLabel: 'Aug 2026', fileName: 'Billora_2026-08.xlsx', invoiceCount: 1, periodStart: '2026-08-01' },
  ]
  for (const list of [months, [...months].reverse(), [months[2], months[0], months[1]]]) {
    assert.equal(finalize.pickPrimaryWorkbook(list)?.workbookId, 'w-oct')
  }
  assert.equal(finalize.pickPrimaryWorkbook([]), null)
  // Undated workbooks rank below any real period, and tie-break on id.
  const undated = [
    { workbookId: 'w-a', monthLabel: null, fileName: 'f', invoiceCount: 0, periodStart: null },
    { workbookId: 'w-b', monthLabel: null, fileName: 'f', invoiceCount: 0 },
  ]
  assert.equal(finalize.pickPrimaryWorkbook(undated)?.workbookId, 'w-b')
  // Legacy callers without periodStart still work (no throw, stable pick).
  assert.equal(finalize.pickPrimaryWorkbook([
    { workbookId: 'w1', monthLabel: 'Oct 2026', fileName: 'f', invoiceCount: 0 },
    { workbookId: 'w2', monthLabel: 'Sep 2026', fileName: 'f', invoiceCount: 0 },
  ])?.workbookId, 'w2', 'without periods the id tie-break is deterministic')
})

test('D7 scoped Done re-arms only the scope\'s batches (ensureBatchRegisters)', async () => {
  const db = filteringDb()
  const scheduled = await finalize.ensureBatchRegisters(db, 'ws', { clientId: 'C1' })
  assert.equal(scheduled, BATCHES.filter((b) => b.client_id === 'C1').length, 'exactly C1\'s batches re-armed, C2/individual untouched')
  const dbAll = filteringDb()
  const all = await finalize.ensureBatchRegisters(dbAll, 'ws')
  assert.equal(all, BATCHES.length, 'unscoped call keeps the legacy workspace-wide behaviour')
})

test('D8 the September-in-October scenario end to end at the module boundary', async () => {
  // C1 finished October earlier this month; the September register somehow
  // stayed 'ready'. A fresh October Done must offer ONLY October as the link
  // and must never deliver C2\'s files.
  const db = filteringDb()
  const c = await finalize.collectFinalizeState(db, 'ws', { clientId: 'C1' })
  const linkTarget = finalize.pickPrimaryWorkbook(c.readyMonths ?? [])
  assert.equal(linkTarget?.workbookId, 'w-oct-c1')
  const deliveredPool = c.readyWorkbookIds
  assert.ok(!deliveredPool.some((id) => id.endsWith('-c2')), 'zero cross-client delivery surface')
  const msg = finalize.composeDoneMessage(
    { ...c, outstanding: 0, compiling: 0, needsReview: 0, missingDate: 0 },
    { link: `https://x/api/exports/${linkTarget.workbookId}/download` },
  )
  assert.match(msg, /register is ready \(2 workbooks\)/, 'truthful multi-month count preserved')
  assert.ok(msg.includes('/api/exports/w-oct-c1/download'), 'the link names the exact October workbook')
})

test('D9 route.ts source contract: no arbitrary [0], scope passed, delivery logged', () => {
  const r = routeSrc()
  assert.ok(!r.includes('counts.readyWorkbookIds[0]'), 'the wrong-month leak path is gone from the route')
  assert.match(r, /collectFinalizeState\(db, workspaceId, scope\)/, 'both finalize reads are client-scoped')
  assert.match(r, /const scope = \{ clientId: clientId \?\? null \}/, 'individuals scope to client-less batches')
  assert.match(r, /pickPrimaryWorkbook\(counts\.readyMonths \?\? \[\]\)/, 'the link is the deterministic latest-period pick')
  assert.match(r, /register delivery attempt[\s\S]*workbookId: id/, 'each delivery logs its exact workbook id (correlation)')
})

test('D10 delivery-scope migration is forward-only, additive, service-role safe', () => {
  const sql = sqlSrc()
  const executable = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  assert.match(executable, /create index if not exists invoice_batches_workspace_client_idx/)
  assert.match(executable, /create index if not exists generated_workbooks_ready_scope_idx/)
  assert.ok(!/drop\s/i.test(executable), 'never destructive')
  assert.ok(!/\bgrant\b/i.test(executable), 'grants nothing new — indexes only')
  assert.ok(!/alter table/i.test(executable), 'no column changes required for the scope fix')
})
