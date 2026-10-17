// Regression tests for the failure in the 2026-10-17 log:
//   [Vision] Gemini request failed ... failureClass "permanent"
//   [Extract] AI fallback failed permanently ... VISION_CONFIDENCE_KEYS_INVALID
// Gemini answered in 11 s, but the response validator demanded 13 confidence keys
// while the response schema only asks for 9, so every valid answer was rejected.
//
// vision.ts imports the Gemini SDK and the `@/` alias, which the lightweight TS
// loader cannot resolve, so the real source is loaded with those imports stubbed
// (the parsing code under test is untouched).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import ts from 'typescript'
import sharp from 'sharp'
import { importTs } from '../scripts/_ts-import.mjs'

const STUB_PATH = 'tests/.vision.stub.ts'
const src = readFileSync(new URL('../lib/ocr/vision.ts', import.meta.url), 'utf8')
  .replace(/import \{ GoogleGenAI, Type \} from '@google\/genai'/, "const GoogleGenAI: any = class {}; const Type: any = new Proxy({}, { get: (_t, k) => String(k) })")
  .replace(/import \{ logger \} from '@\/lib\/logger'/, 'const logger = { info() {}, warn() {}, error() {} }')
  .replace(/import type \{ LedgerCandidate \} from '@\/lib\/ocr\/ledger'/, 'type LedgerCandidate = any')
  .replace(/import \{ buildGeminiInvoiceRequest \} from '@\/lib\/ocr\/gemini-request'/, 'const buildGeminiInvoiceRequest: any = () => ({})')
writeFileSync(new URL(`../${STUB_PATH}`, import.meta.url), src)
const { parseVisionJson, VisionPermanentError } = await importTs(STUB_PATH)
after(() => rmSync(new URL(`../${STUB_PATH}`, import.meta.url), { force: true }))

// What Gemini returns for the schema in vision.ts (confidence has the 9 keys the schema asks for).
const good = () => ({
  invoice_date: '2025-04-22', invoice_number: 'PPP/0001/25-26', vendor_name: 'Add Company Name',
  supplier_gstin: '29AAAAA1234F000', recipient_gstin: '',
  taxable_value: 100000, cgst_amount: 0, sgst_amount: 0, igst_amount: 18000, total_amount: 116800,
  cgst_rate_percent: null, sgst_rate_percent: null, igst_rate_percent: '18', total_amount_in_words: 'One Lakh Sixteen Thousand Eight Hundred Only',
  confidence: {
    invoice_date: 0.9, invoice_number: 0.9, vendor_name: 0.6, supplier_gstin: 0.8,
    taxable_value: 0.95, cgst_amount: 0.9, sgst_amount: 0.9, igst_amount: 0.95, total_amount: 0.95,
  },
})
const parse = (o) => parseVisionJson(JSON.stringify(o))
const failsWith = (o, code) => assert.throws(() => parse(o), (e) => e instanceof VisionPermanentError && e.message === code)

test('V1 the exact response shape the schema requests is ACCEPTED (was VISION_CONFIDENCE_KEYS_INVALID)', () => {
  const c = parse(good())
  assert.equal(c.total_amount, 116800)
  assert.deepEqual(Object.keys(c.confidence).sort(), [
    'cgst_amount', 'igst_amount', 'invoice_date', 'invoice_number', 'sgst_amount',
    'supplier_gstin', 'taxable_value', 'total_amount', 'vendor_name',
  ])
})

test('V2 a null confidence for an unknown amount is accepted and scored 0 (schema marks it nullable)', () => {
  const o = good(); o.cgst_amount = null; o.confidence.cgst_amount = null
  assert.equal(parse(o).confidence.cgst_amount, 0)
})

test('V3 optional evidence fields may be absent; unknown extra keys are ignored', () => {
  const o = good(); delete o.cgst_rate_percent; delete o.total_amount_in_words; o.review_notes = []
  const c = parse(o)
  assert.equal(c.cgst_rate_percent, null)
  assert.equal(c.total_amount_in_words, null)
})

test('V4 genuine problems are still rejected', () => {
  const noTotal = good(); delete noTotal.total_amount
  failsWith(noTotal, 'VISION_SCHEMA_KEYS_INVALID')
  const missingConf = good(); delete missingConf.confidence.vendor_name
  failsWith(missingConf, 'VISION_CONFIDENCE_KEYS_INVALID')
  const outOfRange = good(); outOfRange.confidence.invoice_date = 1.5
  failsWith(outOfRange, 'VISION_CONFIDENCE_INVALID:invoice_date')
  const nullTextConf = good(); nullTextConf.confidence.invoice_number = null
  failsWith(nullTextConf, 'VISION_CONFIDENCE_INVALID:invoice_number')
  const badType = good(); badType.taxable_value = '100000'
  failsWith(badType, 'VISION_FIELD_TYPE_INVALID:taxable_value')
  const badEvidence = good(); badEvidence.igst_rate_percent = 18
  failsWith(badEvidence, 'VISION_FIELD_TYPE_INVALID:igst_rate_percent')
  assert.throws(() => parseVisionJson('not json'), (e) => e.message === 'UNPARSEABLE_VISION_JSON')
  assert.throws(() => parseVisionJson(''), (e) => e.message === 'EMPTY_VISION_RESPONSE')
})

