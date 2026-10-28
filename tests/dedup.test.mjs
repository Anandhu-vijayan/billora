// §Part-5 duplicate-prevention tests.
//
// The identity primitive (lib/invoices/dedup.ts) is alias-free + imports only
// `node:crypto`, so the in-process harness runs the REAL function — these are
// behavioural tests. The WIRING lives in `@/`-aliased modules the harness cannot
// import (route.ts intake skip, extract-invoice fold + fail-soft write, intake
// lookup), so those are pinned by source-contract (readFileSync), exactly like
// the classification suite. A contract change fails loudly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importTs } from '../scripts/_ts-import.mjs'

const dedup = await importTs('lib/invoices/dedup.ts')
const {
  IDENTITY_KEY_DOMAIN, DUPLICATE_IDENTITY_REASON, DUPLICATE_FILE_REASON,
  normalizeInvoiceNumber, normalizeVendorName, normalizeGstin, normalizeIdentityDate,
  buildSupplierDiscriminator, computeIdentityKey, identityKeyToBytea, byteaToHexKey,
} = dedup

// A fixed 32-byte master key (hex) so a derived index is stable across runs.
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const GSTIN = '27AAPFU0939F1ZV'

// ===========================================================================
// Normalizers.
// ===========================================================================
test('DP-norm: invoice number is uppercased and stripped of punctuation', () => {
  assert.equal(normalizeInvoiceNumber('inv-0042'), 'INV0042')
  assert.equal(normalizeInvoiceNumber(' INV / 0042 '), 'INV0042')
  assert.equal(normalizeInvoiceNumber('a1!b2'), 'A1B2')
  assert.equal(normalizeInvoiceNumber(null), '')
  assert.equal(normalizeInvoiceNumber('   '), '')
})

test('DP-norm: vendor name collapses separators to single spaces', () => {
  assert.equal(normalizeVendorName('acme  traders pvt ltd'), 'ACME TRADERS PVT LTD')
  assert.equal(normalizeVendorName('Acme-Traders.'), 'ACME TRADERS')
  assert.equal(normalizeVendorName(''), '')
})

test('DP-norm: date is ONLY a canonical YYYY-MM-DD — never partial or textual', () => {
  assert.equal(normalizeIdentityDate('2026-04-05'), '2026-04-05')
  assert.equal(normalizeIdentityDate('2026-4-5'), '')   // not zero-padded => refuse
  assert.equal(normalizeIdentityDate('05/04/2026'), '') // not ISO => refuse
  assert.equal(normalizeIdentityDate('2026-04'), '')    // partial => refuse
  assert.equal(normalizeIdentityDate(null), '')
})

test('DP-norm: GSTIN keeps only alphanumerics, uppercased', () => {
  assert.equal(normalizeGstin(' 27aapfu0939f1zv '), '27AAPFU0939F1ZV')
  assert.equal(normalizeGstin(null), '')
})

// ===========================================================================
// Supplier discriminator: GSTIN namespace vs vendor-name namespace.
// ===========================================================================
test('DP-supplier: a GSTIN wins over a vendor name (strongest identity)', () => {
  assert.equal(buildSupplierDiscriminator({ supplierGstin: GSTIN, vendorName: 'ACME' }), `g:${GSTIN}`)
})

test('DP-supplier: with no GSTIN the normalized vendor name is used', () => {
  assert.equal(buildSupplierDiscriminator({ vendorName: 'acme traders' }), 'n:ACME TRADERS')
})

test('DP-supplier: no supplier at all yields an empty discriminator', () => {
  assert.equal(buildSupplierDiscriminator({}), '')
})

