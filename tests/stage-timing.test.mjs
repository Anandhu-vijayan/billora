// §P2-12 per-stage timing logs. Two layers: (1) the PURE StageTimer primitive is
// exercised IN-PROCESS with an injected clock (segment math, non-negative clamp,
// total, immutable-ish summary); (2) the wiring is a SOURCE-CONTRACT — the extract
// handler must mark the four pipeline stages and emit one structured timing line,
// the worker must time each job's handler, and the OCR engine must report local +
// vision first-pass durations. Timing must be METADATA ONLY (stage names + integer
// ms) — never invoice content, never a token.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importTs } from '../scripts/_ts-import.mjs'

const timing = await importTs('lib/jobs/timing.ts')

// ---- StageTimer (pure, injected clock) ------------------------------------
test('P2-12 mark() segments elapsed ms in order and clamps a coarse clock at 0', () => {
  let now = 1000
  const clock = () => now
  const t = new timing.StageTimer(clock)
  now = 1500
  assert.equal(t.mark('a'), 500)
  now = 1500 // no time passed
  assert.equal(t.mark('b'), 0, 'same-tick mark reports 0, never negative')
  now = 1400 // clock went BACKWARD (coarse/imprecise): must still be >= 0
  assert.equal(t.mark('c'), 0, 'a backward clock cannot produce a negative stage')
})

test('P2-12 total() measures from construction and summary() lists every stage', () => {
  let now = 0
  const clock = () => now
  const t = new timing.StageTimer(clock)
  now = 100
  t.mark('decrypt')
  now = 350
  t.mark('extract')
  now = 400
  t.mark('persist')
  now = 600
  const s = t.summary()
  assert.equal(s.totalMs, 600)
  assert.deepEqual(s.stages, [
    { stage: 'decrypt', ms: 100 },
    { stage: 'extract', ms: 250 },
    { stage: 'persist', ms: 50 },
  ])
})

test('P2-12 summary() returns a copy so a later mark cannot mutate an emitted line', () => {
  let now = 0
  const t = new timing.StageTimer(() => now)
  now = 10
  t.mark('a')
  const snapshot = t.summary()
  now = 40
  t.mark('b')
  assert.equal(snapshot.stages.length, 1, 'the earlier snapshot is frozen')
  assert.equal(snapshot.totalMs, 10)
})

// ---- wiring: extract handler pipeline stages ------------------------------
const handlerSrc = () => readFileSync(new URL('../lib/jobs/handlers/extract-invoice.ts', import.meta.url), 'utf8')
const workerSrc = () => readFileSync(new URL('../lib/jobs/worker.ts', import.meta.url), 'utf8')
const extractorSrc = () => readFileSync(new URL('../lib/ocr/invoice-extractor.ts', import.meta.url), 'utf8')

test('P2-12 the extract handler marks decrypt/extract/persist/batch and logs one timing line', () => {
  const h = handlerSrc()
  assert.match(h, /import \{ StageTimer \} from '@\/lib\/jobs\/timing'/, 'handler uses the shared primitive')
  assert.match(h, /const timing = new StageTimer\(\)/, 'a timer spans the job')
  for (const stage of ['decrypt', 'extract', 'persist', 'batch']) {
    assert.ok(h.includes(`timing.mark('${stage}')`), `stage '${stage}' is timed`)
  }
  assert.match(h, /\[Extract\] stage timing[\s\S]*?\.\.\.timing\.summary\(\)/, 'emits the per-stage breakdown')
  // Stage order must follow the real pipeline.
  const order = ['decrypt', 'extract', 'persist', 'batch'].map((s) => h.indexOf(`timing.mark('${s}')`))
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'marks appear in pipeline order')
})

test('P2-12 the worker times each claimed job handler and reports duration on failure', () => {
  const w = workerSrc()
  assert.match(w, /import \{ StageTimer \} from '@\/lib\/jobs\/timing'/)
  assert.match(w, /const jobTiming = new StageTimer\(\)/)
  assert.match(w, /jobTiming\.mark\('handler'\)/)
  assert.match(w, /\[Worker\] job timing[\s\S]*?\.\.\.jobTiming\.summary\(\)/)
  assert.match(w, /durationMs: jobTiming\.total\(\)/, 'a failed job still reports how long it ran')
})

test('P2-12 the OCR engine reports local and vision first-pass durations (metadata only)', () => {
  const e = extractorSrc()
  assert.match(e, /\[Extract\] local OCR stage complete[\s\S]*?durationMs: Date\.now\(\) - localStartedAt/)
  assert.match(e, /\[Extract\] vision first pass complete[\s\S]*?durationMs: Date\.now\(\) - aiStartedAt/)
})

test('P2-12 timing lines carry only stage names + durations, never candidate values', () => {
  // The handler's timing line must not spread the candidate/row/evaluation values.
  const h = handlerSrc()
  const line = h.slice(h.indexOf("'[Extract] stage timing'"), h.indexOf("'[Extract] stage timing'") + 200)
  assert.ok(!/candidate|encrypted_payload|evaluation\.row|plain/.test(line), 'no payload/PII in the timing line')
})
