// §P3-13 real sharp image-quality gate (blurry / too-small). Three layers:
//   (1) the PURE metric (laplacianVariance + judgeResolution + defaults) is exercised
//       IN-PROCESS by slicing it out of quality.ts and running it on synthetic grids
//       — no sharp, no alias, fully deterministic;
//   (2) the sharp glue (assessSourceImageQuality) is run IN-PROCESS through a stubbed
//       import (only `@/lib/logger` is stubbed) against REAL sharp-generated images:
//       a blurred photo -> too-blurry, a tiny image -> too-small, a crisp high-res
//       page -> ok, and a non-image buffer -> fail OPEN (never throws, never gates);
//   (3) the wiring is a SOURCE-CONTRACT — the extractor runs the gate on rasters only,
//       returns imageQualityReasons, forces needs_review without ever approving; the
//       handler folds those reasons into the authoritative row; the codes map to plain
//       English; and the env knobs + docs exist. This is exactly where a wrong "auto-
//       approve over garbage" bug would live, so it is pinned loudly.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import ts from 'typescript'
import sharp from 'sharp'
import { importTs } from '../scripts/_ts-import.mjs'

const qualitySrc = () => readFileSync(new URL('../lib/ocr/quality.ts', import.meta.url), 'utf8')

// ---- (1) pure metric, sliced + run standalone ------------------------------
function loadPure() {
  const src = qualitySrc()
  const from = src.indexOf('export const DEFAULT_IMAGE_QUALITY')
  const to = src.indexOf('export async function assessSourceImageQuality')
  assert.ok(from >= 0 && to > from, 'pure region markers found')
  const region = src.slice(from, to).replace(/^export /gm, '').replace(/: [A-Za-z<>|\[\] ]+ =/g, ' =')
  const js = ts.transpileModule(region, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText
  // transpileModule has already erased the TS type annotations, so this runs the
  // pure JS with no external deps.
  return new Function(`${js}\nreturn { DEFAULT_IMAGE_QUALITY, laplacianVariance, judgeResolution }`)()
}

test('P3-13 laplacianVariance separates sharp text from a flat field', () => {
  const { laplacianVariance } = loadPure()
  // 2x2 has no interior pixels -> unmeasurable, not "flat".
  assert.equal(laplacianVariance({ data: new Uint8Array(4), width: 2, height: 2 }), null)
  // A perfectly flat grey image has zero Laplacian response.
  const flat = new Uint8Array(50 * 50).fill(128)
  assert.equal(laplacianVariance({ data: flat, width: 50, height: 50 }), 0)
  // High-contrast vertical stripes maximise the horizontal Laplacian term.
  const striped = new Uint8Array(50 * 50)
  for (let y = 0; y < 50; y += 1) for (let x = 0; x < 50; x += 1) striped[y * 50 + x] = x % 2 === 0 ? 0 : 255
  const v = laplacianVariance({ data: striped, width: 50, height: 50 })
  assert.ok(v !== null && v > 1000, `striped variance should be large, got ${v}`)
})

test('P3-13 judgeResolution uses ORIGINAL dimensions and only reports low-res', () => {
  const { judgeResolution, DEFAULT_IMAGE_QUALITY } = loadPure()
  assert.equal(judgeResolution(60, 80, DEFAULT_IMAGE_QUALITY).lowRes, true, 'tiny')
  assert.equal(judgeResolution(1200, 1600, DEFAULT_IMAGE_QUALITY).lowRes, false, 'normal photo')
  // A long edge above the floor but too FEW total pixels is still low-res.
  const r = judgeResolution(700, 300, { minLongEdge: 500, minPixels: 250_000, blurVarianceAtMost: 100 })
  assert.equal(r.lowRes, true, '700x300 = 210k px < 250k floor')
  assert.deepEqual(
    judgeResolution(800, 600, DEFAULT_IMAGE_QUALITY),
    { lowRes: false, longEdge: 800, pixels: 480_000 },
  )
})

// ---- (2) sharp glue, run against real generated images ---------------------
const STUB = 'tests/.quality.stub.ts'
// importTs copies the module next to the stub and resolves RELATIVE runtime deps
// from there, so the two unused ./validators / ./calc imports (which the sharp glue
// never touches) are stubbed alongside the `@/lib/logger` alias. Only `sharp` stays
// real, so assessSourceImageQuality runs against genuine image decodes.
const stubbed = qualitySrc()
  .replace(
    /import \{ logger \} from '@\/lib\/logger'/,
    'const logger = { info() {}, warn() {}, error() {}, debug() {} }',
  )
  .replace(
    /import \{ moneyToMinorUnits \} from '\.\/validators\/money'/,
    'const moneyToMinorUnits = () => 0',
  )
  .replace(
    /import \{ reconcileInvoiceTotal \} from '\.\/calc\/reconcile'/,
    'const reconcileInvoiceTotal = () => ({ status: "ok" })',
  )
writeFileSync(new URL(`../${STUB}`, import.meta.url), stubbed)
const quality = await importTs(STUB)
after(() => rmSync(new URL(`../${STUB}`, import.meta.url), { force: true }))

async function makeNoiseJpeg(width, height) {
  const raw = Buffer.alloc(width * height)
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) & 255
  return sharp(raw, { raw: { width, height, channels: 1 }, limitInputPixels: false })
    .png({ compressionLevel: 0 })
    .toBuffer()
}
async function makeBlurredJpeg(width, height) {
  const base = await makeNoiseJpeg(width, height)
  return sharp(base).blur(8).jpeg({ quality: 90 }).toBuffer()
}

