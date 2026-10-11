// Queue poller for hosts that can run a process (dev machine, VM, container).
// It is a thin driver for POST /api/jobs/worker — the queue itself lives in
// Postgres, so any scheduler works (GitHub Actions cron, systemd timer, an
// always-on container). Serverless-only deployments should call the same
// endpoint from their scheduler instead of running this.
//
// Requires the dev/production server to be running and WORKER_SECRET set.
//   npm run worker:poll            # every 5s
//   WORKER_INTERVAL_MS=15000 npm run worker:poll
const base = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const secret = process.env.WORKER_SECRET ?? ''
const intervalMs = Number.parseInt(process.env.WORKER_INTERVAL_MS ?? '5000', 10)
const limit = process.env.WORKER_LIMIT ?? '3'

if (!secret) {
  console.error('worker:poll requires WORKER_SECRET (same value the server uses).')
  process.exit(1)
}

let stopped = false
const stop = () => { stopped = true }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

console.log(`worker:poll -> POST ${base}/api/jobs/worker every ${intervalMs}ms (Ctrl+C to stop)`)

while (!stopped) {
  const started = Date.now()
  try {
    const res = await fetch(`${base}/api/jobs/worker`, {
      method: 'POST',
      headers: { 'x-worker-token': secret, 'content-type': 'application/json' },
      body: JSON.stringify({ limit: Number.parseInt(limit, 10) }),
      signal: AbortSignal.timeout(Math.max(intervalMs * 4, 60_000)),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      console.warn(`${res.status} tick failed ->`, JSON.stringify(body)?.slice(0, 200))
    } else if (body && body.idle !== true) {
      console.log(`tick -> claimed=${body.claimed} completed=${body.completed} ` +
        `requeued=${body.requeued} failed=${body.failed} fenced=${body.fenced} recovered=${body.recovered}`)
    } else {
      console.log('tick -> idle')
    }
  } catch (e) {
    console.warn('tick error:', e instanceof Error ? e.message : String(e))
  }
  const wait = Math.max(0, intervalMs - (Date.now() - started))
  if (stopped) break
  await new Promise((r) => setTimeout(r, wait))
}
console.log('worker:poll stopped')
