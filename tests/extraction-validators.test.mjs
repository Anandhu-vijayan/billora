import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importTs } from '../scripts/_ts-import.mjs'

const money = await importTs('lib/ocr/validators/money.ts')
const words = await importTs('lib/ocr/validators/amount-words.ts')
const taxRates = await importTs('lib/ocr/validators/tax-rates.ts')
const textParser = await importTs('lib/ocr/text-parser.ts')
const ledger = await importTs('lib/ocr/ledger.ts')

const NOW = new Date('2026-10-16T00:00:00Z')
const BASE = {
  invoice_date: '05/09/2026',
  invoice_number: 'INV-42',
  vendor_name: 'Acme Traders Pvt Ltd',
  supplier_gstin: '27AAPFU0939F1ZV',
  taxable_value: 1000,
  cgst_amount: 90,
  sgst_amount: 90,
  igst_amount: 0,
  total_amount: 1180,
}

test('money validator uses integer paise and rejects malformed values', () => {
  assert.equal(money.moneyToMinorUnits('₹1,234.56'), 123456n)
  assert.equal(money.moneyToMinorUnits(0.1), 10n)
  assert.equal(money.moneyToMinorUnits('1.005'), 101n)
  assert.equal(money.moneyToMinorUnits('not money'), null)
  assert.equal(money.minorUnitsToString(-123n), '-1.23')
})

test('ledger arithmetic is exact for decimal fractions', () => {
  const result = ledger.evaluateLedger({
    ...BASE,
    taxable_value: 0.1,
    cgst_amount: 0.1,
    sgst_amount: 0.1,
    igst_amount: 0,
    total_amount: 0.3,
  }, { minConfidence: 0.8, now: NOW })
  assert.equal(result.review, 'approved')
  assert.equal(result.row.total_amount, 0.3)
})

test('amount-in-words parser supports Indian lakh/crore and paise values', () => {
  assert.equal(words.parseIndianAmountWords('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only'), 12345600n)
  assert.equal(words.parseIndianAmountWords('INR One Thousand and Paise Fifty Only'), 100050n)
  assert.equal(words.parseIndianAmountWords('Rupees One Crore Only'), 1_000_000_000n)
  assert.equal(words.parseIndianAmountWords('Rupees One Banana Only'), null)
  assert.equal(words.amountWordsMatchNumeric('Rupees One Thousand One Hundred Eighty Only', 1180), true)
  assert.equal(words.amountWordsMatchNumeric('Rupees One Thousand Only', 1180), false)
})

test('tax rates corroborate extracted amounts but never synthesize missing values', () => {
  assert.equal(taxRates.expectedTaxMinorUnits(1000, 9), 9000n)
  const good = taxRates.checkPrintedTaxRates({
    taxableValue: 1000,
    taxRates: { cgst: 9, sgst: 9 },
    taxAmounts: { cgst: 90, sgst: 90 },
  })
  assert.deepEqual(good.map((item) => item.status), ['match', 'match'])
  const missing = taxRates.checkPrintedTaxRates({
    taxableValue: 1000,
    taxRates: { cgst: 9 },
    taxAmounts: {},
  })
  assert.equal(missing[0].status, 'missing-amount')
})

test('local parser separates printed GST rates from their tax amounts and reads amount words', () => {
  const candidate = textParser.parseInvoiceText([
    'TAX INVOICE',
    'ACME TRADERS PVT LTD',
    'GSTIN: 27AAPFU0939F1ZV',
    'Invoice No: INV-2026-0042',
    'Invoice Date: 05/09/2026',
    'Taxable Value: 1,000.00',
    'CGST @ 9%: 90.00',
    'SGST Rate: 9% 90.00',
    'IGST: 0.00',
    'Grand Total: 1,180.00',
    'Amount in Words: Rupees One Thousand One Hundred Eighty Only',
  ].join('\n'))
  assert.equal(candidate.cgst_rate_percent, 9)
  assert.equal(candidate.sgst_rate_percent, 9)
  assert.equal(candidate.cgst_amount, 90)
  assert.equal(candidate.sgst_amount, 90)
  assert.equal(candidate.total_amount_in_words, 'Rupees One Thousand One Hundred Eighty Only')
  assert.equal(ledger.evaluateLedger(candidate, { minConfidence: 0.8, now: NOW }).review, 'approved')
})

test('rate or amount-words contradictions route to review and never auto-correct amounts', () => {
  const result = ledger.evaluateLedger({
    ...BASE,
    cgst_rate_percent: 9,
    sgst_rate_percent: 9,
    cgst_amount: 80,
    total_amount_in_words: 'Rupees One Thousand Only',
  }, { minConfidence: 0.8, now: NOW })
  assert.equal(result.review, 'needs_review')
  assert.ok(result.reasons.includes('tax-rate-mismatch:cgst'))
  assert.ok(result.reasons.includes('amount-words-total-mismatch'))
  assert.equal(result.row.cgst_amount, 80)
  assert.match(ledger.retryHintFor(result.reasons), /printed tax percentage/)
  assert.match(ledger.retryHintFor(result.reasons), /total in words disagrees/)
})
