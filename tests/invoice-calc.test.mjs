import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importTs } from '../scripts/_ts-import.mjs'

const money = await importTs('lib/ocr/validators/money.ts')
const reconcile = await importTs('lib/ocr/calc/reconcile.ts')
const gstin = await importTs('lib/ocr/gstin.ts')
const ledger = await importTs('lib/ocr/ledger.ts')
const textParser = await importTs('lib/ocr/text-parser.ts')

const NOW = new Date('2026-10-19T00:00:00Z')
const OPTS = { minConfidence: 0.8, now: NOW }
const R = (n) => money.moneyToMinorUnits(n)

// ---------------------------------------------------------------------------
// 1. Monetary parsing (Indian formats, currency tokens, safety)
// ---------------------------------------------------------------------------
test('money parses Indian lakh-comma grouping and currency tokens into paise', () => {
  assert.equal(R('1,18,200.00'), 11820000n)      // Indian grouping
  assert.equal(R('₹5,000'), 500000n)             // rupee symbol
  assert.equal(R('Rs. 1,18,200'), 11820000n)     // Rs. prefix
  assert.equal(R('INR 250'), 25000n)             // INR prefix
  assert.equal(R('1,18,200/-'), 11820000n)       // receipt filler
})

test('money rounds paise half-up beyond two decimals and preserves zero', () => {
  assert.equal(R('1.005'), 101n)                 // half-up
  assert.equal(R('1.004'), 100n)                 // half-down
  assert.equal(R(0), 0n)                          // legitimate zero preserved
  assert.equal(R('0.00'), 0n)
})

test('money rejects NaN / Infinity / malformed and unsafe values', () => {
  assert.equal(R(Number.NaN), null)
  assert.equal(R(Number.POSITIVE_INFINITY), null)
  assert.equal(R('not money'), null)
  assert.equal(R('1.2.3'), null)
  assert.equal(R(''), null)
  assert.equal(R(null), null)
  assert.equal(R(undefined), null)
})

test('money keeps a negative sign for round-off and credit notes', () => {
  assert.equal(R('-500'), -50000n)
  assert.equal(money.minorUnitsToString(-123n), '-1.23')
})

// ---------------------------------------------------------------------------
// 2. The shared reconciliation engine
// ---------------------------------------------------------------------------
test('reconcile: canonical reading is tried first and folds in no optional component', () => {
  const res = reconcile.reconcileInvoiceTotal(
    { taxable: R(1000), cgst: R(90), sgst: R(90), igst: R(0), printedTotal: R(1180) },
    101n,
  )
  assert.equal(res.status, 'reconciles')
  assert.deepEqual(res.applied, { cess: false, shipping: false, discount: false, deduction: false, roundOff: false })
  assert.deepEqual(res.reasons, [])
})

test('reconcile: inter-state IGST invoice ties out', () => {
  const res = reconcile.reconcileInvoiceTotal(
    { taxable: R(1000), cgst: R(0), sgst: R(0), igst: R(180), printedTotal: R(1180) },
    101n,
  )
  assert.equal(res.status, 'reconciles')
})

test('reconcile: cess and round-off are folded in when printed', () => {
  const res = reconcile.reconcileInvoiceTotal(
    { taxable: R(1000), cgst: R(90), sgst: R(90), igst: R(0), cess: R(50), roundOff: R(1.30), printedTotal: R(1231.30) },
    101n,
  )
  assert.equal(res.status, 'reconciles')
  assert.equal(res.applied.cess, true)
  assert.equal(res.applied.roundOff, true)
})

test('reconcile: a discount against a gross base reconciles (Zetran shape)', () => {
  // 29,280 gross − 2,800 discount + 5,270.40 tax (on gross) + 500 shipping = 32,250.40
  const res = reconcile.reconcileInvoiceTotal({
    taxable: R(29280), cgst: R(2635.20), sgst: R(2635.20), igst: R(0),
    discount: R(2800), shipping: R(500), printedTotal: R(32250.40),
  }, 101n)
  assert.equal(res.status, 'reconciles')
  assert.equal(res.applied.discount, true)
  assert.equal(res.applied.shipping, true)
})

test('reconcile: does NOT double-count a discount already netted into the base', () => {
  // Here taxable 26,480 is ALREADY 29,280 − 2,800; subtracting the discount again
  // would give 29,450.40 and fail. The engine must pick the taxable-net reading
  // (26,480 + 2,635.20 + 2,635.20 + 500 = 32,250.40).
  const res = reconcile.reconcileInvoiceTotal({
    taxable: R(26480), cgst: R(2635.20), sgst: R(2635.20), igst: R(0),
    discount: R(2800), shipping: R(500), printedTotal: R(32250.40),
  }, 101n)
  assert.equal(res.status, 'reconciles')
  assert.equal(res.applied.shipping, true)
  // The discount is NOT subtracted again — proof of double-count prevention.
  assert.equal(res.applied.discount, false)
})

