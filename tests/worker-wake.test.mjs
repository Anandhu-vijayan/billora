// §P2-9 worker wake-up after intake + 1-minute backstop.
// Two layers: (1) the PURE wake primitive is exercised IN-PROCESS via the real
// transpiled module (config resolution, fire-and-forget fetch shape, unconfigured
// no-op, rejection swallowing, secret never logged); (2) the enqueue call-sites and
// the cron are a source-contract — assert a wake fires ONLY on newly-created work,
// uses a RELATIVE import (so the transpile harness keeps loading intake/finalize),
// and that the serverless schedule is now every minute.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importTs } from '../scripts/_ts-import.mjs'

const wake = await importTs('lib/jobs/wake.ts')
const wakeSrc = () => readFileSync(new URL('../lib/jobs/wake.ts', import.meta.url), 'utf8')
const intakeSrc = () => readFileSync(new URL('../lib/whatsapp/intake.ts', import.meta.url), 'utf8')
const finalizeSrc = () => readFileSync(new URL('../lib/whatsapp/finalize.ts', import.meta.url), 'utf8')
const workflowSrc = () => readFileSync(new URL('../.github/workflows/worker.yml', import.meta.url), 'utf8')

// ---- workerWakeConfig ------------------------------------------------------
test('P2-9 wake config resolves only when BOTH url and secret are set', () => {
  assert.equal(wake.workerWakeConfig({}), null)
  assert.equal(wake.workerWakeConfig({ PUBLIC_APP_URL: 'https://app.test' }), null, 'no secret')
  assert.equal(wake.workerWakeConfig({ WORKER_SECRET: 's' }), null, 'no url')
  const cfg = wake.workerWakeConfig({ PUBLIC_APP_URL: 'https://app.test/', WORKER_SECRET: 'sekret' })
  assert.deepEqual(cfg, { url: 'https://app.test/api/jobs/worker', secret: 'sekret' })
  // Trailing slash(es) trimmed, single /api path.
  assert.equal(wake.workerWakeConfig({ PUBLIC_APP_URL: 'https://app.test///', WORKER_SECRET: 's' }).url, 'https://app.test/api/jobs/worker')
})

// ---- wakeWorker fire shape -------------------------------------------------
test('P2-9 an unconfigured wake fires no fetch at all (cron remains the driver)', () => {
  let calls = 0
  wake.wakeWorker({ env: {}, fetchImpl: () => { calls += 1; return Promise.resolve({}) } })
  assert.equal(calls, 0)
})

test('P2-9 a configured wake POSTs the worker endpoint with the token header + bounded body', async () => {
  const seen = []
  const fetchImpl = (url, init) => { seen.push({ url, init }); return Promise.resolve({ ok: true }) }
  wake.wakeWorker({
    env: { PUBLIC_APP_URL: 'https://app.test', WORKER_SECRET: 'sekret' },
    fetchImpl, limit: 7,
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://app.test/api/jobs/worker')
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers['x-worker-token'], 'sekret')
  assert.deepEqual(JSON.parse(seen[0].init.body), { limit: 7 })
  await new Promise((r) => setTimeout(r, 0)) // let the fire-and-forget settle
})

test('P2-9 the requested limit is clamped to 1..25 so a wake cannot over-claim', () => {
  const bodies = []
  const fetchImpl = (_u, init) => { bodies.push(JSON.parse(init.body).limit); return Promise.resolve({ ok: true }) }
  const env = { PUBLIC_APP_URL: 'https://app.test', WORKER_SECRET: 's' }
  wake.wakeWorker({ env, fetchImpl, limit: 0 })
  wake.wakeWorker({ env, fetchImpl, limit: 9999 })
  wake.wakeWorker({ env, fetchImpl, limit: -5 })
  wake.wakeWorker({ env, fetchImpl }) // default
  assert.deepEqual(bodies, [1, 25, 1, 5])
})

test('P2-9 a rejecting fetch is swallowed — a lost wake must never fail intake', async () => {
  const boom = () => Promise.reject(new Error('network down'))
  assert.doesNotThrow(() => wake.wakeWorker({
    env: { PUBLIC_APP_URL: 'https://app.test', WORKER_SECRET: 's' }, fetchImpl: boom,
  }))
  // A synchronous throw from fetch setup is equally harmless.
  assert.doesNotThrow(() => wake.wakeWorker({
    env: { PUBLIC_APP_URL: 'https://app.test', WORKER_SECRET: 's' },
    fetchImpl: () => { throw new Error('sync boom') },
  }))
  await new Promise((r) => setTimeout(r, 0)) // no unhandled rejection surfaces
})

// ---- wake.ts is pure + cannot leak the secret ------------------------------
test('P2-9 wake.ts imports no logger/alias and never references the secret in output', () => {
  const src = wakeSrc()
  // No logger IMPORT and no logger CALL (the word may appear in prose comments).
  assert.ok(!/from '[^']*logger'/.test(src) && !/logger\s*\./.test(src), 'no logger — the secret can never reach a log sink')
  assert.ok(!/from ['"]@\//.test(src), 'no @/ alias import — stays in-process testable')
  assert.ok(!/console\.(log|info|warn|error|debug)/.test(src), 'silent by design (cron is the backstop)')
})

// ---- enqueue call-sites ----------------------------------------------------
test('P2-9 intake fires a wake only when a NEW extraction job is created', () => {
  const src = intakeSrc()
  assert.ok(/import \{ wakeWorker \} from '\.\.\/jobs\/wake'/.test(src), 'relative import keeps the transpile harness loading intake.ts')
  assert.ok(!/from '@\/lib\/jobs\/wake'/.test(src), 'must NOT use the @/ alias (breaks importTs)')
  const rec = src.slice(src.indexOf('export async function recordMediaIntake'), src.indexOf('// ---- Pending uploads'))
  assert.ok(/if \(!jobPreexisting\) wakeWorker\(\)/.test(rec), 'no wake on a deduped redelivery')
  // The wake is after the job row is durably settled and before the return.
  const errIdx = rec.indexOf("JOB_RECORD_ERROR")
  const wakeIdx = rec.indexOf('wakeWorker()')
  const retIdx = rec.indexOf('return { invoiceId, jobId')
  assert.ok(errIdx >= 0 && wakeIdx > errIdx && wakeIdx < retIdx, 'wake fires only after a durable job row')
})

test('P2-9 finalize wakes the worker only when register work was actually scheduled', () => {
  const src = finalizeSrc()
  assert.ok(/import \{ wakeWorker \} from '\.\.\/jobs\/wake'/.test(src), 'relative import (importTs loads finalize in-process)')
  assert.ok(!/from '@\/lib\/jobs\/wake'/.test(src), 'must NOT use the @/ alias')
  assert.ok(/if \(scheduled > 0\) wakeWorker\(\)/.test(src), 'no wake when nothing was enqueued')
})

// ---- schedule backstop -----------------------------------------------------
test('P2-9 the serverless worker schedule is every minute', () => {
  assert.match(workflowSrc(), /cron: '\* \* \* \* \*'/)
})