// ===========================================================================
// computeIdentityKey: the core never-key-when-partial + collision guarantees.
// ===========================================================================
test('DP-key: identical identity produces an identical blind index (deterministic)', () => {
  const a = computeIdentityKey({ invoiceNumber: 'INV-0042', supplierGstin: GSTIN, invoiceDate: '2026-04-05' }, KEY)
  const b = computeIdentityKey({ invoiceNumber: 'inv 0042', supplierGstin: GSTIN, invoiceDate: '2026-04-05' }, KEY)
  assert.ok(a && b)
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('DP-key: punctuation / case differences in the number collapse to one index', () => {
  const variants = ['INV-0042', 'inv0042', 'INV/0042', '  INV 0042 ']
  const keys = variants.map((n) => computeIdentityKey({ invoiceNumber: n, supplierGstin: GSTIN, invoiceDate: '2026-04-05' }, KEY))
  assert.equal(new Set(keys).size, 1, 'all spellings must key identically')
})

test('DP-key: a different month is a DIFFERENT invoice (never collapsed)', () => {
  const apr = computeIdentityKey({ invoiceNumber: 'INV-1', supplierGstin: GSTIN, invoiceDate: '2026-04-05' }, KEY)
  const may = computeIdentityKey({ invoiceNumber: 'INV-1', supplierGstin: GSTIN, invoiceDate: '2026-05-05' }, KEY)
  assert.notEqual(apr, may)
})

test('DP-key: GSTIN and vendor-name namespaces never collide (no false positive)', () => {
  // Same invoice number + date, but one bill identified by GSTIN and a different
  // one by a vendor name that happens to normalize the same as the raw GSTIN text.
  const byGstin = computeIdentityKey({ invoiceNumber: 'INV-1', supplierGstin: GSTIN, invoiceDate: '2026-04-05' }, KEY)
  const byName = computeIdentityKey({ invoiceNumber: 'INV-1', vendorName: GSTIN, invoiceDate: '2026-04-05' }, KEY)
  assert.ok(byGstin && byName)
  assert.notEqual(byGstin, byName, 'g:<gstin> and n:<name> must never key identically')
})

test('DP-key: NEVER keys a partial identity (missing number / supplier / date)', () => {
  assert.equal(computeIdentityKey({ supplierGstin: GSTIN, invoiceDate: '2026-04-05' }, KEY), null)      // no number
  assert.equal(computeIdentityKey({ invoiceNumber: 'INV-1', invoiceDate: '2026-04-05' }, KEY), null)     // no supplier
  assert.equal(computeIdentityKey({ invoiceNumber: 'INV-1', supplierGstin: GSTIN }, KEY), null)          // no date
  assert.equal(computeIdentityKey({ invoiceNumber: 'INV-1', supplierGstin: GSTIN, invoiceDate: '2026-04' }, KEY), null) // partial date
  assert.equal(computeIdentityKey({}, KEY), null)
})

test('DP-key: a missing master key yields no index (never an unkeyed HMAC)', () => {
  assert.equal(computeIdentityKey({ invoiceNumber: 'INV-1', supplierGstin: GSTIN, invoiceDate: '2026-04-05' }, ''), null)
})

test('DP-key: the same identity under a different master key is a different index', () => {
  const other = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  const id = { invoiceNumber: 'INV-1', supplierGstin: GSTIN, invoiceDate: '2026-04-05' }
  assert.notEqual(computeIdentityKey(id, KEY), computeIdentityKey(id, other))
})

test('DP-key: the index carries no plaintext of any identity field', () => {
  const key = computeIdentityKey({ invoiceNumber: 'INV-0042', vendorName: 'ACME TRADERS', invoiceDate: '2026-04-05' }, KEY)
  assert.ok(key)
  assert.doesNotMatch(key, /INV|0042|ACME|2026/i) // it is a fixed-length hex digest only
})

// ===========================================================================
// bytea encoding round-trip.
// ===========================================================================
test('DP-bytea: hex <-> Postgres bytea literal round-trips', () => {
  assert.equal(identityKeyToBytea('ab12'), '\\xab12')
  assert.equal(identityKeyToBytea(null), null)
  assert.equal(byteaToHexKey('\\xab12'), 'ab12')
  assert.equal(byteaToHexKey('AB12'), 'ab12') // raw hex, lowercased
  assert.equal(byteaToHexKey('not-hex'), null)
  assert.equal(byteaToHexKey(null), null)
})

test('DP-constants: reason codes are stable strings the review editor maps', () => {
  assert.equal(DUPLICATE_IDENTITY_REASON, 'possible-duplicate')
  assert.equal(DUPLICATE_FILE_REASON, 'duplicate-file')
  assert.equal(IDENTITY_KEY_DOMAIN, 'billora:identity:v1:')
})

// ===========================================================================
// SOURCE CONTRACT — wiring the harness cannot import.
// ===========================================================================
const routeSrc = () => readFileSync(new URL('../app/api/whatsapp/route.ts', import.meta.url), 'utf8')
const intakeSrc = () => readFileSync(new URL('../lib/whatsapp/intake.ts', import.meta.url), 'utf8')
const extractSrc = () => readFileSync(new URL('../lib/jobs/handlers/extract-invoice.ts', import.meta.url), 'utf8')
const editorSrc = () => readFileSync(new URL('../lib/whatsapp/review-edit.ts', import.meta.url), 'utf8')
const migrationSrc = () => readFileSync(
  new URL('../supabase/migrations/20261019000000_duplicate_prevention.sql', import.meta.url), 'utf8')

test('DP-wire: intake lookup is fail-open and scoped to live rows by file_sha256', () => {
  const src = intakeSrc()
  assert.match(src, /export async function findLiveInvoiceByFileHash\(/)
  assert.match(src, /\.eq\('file_sha256', `\\\\x\$\{args\.fileSha256Hex\}`\)/, 'matches the stored \\x-hex bytea')
  assert.match(src, /\.neq\('status', 'deleted'\)/, 'only LIVE invoices count')
  assert.match(src, /\.eq\('workspace_id', args\.workspaceId\)/, 'tenant-scoped')
  // fail-open: both an error result and a thrown error return null (never block).
  assert.match(src, /duplicate lookup failed[\s\S]*?return null/)
  assert.match(src, /catch \(e\)[\s\S]*?return null/)
})

test('DP-wire: route skips + acks an exact-file duplicate BEFORE upload/queue', () => {
  const src = routeSrc()
  assert.match(src, /import \{[^}]*findLiveInvoiceByFileHash[^}]*\} from '@\/lib\/whatsapp\/intake'/)
  const callIdx = src.indexOf('findLiveInvoiceByFileHash(db')
  const uploadIdx = src.indexOf('.upload(objectPath')
  const jobIdx = src.indexOf('recordMediaIntake(db')
  assert.ok(callIdx > 0, 'lookup is called at intake')
  assert.ok(callIdx < uploadIdx, 'the duplicate check precedes the storage upload')
  assert.ok(callIdx < jobIdx, 'the duplicate check precedes the extraction-job insert')
  // a confirmed duplicate sends one ack and returns without filing a second row
  assert.match(src, /if \(duplicateFileInvoiceId\)[\s\S]*?await sendText[\s\S]*?return;/)
})

test('DP-wire: extraction folds a possible-duplicate ADDITIVELY and writes the key fail-soft', () => {
  const src = extractSrc()
  assert.match(src, /import \{[^}]*computeIdentityKey[^}]*DUPLICATE_IDENTITY_REASON[^}]*\} from '@\/lib\/invoices\/dedup'/, 'imports the primitive')
  assert.match(src, /const priorId = await findPriorDuplicateIdentity\(/, 'looks for a prior live duplicate')
  // additive only: it forces needs_review, never approves, and adds the reason once.
  assert.match(src, /if \(priorId\)[\s\S]*?evaluation\.review = 'needs_review'/)
  assert.match(src, /if \(!evaluation\.reasons\.includes\(DUPLICATE_IDENTITY_REASON\)\)[\s\S]*?evaluation\.reasons = \[\.\.\.evaluation\.reasons, DUPLICATE_IDENTITY_REASON\]/)
  assert.doesNotMatch(src, /if \(priorId\)[\s\S]*?evaluation\.review = 'approved'/, 'a duplicate is never auto-approved')
  // identity_key is a SEPARATE fail-soft write after the status update (never combined).
  const statusIdx = src.indexOf('INVOICE_STATUS_ERROR')
  const keyIdx = src.indexOf("update({ identity_key:")
  assert.ok(statusIdx > 0 && keyIdx > statusIdx, 'the key write happens after (not inside) the status update')
  assert.match(src, /identity_key write skipped[\s\S]*?logger\.warn/, 'a failed key write is a warning, not a throw')
  // the lookup helper degrades to null so an unapplied migration cannot break extraction.
  assert.match(src, /async function findPriorDuplicateIdentity\([\s\S]*?return null/)
})

test('DP-wire: the review editor explains possible-duplicate in plain English', () => {
  const src = editorSrc()
  assert.ok(src.includes("'possible-duplicate'"), "REASON_TEXT must carry 'possible-duplicate'")
})

test('DP-wire: migration adds identity_key + a partial live index and is additive-only', () => {
  const src = migrationSrc()
  assert.match(src, /add column if not exists identity_key bytea/)
  assert.match(src, /create index invoices_identity_dup_idx[\s\S]*?where identity_key is not null and status <> 'deleted'/)
  assert.doesNotMatch(src, /grant[^;]*to (anon|authenticated)/i, 'the column widens no browser-visible surface')
})
