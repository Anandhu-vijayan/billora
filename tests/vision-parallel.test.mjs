// §P2-11 opt-in parallel local OCR + Gemini, second pass still skipped on reconcile.
// The extractor's AI path can't be exercised without a live key + image, so (in
// line with the existing V-tests) this is a SOURCE-CONTRACT: we pin the security/
// cost invariants — the parallel launch is strictly opt-in + AI-gated, there is
// exactly ONE first-pass vision call whether or not it was speculative, an unused
// speculative call can never surface as an unhandled rejection, and the bounded
// second pass only ever fires when the merge is still needs_review (i.e. a
// reconciled/approved merge never pays for another call). A drift fails loudly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const extractor = () => readFileSync(new URL('../lib/ocr/invoice-extractor.ts', import.meta.url), 'utf8')
const handlerSrc = () => readFileSync(new URL('../lib/jobs/handlers/extract-invoice.ts', import.meta.url), 'utf8')
const envSrc = () => readFileSync(new URL('../lib/env.ts', import.meta.url), 'utf8')
const exampleSrc = () => readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

test('P2-11 the parallel launch is opt-in and only ever fires when AI is allowed + keyed', () => {
  const src = extractor()
  assert.match(
    src,
    /const parallelVision = options\.parallelVision === true && allowAI && Boolean\(apiKey\)/,
    'parallel requires the caller flag AND the AI gate AND a key',
  )
  assert.match(src, /if \(parallelVision\) \{[\s\S]*?speculativeAi = runVisionFirstPass/, 'only launches under the opt-in')
  // Default is OFF everywhere: env falls back false, handler only forwards true.
  assert.match(envSrc(), /EXTRACTION_VISION_PARALLEL: boolFromEnv\(false\)/)
  assert.match(handlerSrc(), /parallelVision: env\.EXTRACTION_VISION_PARALLEL === true/)
  assert.match(exampleSrc(), /^EXTRACTION_VISION_PARALLEL=false$/m)
})

test('P2-11 exactly one first-pass vision call runs whether speculative or not', () => {
  const src = extractor()
  // The block reuses the started promise if present, else calls now, and clears it.
  assert.match(src, /const firstPass = speculativeAi \?\? runVisionFirstPass\(\{ buffer, mimeType, apiKey, model \}\)/)
  assert.match(src, /speculativeAi = null/)
  assert.match(src, /let aiCandidate: LedgerCandidate = await firstPass/)
  // AI block is entered on insufficiency OR to consume a launched speculative pass.
  assert.match(src, /if \(allowAI && \(needsAI \|\| speculativeAi !== null\)\) \{/)
})

test('P2-11 an unused speculative call cannot raise an unhandled rejection', () => {
  assert.match(extractor(), /speculativeAi\.catch\(\(\) => undefined\)/)
})

test('P2-11 the V6 Gemini-payload invariant still holds (exactly two vision copies)', () => {
  const src = extractor()
  // One in runVisionFirstPass (the shared first pass), one in the bounded retry.
  assert.equal((src.match(/prepareImageForVision\(buffer\)/g) ?? []).length, 2, 'first and second AI pass only')
  assert.ok(/async function runVisionFirstPass/.test(src), 'first pass is factored into a helper')
  assert.ok(!/buffer: normalized,\s*mimeType: 'image\/png'/.test(src), 'the OCR PNG is still never sent to Gemini')
})

test('P2-11 the bounded second pass still fires ONLY on an unreconciled (needs_review) merge', () => {
  const src = extractor()
  // The whole second-pass block sits under a needs_review guard: a merge that
  // already approved (the sources reconciled) never pays for another provider call.
  const guard = src.indexOf("if (aiEvaluation.review === 'needs_review') {")
  assert.ok(guard > 0, 'second pass is gated on the merged result still needing review')
  const block = src.slice(guard, src.indexOf('[Extract] AI fallback completed', guard))
  assert.match(block, /secondPass = true/, 'and only then is a second pass taken')
})