test('V5 the prompt tells the model the tax regime rule so absent heads come back as explicit 0', () => {
  assert.match(src, /EITHER IGST OR CGST\+SGST/)
  assert.match(src, /return 0 for cgst_amount and sgst_amount/)
})

// ---- extractor / worker wiring --------------------------------------------------
const extractor = readFileSync(new URL('../lib/ocr/invoice-extractor.ts', import.meta.url), 'utf8')
const worker = readFileSync(new URL('../lib/jobs/worker.ts', import.meta.url), 'utf8')

function loadFromExtractor(startMarker, endMarker, exportsList) {
  const from = extractor.indexOf(startMarker)
  const to = extractor.indexOf(endMarker, from)
  assert.ok(from >= 0 && to > from, `markers not found: ${startMarker}`)
  const js = ts.transpileModule(extractor.slice(from, to).replace(/^export /gm, ''), { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
  return (deps) => new Function(...Object.keys(deps), `${js}\nreturn { ${exportsList} }`)(...Object.values(deps))
}

test('V6 Gemini receives a small colour JPEG, never the 3 MB OCR PNG', async () => {
  const make = loadFromExtractor('const VISION_MAX_EDGE', 'const SETTLEABLE_VISION_FAILURE', 'prepareImageForVision')
  class InvoiceExtractionError extends Error {}
  const { prepareImageForVision } = make({ sharp, MAX_IMAGE_PIXELS: 40_000_000, InvoiceExtractionError })
  const noise = Buffer.alloc(3000 * 2000 * 3)
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 7919 + (i >> 5)) & 255
  const big = await sharp(noise, { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()
  const out = await prepareImageForVision(big)
  const meta = await sharp(out).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.ok(Math.max(meta.width, meta.height) <= 1600, `long edge ${Math.max(meta.width, meta.height)}`)
  assert.ok(out.length < big.length, 'smaller than the original')
  assert.equal(meta.channels, 3, 'colour is preserved (the OCR copy is greyscale)')
  // a small phone photo is not upscaled
  const small = await sharp({ create: { width: 800, height: 1100, channels: 3, background: '#ffffff' } }).jpeg().toBuffer()
  const m2 = await sharp(await prepareImageForVision(small)).metadata()
  assert.deepEqual([m2.width, m2.height], [800, 1100])
  // the OCR path is untouched and the AI paths use the vision image
  assert.equal((extractor.match(/prepareImageForVision\(buffer\)/g) ?? []).length, 2, 'first and second AI pass')
  assert.ok(!/buffer: normalized,\s*mimeType: 'image\/png'/.test(extractor), 'no OCR-PNG sent to Gemini')
  assert.ok(extractor.includes('const png = await normalizeImageToPng(buffer)'), 'Tesseract still gets the OCR copy')
})

test('V7 an unusable AI answer settles on the local result; config faults still fail the job', () => {
  const make = loadFromExtractor('const SETTLEABLE_VISION_FAILURE', 'async function extractLocal(', 'isSettleableVisionFailure')
  const { isSettleableVisionFailure } = make({})
  for (const m of ['VISION_CONFIDENCE_KEYS_INVALID', 'VISION_SCHEMA_KEYS_INVALID', 'VISION_FIELD_TYPE_INVALID:taxable_value',
    'EMPTY_VISION_RESPONSE', 'UNPARSEABLE_VISION_JSON', 'provider_error']) {
    assert.equal(isSettleableVisionFailure(m), true, m)
  }
  for (const m of ['UNSUPPORTED_MEDIA_TYPE: image/heic', 'VISION_UNCONFIGURED: GEMINI_API_KEY missing', 'EMPTY_MEDIA', 'INVALID_GEMINI_REQUEST_SHAPE']) {
    assert.equal(isSettleableVisionFailure(m), false, m)
  }
  assert.ok(extractor.includes('if (!settleable) throw error'))
})

test('V8 the lease heartbeat stops before the job settles, and a late renewal is not logged as an ownership loss', () => {
  const stopIdxOk = worker.indexOf('heartbeat.stop() // stop renewing BEFORE the job settles')
  const completeIdx = worker.indexOf('await completeJob(db, job.id, worker)')
  assert.ok(stopIdxOk > 0 && stopIdxOk < completeIdx, 'stop() precedes completeJob')
  const stopIdxFail = worker.indexOf('heartbeat.stop() // never renew a lease while (or after) failing the job')
  const failIdx = worker.indexOf('await failJob(db, {', stopIdxFail) // the handler-failure call, not the earlier HANDLER_NOT_REGISTERED one
  assert.ok(stopIdxFail > 0 && failIdx > stopIdxFail, 'stop() precedes failJob')
  assert.ok(worker.includes('if (stopped) throw error'), 'a refused in-flight renewal after stop() is expected, not an error log')
})
