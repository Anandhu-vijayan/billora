// §Acceptance — the eval harness. These tests verify the SCORER'S ARITHMETIC and
// the RUNNER'S PLUMBING on authored input pairs. They are NOT a claim of production
// extraction accuracy — that needs >=30 REAL (anonymised) labelled bills the harness
// cannot fabricate. What is proven here is exactly the machinery the spec demands:
//   * per-field accuracy counts only where a human labelled a value;
//   * AUTO-APPROVE PRECISION is absolute: an approved row that disagrees with the
//     label on any core field is a `wrong` and fails the gate (precision > recall);
//   * amounts compare in minor units, dates in digits, text is trimmed/lower-cased;
//   * p50/p95 latency;
//   * the `npm run eval` runner FAILS LOUD (exit non-zero) on a missing/empty golden
//     set rather than reporting a silent green.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importTs } from '../scripts/_ts-import.mjs'

const { scoreEval, evaluateGate } = await importTs('lib/eval/score.ts')

const GOLD = {
  invoice_date: '2026-09-05', invoice_number: 'INV-42', vendor_name: 'Acme Traders',
  supplier_gstin: '27AAPFU0939F1ZV', taxable_value: 1000, cgst_amount: 90,
  sgst_amount: 90, igst_amount: 0, total_amount: 1180,
}
const APPROVED = { review: 'approved', latencyMs: 100 }

// ---- scoring ---------------------------------------------------------------
test('acceptance scorer: a perfect approved match is 100% precision, 0 wrong', () => {
  const m = scoreEval([{ id: 'a', expected: GOLD, actual: { ...GOLD, ...APPROVED } }])
  assert.equal(m.exactRowAccuracy, 1)
  assert.equal(m.autoApprovedCount, 1)
  assert.equal(m.autoApproveWrongCount, 0)
  assert.equal(m.autoApprovePrecision, 1)
  assert.deepEqual(evaluateGate(m).failures, [], 'a clean run passes the gate')
})

test('acceptance scorer: an approved row that disagrees is a WRONG and drops precision', () => {
  const wrongActual = { ...GOLD, total_amount: 1181, review: 'approved', latencyMs: 100 }
  const m = scoreEval([{ id: 'a', expected: GOLD, actual: wrongActual }])
  assert.equal(m.autoApproveWrongCount, 1, 'the money disagreement is caught')
  assert.equal(m.autoApprovePrecision, 0)
  assert.equal(m.perField.total_amount.accuracy, 0)
  assert.ok(evaluateGate(m).pass === false, 'the gate FAILS on any auto-approve disagreement')
})

test('acceptance scorer: needs_review rows are excluded from precision but count toward accuracy', () => {
  const m = scoreEval([
    { id: 'ok', expected: GOLD, actual: { ...GOLD, review: 'approved', latencyMs: 50 } },
    // A flagged row that happens to be wrong is not an auto-approve violation.
    { id: 'flag', expected: GOLD, actual: { ...GOLD, vendor_name: 'Garbage', review: 'needs_review', reasons: ['vendor-name-placeholder'], latencyMs: 60 } },
  ])
  assert.equal(m.autoApprovedCount, 1)
  assert.equal(m.autoApproveWrongCount, 0, 'only the approved row can breach precision')
  assert.equal(m.autoApprovePrecision, 1)
  assert.equal(m.perField.vendor_name.accuracy, 0.5, 'the wrong vendor is still an accuracy miss')
  assert.equal(m.exactRowMatched, 1, 'only the first row matched exactly')
})

test('acceptance scorer: amounts compare in minor units (format drift is not a miss)', () => {
  const m = scoreEval([{
    id: 'a',
    expected: { ...GOLD, total_amount: 1180 },
    actual: { ...GOLD, total_amount: '1,180.00', review: 'needs_review', latencyMs: 10 },
  }])
  assert.equal(m.perField.total_amount.accuracy, 1, '"1,180.00" equals 1180 to the paisa')
  // A genuine cent difference IS a miss.
  const m2 = scoreEval([{ id: 'b', expected: { ...GOLD, total_amount: 1180 }, actual: { ...GOLD, total_amount: 1180.01, review: 'needs_review' } }])
  assert.equal(m2.perField.total_amount.accuracy, 0)
})

test('acceptance scorer: zero is a value, an absent label is NOT scored', () => {
  const m = scoreEval([{
    id: 'a',
    expected: { invoice_number: 'INV-1', igst_amount: 0 },
    // round_off is unlabelled here -> must not count as a hit or a miss.
    actual: { invoice_number: 'INV-1', igst_amount: 0, review: 'approved', latencyMs: 5 },
  }])
  assert.equal(m.perField.igst_amount.scored, 1)
  assert.equal(m.perField.igst_amount.accuracy, 1, 'a real 0 matched a real 0')
  assert.equal(m.perField.round_off.scored, 0, 'no ground truth => not scored')
  assert.equal(m.perField.round_off.accuracy, null)
})

test('acceptance scorer: dates compare in digits, text is trimmed + case-folded', () => {
  const m = scoreEval([{
    id: 'a',
    expected: { invoice_date: '2026-09-05', vendor_name: 'Acme Traders', supplier_gstin: '27aapfu0939f1zv' },
    actual: { invoice_date: '20260905', vendor_name: '  acme   traders ', supplier_gstin: '27AAPFU0939F1ZV', review: 'approved', latencyMs: 5 },
  }])
  assert.equal(m.exactRowMatched, 1, 'normalisation makes these agree')
})

test('acceptance scorer: p50 / p95 latency are nearest-rank over the samples', () => {
  const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((latencyMs, i) => ({
    id: `s${i}`, expected: GOLD, actual: { ...GOLD, review: 'needs_review', latencyMs },
  }))
  const m = scoreEval(samples)
  assert.equal(m.latency.count, 10)
  assert.equal(m.latency.p50, 500)
  assert.equal(m.latency.p95, 1000)
})

// ---- gate ------------------------------------------------------------------
test('acceptance gate: an empty set can never pass (no silent green)', () => {
  const m = scoreEval([])
  const gate = evaluateGate(m)
  assert.equal(gate.pass, false)
  assert.ok(gate.failures.some((f) => /empty|no labelled/i.test(f)))
})

// ---- runner plumbing (fails loud without real bills) -----------------------
test('acceptance runner: exits NON-ZERO when the goldens dir is missing', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'billora-eval-')), 'nope')
  const r = spawnSync(process.execPath, ['scripts/eval.mjs'], {
    encoding: 'utf8', env: { ...process.env, EVAL_GOLDENS_DIR: missing },
  })
  assert.equal(r.status, 1, 'a missing golden set must fail, not fake a pass')
  assert.match(r.stderr, /REAL|fabricate|not found/i)
})

test('acceptance runner: scores an authored pair and passes the gate plumbing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billora-eval-'))
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'a', expected: GOLD, actual: { ...GOLD, review: 'approved', latencyMs: 120 } }))
    const r = spawnSync(process.execPath, ['scripts/eval.mjs'], {
      encoding: 'utf8', env: { ...process.env, EVAL_GOLDENS_DIR: dir },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Auto-approve precision/)
    assert.match(r.stdout, /acceptance gate PASSED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
