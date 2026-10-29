// §6 register CONCURRENCY + VERSIONING / DELIVERY-ISOLATION metadata.
//
// The build/publish handler lives behind a `@/` alias the in-process harness
// cannot import, so — exactly like the dedup and classification wiring suites —
// these are SOURCE CONTRACTS (readFileSync + regex). They pin the safety
// properties that matter: the additive migration is truly additive, the base
// publish never depends on the new columns (so an unapplied migration cannot
// break register generation), the source-revision re-check uses ONLY base-schema
// columns and degrades SOFT when it cannot run, and every provenance write is a
// separate fail-soft best-effort step.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const handlerSrc = () => readFileSync(
  new URL('../lib/jobs/handlers/build-register.ts', import.meta.url), 'utf8')
const migrationSrc = () => readFileSync(
  new URL('../supabase/migrations/20261029000100_workbook_source_revision.sql', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Migration — additive, nullable, no widened surface.
// ---------------------------------------------------------------------------
test('§6-mig: every provenance column is added IF NOT EXISTS and NULLABLE', () => {
  const src = migrationSrc()
  for (const col of [
    'source_dataset_revision text',
    'source_row_count integer',
    'source_membership_hash bytea',
    'workbook_checksum bytea',
    'retired_at timestamptz',
  ]) {
    assert.match(src, new RegExp(`add column if not exists ${col.replace(' ', '\\s+')}`), `missing additive column: ${col}`)
  }
  // forward-only / re-runnable and it must not add NOT NULL (would break legacy rows)
  assert.doesNotMatch(src, /add column[\s\S]*?not null/i, 'no NOT NULL column is added to a live table')
  // the API surface is not widened: no new grant/policy on the read-only workbook table
  assert.doesNotMatch(src, /grant[\s\S]*?to (anon|authenticated)/i, 'grants are unchanged')
  assert.doesNotMatch(src, /create policy/i, 'no new RLS policy is created')
})

// ---------------------------------------------------------------------------
// Base publish path stays independent of the new columns (backward compat).
// ---------------------------------------------------------------------------
test('§6-wire: the CORE workbook insert never names a provenance column', () => {
  const src = handlerSrc()
  const insIdx = src.indexOf("from('generated_workbooks').insert({")
  assert.ok(insIdx > 0, 'the register publishes via a generated_workbooks insert')
  const insBlock = src.slice(insIdx, src.indexOf('.select(\'id\')', insIdx))
  for (const col of ['source_dataset_revision', 'source_row_count', 'source_membership_hash', 'workbook_checksum']) {
    assert.ok(!insBlock.includes(col), `the base insert must NOT require ${col} (unapplied migration cannot break publish)`)
  }
})

test('§6-wire: the source fingerprint is captured over already-fetched rows', () => {
  const src = handlerSrc()
  assert.match(src, /\.select\('invoice_id,encrypted_payload,review_status,updated_at'\)/, 'reads updated_at for the revision')
  assert.match(src, /const membershipHashHex = createHash\('sha256'\)[\s\S]*?\.invoice_id\)\.sort\(\)\.join/, 'membership is a sorted-id digest')
  assert.match(src, /const sourceRevision = createHash\('sha256'\)[\s\S]*?\.updated_at/, 'revision folds updated_at (detects edits/approvals)')
})

test('§6-wire: publish re-checks the source and refuses a mid-build change', () => {
  const src = handlerSrc()
  // re-reads the approved set right before retiring/publishing
  const recheckIdx = src.indexOf("select('invoice_id,updated_at')")
  const freshnessIdx = src.indexOf('// Freshness: retire prior workbooks')
  assert.ok(recheckIdx > 0, 'the approved source set is re-read before publish')
  assert.ok(freshnessIdx > 0 && recheckIdx < freshnessIdx, 'the re-check happens BEFORE the publish retire/version')
  // a genuine change is a NORMAL throw (requeue + rebuild), never a silent stale publish
  assert.match(src, /if \(curRevision !== sourceRevision\)[\s\S]*?throw new Error\('REGISTER_SOURCE_CHANGED/)
  assert.doesNotMatch(src, /REGISTER_SOURCE_CHANGED[\s\S]*?PermanentJobError/, 'a stale-source guard requeues; it is never a permanent failure')
  // the re-check degrades SOFT if it cannot run — it must never block a clean build
  assert.match(src, /logger\.warn\([^)]*source-revision re-check unavailable/, 'an unrunnable re-check logs and proceeds')
})

test('§6-wire: provenance + retired_at writes are separate, guarded, fail-soft', () => {
  const src = handlerSrc()
  // metadata is its own update (never folded into the core insert) and is guarded
  assert.match(src, /try \{[\s\S]*?\.update\(\{\s*source_dataset_revision: sourceRevision[\s\S]*?\} catch/, 'metadata write is guarded')
  assert.match(src, /source_row_count: rows\.length/, 'rendered count is recorded')
  assert.match(src, /workbook_checksum: `\\\\x\$\{workbookChecksumHex\}`/, 'plaintext checksum is stored as bytea')
  assert.match(src, /logger\.warn\([^)]*workbook metadata columns skipped/, 'a failed metadata write is a warning, not a throw')
  // retired_at is a separate best-effort helper, called on BOTH retire paths
  assert.match(src, /async function markRetiredAt\([\s\S]*?\.update\(\{ retired_at: new Date\(\)/)
  assert.match(src, /logger\.warn\([^)]*retired_at stamp skipped/, 'a failed retired_at is a warning')
  const retireFnBody = src.slice(src.indexOf('async function retireLiveWorkbooks'), src.indexOf('async function findOwnerSenderHmac'))
  assert.match(retireFnBody, /await markRetiredAt\(/, 'the no-op/empty-batch retire stamps retired_at too')
})

test('§6-wire: the guard relies on base-schema columns only (active pre-migration)', () => {
  const src = handlerSrc()
  // re-check queries extracted_records.updated_at — a column present in the initial
  // schema — so concurrency safety is live even before the additive migration runs.
  assert.match(src, /from\('extracted_records'\)\.select\('invoice_id,updated_at'\)[\s\S]*?\.eq\('review_status', 'approved'\)/)
})
