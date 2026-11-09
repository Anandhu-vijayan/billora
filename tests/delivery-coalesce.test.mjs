// tests/delivery-coalesce.test.mjs — the register-spam rule, in process.
//
// Field symptom this pins: one upload burst buried the owner in 4-5 copies of
// their OWN October register (2 invoices, then 3, then the real 5), because a
// cumulative register is republished — a new `version` — after every approval and
// each published version was separately owed and shipped. `newestPerScope` is the
// rule that stops it: one file per (batch, category), the newest version wins.
//
// The module is dependency-free by design, so these tests run the REAL shipped
// code rather than a reimplementation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importTs } from '../scripts/_ts-import.mjs'

const coalesce = await importTs('lib/jobs/handlers/delivery-coalesce.ts')

const OCT = 'b-oct'
const NOV = 'b-nov'
const row = (id, workbookId) => ({ id, workbook_id: workbookId })
const fields = (...entries) => new Map(entries.map(([wb, batchId, category, version]) => [wb, { batchId, category, version }]))

test('COALESCE-01 the five published versions of one month collapse to the newest alone', () => {
  // Exactly the logged burst: v1(2 rows) .. v5(5 rows) all owed for October.
  const claimed = [row('d1', 'w-oct-v1'), row('d2', 'w-oct-v2'), row('d3', 'w-oct-v3'), row('d4', 'w-oct-v4'), row('d5', 'w-oct-v5')]
  const f = fields(
    ['w-oct-v1', OCT, 'purchase', 1],
    ['w-oct-v2', OCT, 'purchase', 2],
    ['w-oct-v3', OCT, 'purchase', 3],
    ['w-oct-v4', OCT, 'purchase', 4],
    ['w-oct-v5', OCT, 'purchase', 5],
  )
  const { keep, superseded } = coalesce.newestPerScope(claimed, f)
  assert.deepEqual(keep.map((d) => d.workbook_id), ['w-oct-v5'], 'ONE October file is sent — the complete one')
  assert.deepEqual(superseded.map((d) => d.id), ['d1', 'd2', 'd3', 'd4'], 'every intermediate copy is dropped, not queued behind it')
})

test('COALESCE-02 a newest-first page still keeps the newest (order is not the rule)', () => {
  const claimed = [row('d1', 'w-oct-v5'), row('d2', 'w-oct-v3'), row('d3', 'w-oct-v4')]
  const { keep, superseded } = coalesce.newestPerScope(claimed, fields(
    ['w-oct-v5', OCT, 'purchase', 5],
    ['w-oct-v3', OCT, 'purchase', 3],
    ['w-oct-v4', OCT, 'purchase', 4],
  ))
  assert.deepEqual(keep.map((d) => d.workbook_id), ['w-oct-v5'])
  assert.equal(superseded.length, 2)
})

test('COALESCE-03 two months in one burst are BOTH delivered — coalescing never withholds a distinct register', () => {
  const claimed = [row('d1', 'w-oct-v2'), row('d2', 'w-nov-v2'), row('d3', 'w-nov-v3')]
  const { keep, superseded } = coalesce.newestPerScope(claimed, fields(
    ['w-oct-v2', OCT, 'purchase', 2],
    ['w-nov-v2', NOV, 'purchase', 2],
    ['w-nov-v3', NOV, 'purchase', 3],
  ))
  assert.deepEqual(keep.map((d) => d.workbook_id).sort(), ['w-nov-v3', 'w-oct-v2'], 'one file per MONTH, not one file per burst')
  assert.deepEqual(superseded.map((d) => d.id), ['d2'], 'only the stale November copy is dropped')
})

test('COALESCE-04 categories of one month are independent files, never each other\'s supersede', () => {
  const claimed = [row('d1', 'w-oct-pur-v7'), row('d2', 'w-oct-capi-v2')]
  const { keep, superseded } = coalesce.newestPerScope(claimed, fields(
    ['w-oct-pur-v7', OCT, 'purchase', 7],
    ['w-oct-capi-v2', OCT, 'capital_goods', 2],
  ))
  assert.deepEqual(keep.map((d) => d.workbook_id).sort(), ['w-oct-capi-v2', 'w-oct-pur-v7'], 'both registers ship — they are different documents')
  assert.equal(superseded.length, 0)
})

test('COALESCE-05 the legacy NULL category is its own scope, never merged with a named one', () => {
  // A pre-migration purchase row (category NULL) and a per-category row share the
  // batch. Keying null as `undefined`-ish would silently collide them.
  const claimed = [row('d1', 'w-oct-legacy'), row('d2', 'w-oct-purchase')]
  const { keep } = coalesce.newestPerScope(claimed, fields(
    ['w-oct-legacy', OCT, null, 1],
    ['w-oct-purchase', OCT, 'purchase', 1],
  ))
  assert.equal(keep.length, 2, 'null and "purchase" render as different scope keys')
})

test('COALESCE-06 an unknown version loses to a real one instead of shadowing the complete file', () => {
  const claimed = [row('d1', 'w-oct-noversion'), row('d2', 'w-oct-v4')]
  const { keep, superseded } = coalesce.newestPerScope(claimed, fields(
    ['w-oct-noversion', OCT, 'purchase', null],
    ['w-oct-v4', OCT, 'purchase', 4],
  ))
  assert.deepEqual(keep.map((d) => d.workbook_id), ['w-oct-v4'])
  assert.deepEqual(superseded.map((d) => d.id), ['d1'])
})

test('COALESCE-07 a row we cannot scope is ALWAYS kept — never drop a file on a guess', () => {
  const claimed = [row('d1', 'w-no-batch'), row('d2', 'w-read-failed'), row('d3', 'w-oct-v2')]
  const { keep, superseded } = coalesce.newestPerScope(claimed, fields(
    ['w-no-batch', null, 'purchase', 9],
    // 'w-read-failed' is deliberately absent: its field read returned nothing.
    ['w-oct-v2', OCT, 'purchase', 2],
  ))
  assert.deepEqual(keep.map((d) => d.workbook_id), ['w-oct-v2', 'w-no-batch', 'w-read-failed'], 'unscopable rows survive')
  assert.equal(superseded.length, 0, 'and are never sacrificed to a scoped sibling')
})

test('COALESCE-08 an empty page collapses to nothing (no phantom keep, no throw)', () => {
  const { keep, superseded } = coalesce.newestPerScope([], new Map())
  assert.deepEqual(keep, [])
  assert.deepEqual(superseded, [])
})

test('ERRORNOTE-01 a failure note names what + why, stays bounded, and never carries a recipient', () => {
  assert.equal(coalesce.errorNote('SEND_BLOCKED', 'http 400 code 131000 sub 1'), 'SEND_BLOCKED: http 400 code 131000 sub 1')
  assert.equal(coalesce.errorNote('SEND_BLOCKED', null), 'SEND_BLOCKED', 'a missing detail still records the outcome')
  assert.equal(coalesce.errorNote('SEND_BLOCKED', '   '), 'SEND_BLOCKED', 'blank detail is not rendered as an empty suffix')
  const long = coalesce.errorNote('SEND_TRANSIENT', 'x'.repeat(500))
  assert.equal(long.length, 120, 'bounded to the column width — a long provider payload cannot reject the write')
  assert.ok(!/wa_id|\+\d{8,}/.test(long), 'no recipient-shaped text is ever woven into a note')
})
