// tests/register-fingerprint.test.mjs — "did this register actually change?", in process.
//
// Field symptom this pins: the owner received SEVERAL Excel files that each held a
// single row, for a month whose content had not moved. Every rebuild of a cumulative
// register minted a new `version`, and each new version recorded its own owed delivery
// — so a repeated "Done" (or re-confirming an already-approved bill) re-sent the same
// partial snapshot instead of leaving the live register alone. `fingerprintSourceKeys`
// is the rule that decides whether a rebuild carries new information at all.
//
// The module is dependency-free by design (node:crypto only), so these tests run the
// REAL shipped code rather than a reimplementation of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importTs } from '../scripts/_ts-import.mjs'

const { fingerprintSourceKeys, parseStoredFingerprint } = await importTs('lib/jobs/handlers/register-fingerprint.ts')

const key = (id, updatedAt) => `${id}\u0000${updatedAt}`
const A = key('inv-aaaa', '2026-11-03T16:13:30.224')
const B = key('inv-bbbb', '2026-11-03T16:12:59.733')
const HEX64 = 'a'.repeat(64)

test('FINGERPRINT-01 an unchanged bucket fingerprints identically, byte for byte', () => {
  // The repeated-Done path: the same approved rows render again, so the rebuild must be
  // provably a duplicate and never re-publish (never re-owe, never re-send).
  assert.equal(fingerprintSourceKeys([A, B]), fingerprintSourceKeys([A, B]))
  assert.match(fingerprintSourceKeys([A, B]), /^[0-9a-f]{64}$/, 'a one-way digest, nothing readable')
})

test('FINGERPRINT-02 row order never changes the verdict (a re-read can return any order)', () => {
  assert.equal(fingerprintSourceKeys([B, A, A]), fingerprintSourceKeys([A, A, B]))
})

test('FINGERPRINT-03 a re-approval or correction moves the fingerprint (never a stale skip)', () => {
  const edited = key('inv-aaaa', '2026-11-03T16:30:18.100') // same invoice, updated_at moved
  assert.notEqual(fingerprintSourceKeys([A, B]), fingerprintSourceKeys([edited, B]))
})

test('FINGERPRINT-04 a new invoice in the month moves the fingerprint', () => {
  const C = key('inv-cccc', '2026-11-03T16:29:15.058')
  assert.notEqual(fingerprintSourceKeys([A, B]), fingerprintSourceKeys([A, B, C]))
})

test('FINGERPRINT-05 a withdrawn/deleted invoice moves the fingerprint', () => {
  assert.notEqual(fingerprintSourceKeys([A, B]), fingerprintSourceKeys([A]))
})

test('FINGERPRINT-06 the bucket is a multiset: a doubled row is not the same as one row', () => {
  assert.notEqual(fingerprintSourceKeys([A, A]), fingerprintSourceKeys([A]))
})

test('FINGERPRINT-07 an empty bucket has its own stable fingerprint, distinct from any row', () => {
  assert.equal(fingerprintSourceKeys([]), fingerprintSourceKeys([]))
  assert.notEqual(fingerprintSourceKeys([]), fingerprintSourceKeys([key('x', '')]))
})

test('FINGERPRINT-08 nothing identifying survives the digest (no invoice id, no timestamp)', () => {
  const out = fingerprintSourceKeys([A, B])
  assert.ok(!out.includes('inv-aaaa') && !out.includes('inv-bbbb'), 'no invoice id in the value')
  assert.ok(!out.includes('2026-11-03') && !out.includes('16:13:30'), 'no activity timestamp in the value')
  assert.match(out, /^[0-9a-f]{64}$/, 'hex only, fixed length')
})

test('PARSE-01 a bytea text fingerprint decodes to the comparable hex', () => {
  assert.equal(parseStoredFingerprint(`\\x${HEX64}`), HEX64)
})

test('PARSE-02 a plain-text revision column is accepted as a fingerprint too', () => {
  // `source_dataset_revision` stores bare hex; for a single-category month it is the
  // identical key construction, so it proves sameness just like the membership hash.
  assert.equal(parseStoredFingerprint(HEX64), HEX64)
})

test('PARSE-03 case never fakes a change', () => {
  const mixed = createHashShuffle()
  assert.equal(parseStoredFingerprint(`\\x${mixed.toUpperCase()}`), mixed)
})

test('PARSE-04 anything unprovable is "unknown", which always means rebuild', () => {
  for (const raw of [null, undefined, '', '   ', 'not-hex', 'abc12', `\\x${'z'.repeat(64)}`, 'Y'.repeat(44) + '=']) {
    assert.equal(parseStoredFingerprint(raw), '', `${JSON.stringify(raw)} must not look comparable`)
  }
})

// A deterministic 64-hex sample (no fixture hashes floating around the suite).
function createHashShuffle() {
  let s = ''
  for (let i = 0; i < 64; i++) s += ((i * 7 + 3) % 16).toString(16)
  return s
}