test('P3-13 assessSourceImageQuality flags a genuinely blurry photo', async () => {
  const buf = await makeBlurredJpeg(1200, 1200)
  const v = await quality.assessSourceImageQuality(buf)
  assert.equal(v.lowRes, false, 'resolution is fine')
  assert.equal(v.blurry, true, `heavy blur should be flagged, focusScore=${v.focusScore}`)
  assert.deepEqual(v.reasons, ['image-too-blurry'])
})

test('P3-13 a crisp high-resolution page passes the gate', async () => {
  const buf = await makeNoiseJpeg(1400, 1400)
  const v = await quality.assessSourceImageQuality(buf)
  assert.equal(v.lowRes, false)
  assert.equal(v.ok, true, `sharp noise should not be blurry, focusScore=${v.focusScore}`)
  assert.deepEqual(v.reasons, [])
})

test('P3-13 a too-small image reports low-res (and never also blurry)', async () => {
  const buf = await makeNoiseJpeg(120, 120)
  const v = await quality.assessSourceImageQuality(buf)
  assert.equal(v.lowRes, true)
  assert.equal(v.blurry, false, 'a tiny image is judged on resolution only')
  assert.deepEqual(v.reasons, ['image-too-small'])
})

test('P3-13 a non-image buffer fails OPEN: no throw, no gate', async () => {
  const v = await quality.assessSourceImageQuality(Buffer.from('not a real image at all'))
  assert.equal(v.ok, true, 'measurement faults never gate a real row')
  assert.deepEqual(v.reasons, [])
})

// ---- (3) wiring source-contract --------------------------------------------
const extractorSrc = () => readFileSync(new URL('../lib/ocr/invoice-extractor.ts', import.meta.url), 'utf8')
const handlerSrc = () => readFileSync(new URL('../lib/jobs/handlers/extract-invoice.ts', import.meta.url), 'utf8')
const reviewEditSrc = () => readFileSync(new URL('../lib/whatsapp/review-edit.ts', import.meta.url), 'utf8')
const envSrc = () => readFileSync(new URL('../lib/env.ts', import.meta.url), 'utf8')
const exampleSrc = () => readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

test('P3-13 the extractor runs the gate on rasters only and folds reasons without approving', () => {
  const e = extractorSrc()
  assert.match(e, /from '@\/lib\/ocr\/quality'/, 'extractor imports the gate')
  assert.match(e, /if \(mimeType !== PDF_MIME && options\.imageQualityGate\?\.enabled !== false\) \{/, 'raster-only + honour disable flag')
  assert.match(e, /await assessSourceImageQuality\(buffer, \{/, 'measures the ORIGINAL raster buffer')
  assert.match(e, /\.\.\.imageQualityReasons,/, 'quality reasons reach the returned reasons')
  // It can only ever force needs_review, never the reverse. (§P3-14 added
  // `|| multiInvoiceDetected` to the same approve-veto disjunction — still a
  // downgrade-only gate, so this invariant must keep holding with the new term.)
  assert.match(e, /evaluation\.review === 'approved' &&\s*\(conflictFields\.length > 0 \|\| imageQualityReasons\.length > 0 \|\| multiInvoiceDetected\)\s*\?\s*'needs_review'/, 'a quality failure downgrades approve -> review only')
  assert.match(e, /imageQualityReasons,\n\s*multiInvoiceDetected,\n  \}/, 'imageQualityReasons (+ the §P3-14 flag) is returned for the handler')
})

test('P3-13 the handler folds the verdict into the authoritative re-evaluated row', () => {
  const h = handlerSrc()
  assert.match(h, /imageQualityGate: imageQualityGateFromEnv\(env\)/, 'gate config is passed in')
  assert.match(h, /const imageQualityReasons = result\.imageQualityReasons \?\? \[\]/, 'reads the verdict defensively')
  assert.match(h, /if \(evaluation\.review === 'approved'\) evaluation\.review = 'needs_review'/, 'forces review, never approves')
  assert.match(h, /evaluation\.reasons = \[\.\.\.evaluation\.reasons, \.\.\.imageQualityReasons\]/, 'persists the reason codes')
  // Config helper honours the disable flag + only forwards set thresholds.
  assert.match(h, /enabled: env\.IMAGE_QUALITY_GATE !== false/)
  assert.match(h, /typeof env\.IMAGE_BLUR_VARIANCE_MAX === 'number' \? \{ blurVarianceAtMost: env\.IMAGE_BLUR_VARIANCE_MAX \} : \{\}/)
})

test('P3-13 the codes map to plain English and the env knobs are documented', () => {
  assert.match(reviewEditSrc(), /'image-too-blurry': 'the photo looks too blurry to read reliably'/)
  assert.match(reviewEditSrc(), /'image-too-small': 'the image resolution is too low to read reliably'/)
  assert.match(envSrc(), /IMAGE_QUALITY_GATE: boolFromEnv\(true\)/)
  assert.match(envSrc(), /IMAGE_BLUR_VARIANCE_MAX: z\.coerce\.number\(\)\.int\(\)\.nonnegative\(\)\.optional\(\)/)
  assert.match(exampleSrc(), /^IMAGE_QUALITY_GATE=true$/m)
})

test('P3-13 the fake file-size/cut-off heuristics are gone (no dead, misleading code)', () => {
  const q = qualitySrc()
  assert.ok(!/function isBlurryHeuristic/.test(q), 'file-size blur heuristic removed')
  assert.ok(!/function isCutOff/.test(q), 'crude text cut-off heuristic removed')
  // The real gate must not be reachable from a PDF (its own pipeline), asserted above;
  // and GSTIN_RE stays byte-identical to ledger.ts (G5d guards that separately).
  assert.ok(q.includes('const GSTIN_RE = /'), 'GSTIN rule still lives here for G5d')
})
