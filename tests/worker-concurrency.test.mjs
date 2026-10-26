// §P2-10 parallel claim + process bounded by JOB_CONCURRENCY.
// worker.ts imports the erased bare 'crypto' + `@/lib/logger`, so it stays a
// SOURCE-CONTRACT module (like the rest of the queue tests). We assert the tick
// now claims a bounded BATCH and runs it concurrently, that a batch is capped by
// BOTH the remaining per-tick budget AND JOB_CONCURRENCY, that each job still
// settles independently (never rejects the batch), and that the budget guard is
// re-checked before every batch — so parallelism can never blow the 60s function
// window or over-claim. A contract drift fails loudly here, not silently in prod.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workerSrc = () => readFileSync(new URL('../lib/jobs/worker.ts', import.meta.url), 'utf8')
const envSrc = () => readFileSync(new URL('../lib/env.ts', import.meta.url), 'utf8')
const exampleSrc = () => readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

test('P2-10 JOB_CONCURRENCY is read, defaulted and hard-capped', () => {
  const src = workerSrc()
  // Tie the default/cap to the SAME function that reads JOB_CONCURRENCY (the two
  // numeric readers share an identical body, so bind the assertion to the var).
  assert.match(
    src,
    /const jobConcurrency[\s\S]*?process\.env\.JOB_CONCURRENCY[\s\S]*?parsed > 0 \? Math\.min\(parsed, 25\) : 3/,
    'reads the env var, default 3, capped at 25',
  )
})

test('P2-10 the tick claims a bounded batch and runs it concurrently', () => {
  const src = workerSrc()
  assert.match(src, /const concurrency = jobConcurrency\(\)/)
  // A batch is capped by the concurrency AND the remaining per-tick budget, so it
  // can never claim more than maxJobs across the whole tick.
  assert.match(src, /const want = Math\.min\(concurrency, maxJobs - result\.claimed\)/)
  assert.match(src, /claimJobs\(db, \{ worker, jobTypes, limit: want, leaseSeconds \}\)/)
  assert.match(src, /result\.claimed \+= batch\.length/)
  assert.match(src, /await Promise\.all\(batch\.map\(\(job\) => processClaimedJob\(db, job, worker, leaseSeconds, result\)\)\)/)
})

test('P2-10 the per-job worker is extracted and never rejects the batch', () => {
  const src = workerSrc()
  assert.match(src, /async function processClaimedJob\([\s\S]*?\): Promise<void> \{/)
  // Missing handler: requeue (swallowed) and return — not throw, not abort batch.
  assert.match(src, /errorCode: 'HANDLER_NOT_REGISTERED'[\s\S]*?\}\)\.catch\(\(\) => undefined\)/)
  // Lease-loss and handler failures are recorded, not propagated.
  assert.match(src, /if \(e instanceof JobLeaseLostError\) \{[\s\S]*?result\.fenced \+= 1[\s\S]*?return/)
  // Lease ownership is still enforced + released per job (heartbeat unchanged).
  assert.match(src, /startHeartbeat\(db, job, worker, leaseSeconds\)/)
  assert.match(src, /heartbeat\.stop\(\)/)
})

test('P2-10 the tick budget guard is re-checked before every batch claim', () => {
  const src = workerSrc()
  const loop = src.slice(src.indexOf('while (result.claimed < maxJobs)'))
  const guardIdx = loop.indexOf('Date.now() > deadline || (result.claimed > 0 && Date.now() > deadline - minJobWindowMs())')
  const claimIdx = loop.indexOf('claimJobs(db,')
  assert.ok(guardIdx >= 0 && claimIdx > guardIdx, 'budget + min-window checked BEFORE the batch is claimed')
})

test('P2-10 JOB_CONCURRENCY is validated in env and documented for operators', () => {
  assert.match(envSrc(), /JOB_CONCURRENCY: z\.string\(\)\.optional\(\)/)
  assert.match(exampleSrc(), /^JOB_CONCURRENCY=3$/m)
})
