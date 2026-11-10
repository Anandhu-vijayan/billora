import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importTs } from '../../scripts/_ts-import.mjs'

const ledger = await importTs('lib/ocr/ledger.ts')
const now = new Date('2026-11-10T00:00:00Z')

// Test fixtures deliberately use distinct, checksum-valid seller and buyer
// GSTINs. Production validation must continue rejecting a seller==buyer read.
const base = {
  invoice_date: '2026-11-09',
  invoice_number: 'REGRESSION',
  vendor_name: 'Verified Supplier Pvt Ltd',
  supplier_gstin: '32ADRPJ8730C1ZN',
  recipient_gstin: '32ACXPV2326B1ZL',
  taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0, total_amount: 1180,
  confidence: {
    invoice_date: 0.6, invoice_number: 0.6, vendor_name: 0.6, supplier_gstin: 0.6,
    taxable_value: 0.6, cgst_amount: 0.6, sgst_amount: 0.6, igst_amount: 0.6, total_amount: 0.6,
  },
}

const correctedRun = [
  ['INV-2026-11-203', { taxable_value: 4850, cgst_amount: 291, sgst_amount: 291, igst_amount: 0, total_amount: 5432 }],
  ['INV-2026-11-202', { taxable_value: 94000, cgst_amount: 8460, sgst_amount: 8460, igst_amount: 0, total_amount: 110920 }],
  ['INV-2026-10-103', { taxable_value: 25000, cgst_amount: 3125, sgst_amount: 3125, igst_amount: 0, total_amount: 31250,
    total_amount_in_words: '25000.00 + 3125.00 + 3125.00 = 31250.00', amount_words_equation_not_evidence: true }],
  ['INV-2026-10-101', { taxable_value: 18000, cgst_amount: 1620, sgst_amount: 1620, igst_amount: 0, total_amount: 21240 }],
  ['INV-2026-10-102', { taxable_value: 9000, cgst_amount: 225, sgst_amount: 225, igst_amount: 0, total_amount: 9450,
    total_amount_in_words: 'Nine Thousand Four Hundred Fifty Only', total_amount_in_words_source: 'ai' }],
]

test('corrected OCR values approve with distinct seller/buyer GSTINs even at 0.6 model confidence', () => {
  for (const [invoice, amounts] of correctedRun) {
    const result = ledger.evaluateLedger({ ...base, invoice_number: invoice, ...amounts }, { minConfidence: 0.8, now })
    if (invoice === 'INV-2026-10-103') {
      assert.equal(result.review, 'needs_review', invoice + ' equation-like text is not amount-in-words evidence')
      assert.ok(result.reasons.includes('amount-words-equation-not-evidence'))
    } else {
      assert.equal(result.review, 'approved', invoice + ' is complete, reconciles, and has no hard integrity failures')
      assert.ok(!result.reasons.some((reason) => reason.startsWith('low-confidence')), invoice + ' 0.6 self-confidence is not a veto')
    }
  }
})

test('a local CGST decimal-loss magnitude outlier remains review-required and is never divided by 100', () => {
  const result = ledger.evaluateLedger({
    ...base,
    invoice_number: 'INV-2026-11-201',
    taxable_value: 12500,
    cgst_amount: 83250, // OCR read 832.50 as 83250; do not guess a decimal repair.
    sgst_amount: 832.5,
    igst_amount: 0,
    total_amount: 14165,
  }, { minConfidence: 0.8, now })
  assert.equal(result.row.cgst_amount, 83250)
  assert.equal(result.review, 'needs_review')
  assert.ok(result.reasons.includes('local-money-magnitude-suspect'))
  assert.ok(result.reasons.some((reason) => reason.startsWith('total-mismatch')))
  assert.deepEqual(result.repairs, [])
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

test('seller equal to printed recipient remains a hard review failure for production data', () => {
  const result = ledger.evaluateLedger({
    ...base,
    recipient_gstin: '32ADRPJ8730C1ZN',
  }, { minConfidence: 0.8, now })
  assert.equal(result.review, 'needs_review')
  assert.ok(result.reasons.includes('supplier-equals-recipient'))
})