test('reconcile: never folds an optional component the total does not need', () => {
  // A plain invoice that ties out canonically must NOT "use" a stray discount
  // even though subtracting it would also fall within the rupee tolerance — the
  // canonical reading is always tried first, so this can never be more
  // permissive than the old fixed equation.
  const res = reconcile.reconcileInvoiceTotal(
    { taxable: R(1000), cgst: R(90), sgst: R(90), igst: R(0), discount: R(0.50), printedTotal: R(1180) },
    101n,
  )
  assert.equal(res.status, 'reconciles')
  assert.equal(res.applied.discount, false)
})

test('reconcile: a material mismatch is reported, never silently forgiven', () => {
  const res = reconcile.reconcileInvoiceTotal(
    { taxable: R(1000), cgst: R(90), sgst: R(90), igst: R(0), printedTotal: R(1200) },
    101n,
  )
  assert.equal(res.status, 'mismatch')
  assert.deepEqual(res.reasons, ['total-mismatch:1180.00!=1200.00'])
})

test('reconcile: missing total or missing base is unverifiable, not guessed', () => {
  const noTotal = reconcile.reconcileInvoiceTotal(
    { taxable: R(1000), cgst: R(90), sgst: R(90), igst: R(0), printedTotal: null }, 101n)
  assert.equal(noTotal.status, 'unverifiable')
  assert.deepEqual(noTotal.reasons, ['total-missing'])

  const noBase = reconcile.reconcileInvoiceTotal(
    { taxable: null, cgst: R(90), sgst: R(90), igst: R(0), printedTotal: R(1180) }, 101n)
  assert.equal(noBase.status, 'unverifiable')
  assert.deepEqual(noBase.reasons, ['taxable-base-missing'])
})

// ---------------------------------------------------------------------------
// 3. GSTIN validation (structure / state code / checksum, preserve raw)
// ---------------------------------------------------------------------------
test('gstin: valid shape + state code + checksum passes; each failure is distinct', () => {
  assert.equal(gstin.gstinFullyValid('27AAPFU0939F1ZV'), true)
  assert.equal(gstin.gstinStateCodeValid('42AAPFU0939F1ZV'), false)   // unknown state code
  // Tampering the check digit keeps shape/state valid but breaks the checksum.
  assert.equal(gstin.gstinStateCodeValid('27AAPFU0939F1ZW'), true)
  assert.equal(gstin.gstinChecksumOk('27AAPFU0939F1ZW'), false)
})

test('gstin: a digits-only dummy is shape-invalid and its raw value is preserved', () => {
  const result = ledger.evaluateLedger({
    invoice_date: '12-May-2021', invoice_number: 'INV-000125',
    vendor_name: 'Zetran Corporation', supplier_gstin: '123456789321456',
    taxable_value: 29280, cgst_amount: 2635.20, sgst_amount: 2635.20, igst_amount: 0,
    discount_amount: 2800, shipping_amount: 500, total_amount: 32250.40,
  }, OPTS)
  assert.equal(result.review, 'needs_review')
  assert.ok(result.reasons.includes('gstin-invalid'))
  // The raw printed GSTIN is never silently corrected or dropped.
  assert.equal(result.row.supplier_gstin, '123456789321456')
})

// ---------------------------------------------------------------------------
// 4. Ledger integration: the engine is the single source of the total decision
// ---------------------------------------------------------------------------
test('ledger: canonical invoice still auto-approves (no regression)', () => {
  const result = ledger.evaluateLedger({
    invoice_date: '05/09/2026', invoice_number: 'INV-42', vendor_name: 'Acme Traders Pvt Ltd',
    supplier_gstin: '27AAPFU0939F1ZV', taxable_value: 1000, cgst_amount: 90,
    sgst_amount: 90, igst_amount: 0, total_amount: 1180,
  }, OPTS)
  assert.equal(result.review, 'approved')
  assert.ok(!result.reasons.some((r) => r.startsWith('total-mismatch')))
})

