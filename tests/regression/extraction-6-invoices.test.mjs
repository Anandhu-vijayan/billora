import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importTs } from '../../scripts/_ts-import.mjs'

const ledger = await importTs('lib/ocr/ledger.ts')
const now = new Date('2026-11-10T00:00:00Z')
const base = {
  invoice_date: '2026-11-09',
  invoice_number: 'REGRESSION',
  vendor_name: 'Verified Supplier Pvt Ltd',
  supplier_gstin: '27AAPFU0939F1ZV',
  taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0, total_amount: 1180,
}

const cases = [
  ['INV-2026-10-103', { taxable_value: 2500, cgst_amount: 3125, sgst_amount: 3125, igst_amount: 0, total_amount: 2500000 }],
  ['INV-2026-10-101', { taxable_value: 1800, cgst_amount: 1620, sgst_amount: 1620, igst_amount: 0, total_amount: 1800000 }],
  ['INV-2026-11-201', { taxable_value: 12500, cgst_amount: 832550, sgst_amount: 832.50, igst_amount: 0, total_amount: 1250000 }],
  ['INV-2026-11-202', { taxable_value: 9400, cgst_amount: 8460, sgst_amount: 8460, igst_amount: 0, total_amount: 9400000 }],
  ['INV-2026-11-203', { taxable_value: 4850, cgst_amount: 291, sgst_amount: 291, igst_amount: 0, total_amount: 485000 }],
  ['INV-2026-10-102', { taxable_value: 9000, cgst_amount: 225, sgst_amount: 225, igst_amount: 0, total_amount: 900000 }],
]

test('all six reported decimal/magnitude failures remain needs_review and are never repaired', () => {
  for (const [invoice, amounts] of cases) {
    const result = ledger.evaluateLedger({ ...base, invoice_number: invoice, ...amounts }, { minConfidence: 0.8, now })
    assert.equal(result.review, 'needs_review', invoice + ' must not auto-approve')
    assert.deepEqual(result.repairs, [], invoice + ' must not be silently repaired')
    assert.ok(result.reasons.length > 0, invoice + ' must retain a review reason')
  }
})

test('equation-like amount-in-words never repairs a printed total', () => {
  const result = ledger.evaluateLedger({
    ...base,
    total_amount: 900000,
    total_amount_in_words: '9000.00 + 225.00 + 225.00 = 9450.00',
    total_amount_in_words_source: 'local-ocr',
  }, { minConfidence: 0.8, now })
  assert.equal(result.row.total_amount, 900000)
  assert.deepEqual(result.repairs, [])
  assert.ok(result.reasons.includes('amount-words-equation-not-evidence'))
  assert.equal(result.review, 'needs_review')
})
