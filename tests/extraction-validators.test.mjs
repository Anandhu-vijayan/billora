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

test('an empty / not-applicable tax rate is skipped, never flagged invalid-rate', () => {
  // Intra-state supply: vision returns "" for the IGST rate. Absence of a
  // printed rate is not a financial error, so it must not route to review.
  const withEmptyIgst = taxRates.checkPrintedTaxRates({
    taxableValue: 253.41,
    taxRates: { cgst: '5.00', sgst: '5.00', igst: '  ' },
    taxAmounts: { cgst: 6.33, sgst: 6.33, igst: 0 },
  })
  assert.deepEqual(withEmptyIgst.map((item) => item.head), ['cgst', 'sgst'])
  assert.deepEqual(withEmptyIgst.map((item) => item.status), ['match', 'match'])
})

test('combined item GST rate (5%) reconciles with per-component amounts (2.5% each)', () => {
  // Real hospital invoice (Devamatha): the item line prints the TOTAL GST rate
  // (5%) which splits equally into CGST + SGST (2.5% each). The model reads 5%
  // into both per-component rate fields, but the AMOUNTS are correct. The
  // amounts, GSTIN and total all reconcile, so this must auto-approve.
  const result = ledger.evaluateLedger({
    invoice_date: '15/10/2026',
    invoice_number: '24425',
    vendor_name: 'DEVAMATHA HOSPITAL',
    supplier_gstin: '32AESPK2276E1ZI',
    taxable_value: 253.41,
    cgst_amount: 6.33,
    sgst_amount: 6.33,
    igst_amount: 0,
    total_amount: 266,
    cgst_rate_percent: '5.00',
    sgst_rate_percent: '5.00',
    igst_rate_percent: '',
    total_amount_in_words: 'RUPEES TWO HUNDRED SIXTY SIX ONLY',
  }, { minConfidence: 0.8, now: NOW })
  assert.equal(result.review, 'approved')
  assert.ok(!result.reasons.some((r) => r.startsWith('tax-rate-')))
})

test('a critical-field conflict only vetoes auto-approval between two CREDIBLE readings', () => {
  const a = { invoice_number: '24425' }
  const b = { invoice_number: '24426' }
  // Both sources credible -> genuine contradiction -> conflict recorded (review).
  assert.deepEqual(ledger.detectCandidateConflicts(a, b, { a: true, b: true }), ['invoice_number'])
  // One side disqualified (zero-confidence OCR misread) -> noise, never a veto.
  assert.deepEqual(ledger.detectCandidateConflicts(a, b, { a: false, b: true }), [])
  assert.deepEqual(ledger.detectCandidateConflicts(a, b, { a: true, b: false }), [])
  // No credibility info supplied -> legacy two-candidate comparison still flags.
  assert.deepEqual(ledger.detectCandidateConflicts(a, b), ['invoice_number'])
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

test('amount-in-words tolerates "Indian Rupee only" and paise-before-word format', () => {
  assert.equal(
    words.parseIndianAmountWords('Five Lakh Seventy Five Thousand Three Hundred and Fifty One Indian Rupee only.'),
    57535100n,
  )
  assert.equal(words.parseIndianAmountWords('One Thousand Rupees and Fifty Paise Only'), 100050n)
  assert.equal(words.parseIndianAmountWords('Rupees Fifty One and Twenty Nine Paise Only'), 5129n)
  assert.equal(words.parseIndianAmountWords('INR One Thousand and Paise Fifty Only'), 100050n)
})

test('misread numeric total is repaired from the amount-in-words when the words tie to the components', () => {
  // Real case from the 21 Oct 2026 log: Akkara Gold, total misread as 558502.93.
  const cand = {
    ...BASE,
    invoice_number: 'AG/1839/26-27',
    vendor_name: 'Akkara gold',
    supplier_gstin: '27AAPFU0939F1ZV',
    taxable_value: 558592.93,
    cgst_amount: 8378.89,
    sgst_amount: 8378.89,
    igst_amount: 0,
    total_amount: 558502.93,
    round_off: 0.29,
    total_amount_in_words: 'Five Lakh Seventy Five Thousand Three Hundred and Fifty One Indian Rupee only.',
  }
  const out = ledger.evaluateLedger(cand, { minConfidence: 0.8, now: NOW })
  assert.equal(out.row.total_amount, 575351)
  assert.deepEqual(out.repairs, ['total-from-words'])
  assert.ok(!out.reasons.some((r) => r.startsWith('total-mismatch')))
})

test('total is NOT repaired when the words do not tie to the components either', () => {
  const cand = { ...BASE, total_amount: 9999, total_amount_in_words: 'Rupees Five Thousand Only' }
  const out = ledger.evaluateLedger(cand, { minConfidence: 0.8, now: NOW })
  assert.equal(out.row.total_amount, 9999)
  assert.ok(out.reasons.some((r) => r.startsWith('total-mismatch')))
})

test('buyer GSTIN taken as supplier is never auto-approved; correct supplier is', () => {
  const base = {
    invoice_date: '25-09-2026', invoice_number: 'AG/1839/26-27', vendor_name: 'Akkara gold',
    recipient_gstin: '32ACXPV2326B1ZL', taxable_value: 558592.93, cgst_amount: 8378.89,
    sgst_amount: 8378.89, igst_amount: 0, total_amount: 575351, round_off: 0.29,
  }
  const bad = ledger.evaluateLedger({ ...base, supplier_gstin: '32ACXPV2326B1ZL' }, { minConfidence: 0.8, now: NOW })
  assert.equal(bad.review, 'needs_review')
  assert.ok(bad.reasons.includes('supplier-equals-recipient'))
  const good = ledger.evaluateLedger({ ...base, supplier_gstin: '32ADRPJ8730C1ZN' }, { minConfidence: 0.8, now: NOW })
  assert.equal(good.review, 'approved')
})

test('GSTIN printed with a space after the state code is still found', async () => {
  const gstin = await importTs('lib/ocr/gstin.ts')
  const hits = gstin.findAllGstins('GSTIN: 32 ADRPJ8730C1ZN\nGSTIN 32ACXPV2326B1ZL')
  assert.deepEqual(hits.map((h) => h.value), ['32ADRPJ8730C1ZN', '32ACXPV2326B1ZL'])
})
