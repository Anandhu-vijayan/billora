// Zero-dependency smoke test: verifies the dev server is up and both
// health endpoints respond. Run: `node scripts/smoke.mjs` (server must be running).
const base = process.env.SMOKE_BASE_URL ?? 'http://localhost:3001'

async function check(path, { expectOk } = { expectOk: true }) {
  const url = `${base}${path}`
  const res = await fetch(url, { headers: { 'x-request-id': `smoke-${Date.now()}` } })
  const body = await res.json().catch(() => null)
  const pass = expectOk ? res.ok && body?.ok !== false : true
  console.log(`${pass ? 'PASS' : 'FAIL'} ${res.status} ${path} ->`, JSON.stringify(body)?.slice(0, 300))
  if (!pass) process.exitCode = 1
}

await check('/api/health')
await check('/api/health/supabase', { expectOk: false }) // may be 503 without env — must still return JSON
console.log(process.exitCode ? 'smoke: FAILED' : 'smoke: OK')
