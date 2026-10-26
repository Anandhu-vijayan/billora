// scripts/eval.mjs — the acceptance harness runner (§Acceptance).
//
// Runs `npm run eval`. It scores a directory of labelled GOLDEN samples against the
// pure scorer in lib/eval/score.ts and prints per-field accuracy, exact-row accuracy,
// the AUTO-APPROVE PRECISION (0 wrong required), the % auto-approved, and p50/p95
// latency, then applies the CI gate.
//
// GOLDEN FORMAT — one `<id>.json` per bill under the goldens dir (default
// `test-data/goldens`, override with EVAL_GOLDENS_DIR). Each file is a labelled pair:
//   {
//     "id": "acme-2026-09-05",
//     "expected": { ...human ground truth, core fields... },
//     "actual":   { ...captured extractor output..., "review": "approved"|"needs_review",
//                   "reasons": [...], "latencyMs": 1234 }
//   }
// `actual` is produced by running the real extraction pipeline over the bill (a
// human step that needs OCR/Gemini + the invoice file). The harness only SCORES the
// pairs it is handed.
//
// NON-NEGOTIABLE: it MUST NOT fabricate a pass. If there are no real labelled bills
// it prints how to add them and exits NON-ZERO — CI therefore cannot go green on an
// empty or missing golden set, and cannot hide an auto-approve precision drop.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { importTs } from './_ts-import.mjs'

const { scoreEval, evaluateGate, DEFAULT_GATE, CORE_EVAL_FIELDS } = await importTs('lib/eval/score.ts')

const goldensDir = resolve(process.env.EVAL_GOLDENS_DIR ?? join(process.cwd(), 'test-data', 'goldens'))
const minExact = process.env.EVAL_MIN_EXACT_ROW_ACCURACY != null
  ? Number(process.env.EVAL_MIN_EXACT_ROW_ACCURACY)
  : DEFAULT_GATE.minExactRowAccuracy
const thresholds = { minExactRowAccuracy: minExact, minAutoApprovePrecision: DEFAULT_GATE.minAutoApprovePrecision }

function pct(x) { return x === null || x === undefined ? '   n/a' : `${(x * 100).toFixed(1).padStart(5)}%` }
function ms(x) { return x === null || x === undefined ? '  n/a' : `${Math.round(x)}ms` }

if (!existsSync(goldensDir)) {
  console.error(`[eval] goldens directory not found: ${goldensDir}`)
  console.error('[eval] acceptance needs >=30 REAL (anonymised) labelled bills. Add one <id>.json per bill under that dir (see scripts/eval.mjs header for the format). NEVER fabricate them.')
  process.exit(1)
}

const files = readdirSync(goldensDir).filter((f) => f.endsWith('.json')).sort()
if (files.length === 0) {
  console.error(`[eval] no golden .json files in ${goldensDir}`)
  console.error('[eval] acceptance cannot pass on an empty set — add >=30 real labelled bills (never fabricated).')
  process.exit(1)
}

const samples = []
const bad = []
for (const f of files) {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(goldensDir, f), 'utf8'))
  } catch (e) {
    bad.push(`${f}: not valid JSON (${e instanceof Error ? e.message : String(e)})`)
    continue
  }
  if (!raw || typeof raw !== 'object' || !raw.expected || !raw.actual) {
    bad.push(`${f}: must have both an "expected" and an "actual" object`)
    continue
  }
  samples.push({ id: String(raw.id ?? f.replace(/\.json$/, '')), expected: raw.expected, actual: raw.actual })
}

if (bad.length > 0) {
  console.error(`[eval] ${bad.length} malformed golden file(s):`)
  for (const b of bad) console.error(`  - ${b}`)
  process.exit(1)
}

const metrics = scoreEval(samples)

console.log(`\n[eval] scored ${metrics.count} golden sample(s) from ${goldensDir}\n`)
console.log('  Per-field accuracy (only where the human labelled a value):')
for (const field of [...CORE_EVAL_FIELDS, 'round_off']) {
  const fs2 = metrics.perField[field]
  if (!fs2 || fs2.scored === 0) { console.log(`    ${field.padEnd(16)} ${pct(null)}  (0 labelled)`) ; continue }
  console.log(`    ${field.padEnd(16)} ${pct(fs2.accuracy)}  (${fs2.matched}/${fs2.scored})`)
}
console.log('')
console.log(`  Exact-row accuracy        ${pct(metrics.exactRowAccuracy)}  (${metrics.exactRowMatched}/${metrics.exactRowScored} labelled)`)
console.log(`  Auto-approved             ${pct(metrics.autoApproveRate)}  (${metrics.autoApprovedCount}/${metrics.count})`)
console.log(`  Auto-approve precision    ${pct(metrics.autoApprovePrecision)}  (wrong: ${metrics.autoApproveWrongCount}, required: 0)`)
console.log(`  Latency p50 / p95         ${ms(metrics.latency.p50)} / ${ms(metrics.latency.p95)}  (n=${metrics.latency.count})`)
console.log('')

if (samples.length < 30) {
  console.warn(`[eval] WARNING: only ${samples.length} golden sample(s); the acceptance bar needs >=30 REAL labelled bills.`)
}

const gate = evaluateGate(metrics, thresholds)
if (!gate.pass) {
  console.error(`[eval] ACCEPTANCE GATE FAILED (${samples.length} sample(s) scored):`)
  for (const failure of gate.failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`[eval] acceptance gate PASSED on ${samples.length} sample(s).`)