test('ledger: a discounted/freighted invoice no longer false-fails the total', () => {
  const result = ledger.evaluateLedger({
    invoice_date: '05/09/2026', invoice_number: 'INV-77', vendor_name: 'Acme Traders Pvt Ltd',
    supplier_gstin: '27AAPFU0939F1ZV', taxable_value: 29280, cgst_amount: 2635.20,
    sgst_amount: 2635.20, igst_amount: 0, discount_amount: 2800, shipping_amount: 500,
    total_amount: 32250.40,
  }, OPTS)
  assert.equal(result.review, 'approved')
  assert.ok(!result.reasons.some((r) => r.startsWith('total-mismatch')))
})

test('ledger: reconciliation uses the printed total, never rewrites it', () => {
  // Same discounted shape but the printed total is off by a material amount: the
  // row must stay needs_review and keep the extracted total exactly as printed.
  const result = ledger.evaluateLedger({
    invoice_date: '05/09/2026', invoice_number: 'INV-78', vendor_name: 'Acme Traders Pvt Ltd',
    supplier_gstin: '27AAPFU0939F1ZV', taxable_value: 29280, cgst_amount: 2635.20,
    sgst_amount: 2635.20, igst_amount: 0, discount_amount: 2800, shipping_amount: 500,
    total_amount: 40000,
  }, OPTS)
  assert.equal(result.review, 'needs_review')
  assert.ok(result.reasons.some((r) => r.startsWith('total-mismatch')))
  assert.equal(result.row.total_amount, 40000)
})

test('ledger: Zetran lands in review only for the invalid GSTIN, not the total', () => {
  // The exact bug from the 19 Oct log: a spurious `total-mismatch` alongside the
  // genuine `gstin-invalid`. With the discount + shipping modelled, the total
  // reconciles and the ONLY remaining reason is the invalid GSTIN.
  const result = ledger.evaluateLedger({
    invoice_date: '12-May-2021', invoice_number: 'INV-000125', vendor_name: 'Zetran Corporation',
    supplier_gstin: '123456789321456', taxable_value: 29280, cgst_amount: 2635.20,
    sgst_amount: 2635.20, igst_amount: 0, discount_amount: 2800, shipping_amount: 500,
    total_amount: 32250.40,
  }, OPTS)
  assert.ok(!result.reasons.some((r) => r.startsWith('total-mismatch')))
  assert.ok(result.reasons.includes('gstin-invalid'))
  assert.equal(result.review, 'needs_review')
})

test('ledger: mergeCandidates preserves provenance of structural components', () => {
  const merged = ledger.mergeCandidates(
    { discount_amount: 2800, shipping_amount: 500, taxable_value: 29280 },
    { discount_amount: 999, shipping_amount: 999, round_off: 5 },
  )
  assert.equal(merged.discount_amount, 2800)   // local (primary) wins
  assert.equal(merged.shipping_amount, 500)
  assert.equal(merged.round_off, 5)            // fallback fills a gap
})

// ---------------------------------------------------------------------------
// 5. Extraction: invoice-number disambiguation + component capture
// ---------------------------------------------------------------------------
test('text-parser: a PO Bill No is never mistaken for the invoice number', () => {
  const candidate = textParser.parseInvoiceText([
    'TAX INVOICE', 'ZETRAN CORPORATION', 'GSTIN: 27AAPFU0939F1ZV',
    'PO Bill No: 9751', 'Invoice No: INV-000125', 'Invoice Date: 12-May-2021',
    'Taxable Value: 29,280.00', 'CGST @ 9%: 2,635.20', 'SGST @ 9%: 2,635.20',
    'Discount: 2,800.00', 'Freight: 500.00', 'Grand Total: 32,250.40',
  ].join('\n'))
  assert.equal(candidate.invoice_number, 'INV-000125')
})

test('text-parser: captures a discount and freight component when printed', () => {
  const candidate = textParser.parseInvoiceText([
    'TAX INVOICE', 'ACME TRADERS PVT LTD', 'GSTIN: 27AAPFU0939F1ZV',
    'Invoice No: INV-00042', 'Invoice Date: 05/09/2026',
    'Taxable Value: 1,000.00', 'CGST @ 9%: 90.00', 'SGST @ 9%: 90.00', 'IGST: 0.00',
    'Discount: 200.00', 'Freight: 100.00', 'Grand Total: 1,080.00',
  ].join('\n'))
  assert.equal(candidate.discount_amount, 200)
  assert.equal(candidate.shipping_amount, 100)
  // 1,000 + 90 + 90 + 0 - 200 + 100 = 1,080 ties the printed grand total exactly.
  const result = ledger.evaluateLedger(candidate, OPTS)
  assert.equal(result.review, 'approved')
})
