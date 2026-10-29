// tests/multi-gst-rate.test.mjs — §multi-rate: the rate-wise tax breakdown
// carried alongside a SINGLE invoice register row.
//
// Covers the whole pure chain in-process (never reimplemented):
//   tax-slices (derive/validate/merge) → ledger.evaluateLedger (additive gating)
//   → text-parser (printed rate-wise summary) → ledger-mapping (per-slice
//   ledger, never fabricated) → excel/generator (the three-sheet register:
//   Purchase Register ONE row/invoice, Tax Breakdown one row/slice, Purchase
//   Import the untouched 12-column contract).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importTs } from '../scripts/_ts-import.mjs'

const slices = await importTs('lib/ocr/tax-slices.ts')
const ledger = await importTs('lib/ocr/ledger.ts')
const textParser = await importTs('lib/ocr/text-parser.ts')
const tallyMap = await importTs('lib/tally/ledger-mapping.ts')
const gen = await importTs('lib/excel/generator.ts')

const NOW = new Date('2026-10-16T00:00:00Z')
const R = slices.MIXED_GST_REASONS

const slice = (o) => ({
  rate_percent: null, taxable_value: null, cgst_amount: null,
  sgst_amount: null, igst_amount: null, ...o,
})

// ---- derivation: never fabricate a breakdown a payload does not have ----

test('a clean single-rate local head derives exactly one evidenced slice', () => {
  const out = slices.deriveSlicesFromInvoiceHeads({
    taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
    cgst_rate_percent: 9, sgst_rate_percent: 9,
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].rate_percent, 18) // equal printed halves sum to the overall rate
  assert.equal(out[0].treatment, 'local')
  assert.equal(out[0].provenance, 'invoice-heads')
})

test('a printed IGST head derives one interstate slice', () => {
  const out = slices.deriveSlicesFromInvoiceHeads({
    taxable_value: 1000, cgst_amount: 0, sgst_amount: 0, igst_amount: 180,
    igst_rate_percent: 18,
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].rate_percent, 18)
  assert.equal(out[0].treatment, 'interstate')
  assert.equal(out[0].igst_amount, 180)
})

test('mixed or unevidenced heads derive NOTHING — no invented rate, never zero-filled', () => {
  // Unequal printed halves: a mixed-rate bill masquerading as one head.
  assert.equal(slices.deriveSlicesFromInvoiceHeads({
    taxable_value: 1000, cgst_amount: 100, sgst_amount: 100, igst_amount: 0,
    cgst_rate_percent: 10, sgst_rate_percent: 12.5,
  }), null)
  // No rate evidence at all: the amounts alone must never produce a rate.
  assert.equal(slices.deriveSlicesFromInvoiceHeads({
    taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
  }), null)
  // Contradictory heads (IGST beside CGST/SGST): unknown treatment, no slice.
  assert.equal(slices.deriveSlicesFromInvoiceHeads({
    taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 180,
    cgst_rate_percent: 9, sgst_rate_percent: 9, igst_rate_percent: 18,
  }), null)
})

// ---- validation: decimal-safe, additive, fail-toward-review ----

test('a consistent mixed-rate breakdown validates with zero reasons', () => {
  const ss = [
    slice({ rate_percent: 5, taxable_value: 1000, cgst_amount: 25, sgst_amount: 25, treatment: 'local' }),
    slice({ rate_percent: 18, taxable_value: 2000, cgst_amount: 180, sgst_amount: 180, treatment: 'local' }),
  ]
  const inv = { taxable_value: 3000, cgst_amount: 205, sgst_amount: 205, igst_amount: 0, total_amount: 3410 }
  const out = slices.validateTaxSlices(ss, inv)
  assert.equal(out.breakdownValidated, true)
  assert.deepEqual(out.reasons, [])
  assert.deepEqual(out.slices.map((s) => s.validation_status), ['validated', 'validated'])
})

test('slices that disagree with the invoice heads raise the invoice-total mismatch', () => {
  const ss = [
    slice({ rate_percent: 5, taxable_value: 1000, cgst_amount: 25, sgst_amount: 25, treatment: 'local' }),
    slice({ rate_percent: 18, taxable_value: 2000, cgst_amount: 180, sgst_amount: 180, treatment: 'local' }),
  ]
  // Invoice prints 10% CGST higher than the slices can explain.
  const out = slices.validateTaxSlices(ss, { taxable_value: 3000, cgst_amount: 250, sgst_amount: 205, igst_amount: 0 })
  assert.equal(out.breakdownValidated, false)
  assert.ok(out.reasons.some((r) => r.startsWith(`${R.invoiceTotalMismatch}:cgst`)), out.reasons.join(','))
})

test('per-slice contradictions are named: unequal halves, rate-vs-amount, unresolved rate, treatment conflict', () => {
  const out = slices.validateTaxSlices([
    slice({ rate_percent: 12, taxable_value: 1000, cgst_amount: 60, sgst_amount: 50, treatment: 'local' }),
  ], { taxable_value: 1000, cgst_amount: 60, sgst_amount: 50, igst_amount: 0 })
  assert.ok(out.reasons.some((r) => r.startsWith(`${R.sliceMismatch}:unequal-halves`)), out.reasons.join(','))

  const bad = slices.validateTaxSlices([
    slice({ rate_percent: 18, taxable_value: 1000, igst_amount: 200, treatment: 'interstate' }),
  ], { taxable_value: 1000, igst_amount: 200 })
  assert.ok(bad.reasons.some((r) => r.startsWith(`${R.sliceMismatch}:rate`)), bad.reasons.join(','))

  const noRate = slices.validateTaxSlices([
    slice({ rate_percent: null, taxable_value: 1000, igst_amount: 180, treatment: 'interstate' }),
  ], { taxable_value: 1000, igst_amount: 180 })
  assert.ok(noRate.reasons.some((r) => r.startsWith(`${R.rateUnresolved}`)), noRate.reasons.join(','))

  const both = slices.validateTaxSlices([
    slice({ rate_percent: 18, taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 90, treatment: 'local' }),
  ], { taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 90 })
  assert.ok(both.reasons.some((r) => r.startsWith(`${R.treatmentConflict}`)), both.reasons.join(','))
  assert.equal(both.breakdownValidated, false)
})

test('duplicate rate+treatment slices are a conflict, never silently summed', () => {
  const out = slices.validateTaxSlices([
    slice({ rate_percent: 18, taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, treatment: 'local' }),
    slice({ rate_percent: 18, taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, treatment: 'local' }),
  ], { taxable_value: 2000, cgst_amount: 180, sgst_amount: 180 })
  assert.ok(out.reasons.some((r) => r.startsWith(`${R.sliceMismatch}:duplicate-rate`)), out.reasons.join(','))
  assert.equal(out.breakdownValidated, false)
})

// ---- merge: slice-wise, never flattened ----

test('mergeSlices keeps every distinct rate from both sources and primary wins per rate', () => {
  const p = [slice({ rate_percent: 5, taxable_value: 1000, cgst_amount: 25, sgst_amount: 25, treatment: 'local' })]
  const f = [
    slice({ rate_percent: 5, taxable_value: 999, cgst_amount: 24, sgst_amount: 24, treatment: 'local' }),
    slice({ rate_percent: 18, taxable_value: 2000, igst_amount: 360, treatment: 'interstate' }),
  ]
  const merged = slices.mergeSlices(p, f)
  assert.equal(merged.length, 2, 'the fallback fills a rate the primary omitted')
  const five = merged.find((s) => s.rate_percent === 5)
  assert.equal(five.taxable_value, 1000, 'the primary slice is never overwritten by the fallback')
  assert.equal(slices.mergeSlices(null, null), null)
  assert.equal(slices.mergeSlices([], null), null)
})

// ---- evaluateLedger: strictly additive gating, legacy behaviour intact ----

test('a validated mixed-rate candidate auto-approves and carries its breakdown on the row', () => {
  const ev = ledger.evaluateLedger({
    invoice_date: '05/09/2026', invoice_number: 'MRG-1',
    vendor_name: 'Multi Rate Traders', supplier_gstin: '27AAPFU0939F1ZV',
    taxable_value: 3000, cgst_amount: 205, sgst_amount: 205, igst_amount: 0,
    total_amount: 3410,
    tax_slices: [
      slice({ rate_percent: 5, taxable_value: 1000, cgst_amount: 25, sgst_amount: 25, treatment: 'local' }),
      slice({ rate_percent: 18, taxable_value: 2000, cgst_amount: 180, sgst_amount: 180, treatment: 'local' }),
    ],
  }, { minConfidence: 0.8, now: NOW })
  assert.equal(ev.review, 'approved', ev.reasons.join(','))
  assert.equal(ev.breakdownValidated, true)
  assert.equal(ev.row.tax_slices.length, 2, 'the invoice stays ONE row carrying its full breakdown')
})

test('an inconsistent mixed-rate breakdown forces review with the named gap, never a silent pass', () => {
  const ev = ledger.evaluateLedger({
    invoice_date: '05/09/2026', invoice_number: 'MRG-2',
    vendor_name: 'Multi Rate Traders', supplier_gstin: '27AAPFU0939F1ZV',
    taxable_value: 3000, cgst_amount: 250, sgst_amount: 205, igst_amount: 0,
    total_amount: 3455,
    tax_slices: [
      slice({ rate_percent: 5, taxable_value: 1000, cgst_amount: 25, sgst_amount: 25, treatment: 'local' }),
      slice({ rate_percent: 18, taxable_value: 2000, cgst_amount: 180, sgst_amount: 180, treatment: 'local' }),
    ],
  }, { minConfidence: 0.8, now: NOW })
  assert.equal(ev.review, 'needs_review')
  assert.equal(ev.breakdownValidated, false)
  assert.ok(ev.reasons.includes(R.breakdownMissing), ev.reasons.join(','))
  assert.ok(ev.reasons.some((r) => r.startsWith(`${R.invoiceTotalMismatch}:cgst`)), ev.reasons.join(','))
})

test('the historical single-rate path is untouched: no slices, no mixed-gst reasons, one derived slice', () => {
  const ev = ledger.evaluateLedger({
    invoice_date: '05/09/2026', invoice_number: 'INV-42',
    vendor_name: 'Acme Traders Pvt Ltd', supplier_gstin: '27AAPFU0939F1ZV',
    taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0, total_amount: 1180,
    cgst_rate_percent: 9, sgst_rate_percent: 9,
  }, { minConfidence: 0.8, now: NOW })
  assert.equal(ev.review, 'approved', ev.reasons.join(','))
  assert.equal(ev.breakdownValidated, null, 'a single-rate bill has no breakdown to validate')
  assert.ok(!ev.reasons.some((r) => r.startsWith('mixed-gst-')), ev.reasons.join(','))
  assert.equal(ev.row.tax_slices.length, 1, 'the derived slice feeds the Tax Breakdown sheet')
})

test('mergeCandidates preserves the rate-wise breakdown across local/AI sources', () => {
  const textCand = textParser.parseInvoiceText([
    'Invoice No: MRG-9', 'Date: 05/09/2026', 'Acme Traders Pvt Ltd',
    'GSTIN: 27AAPFU0939F1ZV',
    'Taxable Value: 3,000.00', 'CGST: 205.00', 'SGST: 205.00', 'Total: 3,410.00',
    '5% 1,000.00 25.00 25.00',
    '18% 2,000.00 180.00 180.00',
  ].join('\n'))
  assert.ok(Array.isArray(textCand.tax_slices) && textCand.tax_slices.length === 2, 'printed summary parsed into slices')
  const aiCand = { invoice_number: 'MRG-9', taxable_value: 3000, total_amount: 3410 }
  aiCand.tax_slices = null // an AI payload with NO breakdown must not erase the printed one
  const merged = ledger.mergeCandidates(textCand, aiCand)
  assert.equal(merged.tax_slices?.length, 2, 'the stronger printed evidence survives the merge')
})

// ---- printed rate-wise summary parsing ----

test('parseRateWiseSummary reads 3-number local and 2-number interstate rows', () => {
  const out = textParser.parseRateWiseSummary([
    'Rate-wise summary',
    '5% 1,000.00 25.00 25.00',
    '12% 500.00 90.00',
    'Totals',
  ].join('\n'))
  assert.equal(out.length, 2)
  const five = out.find((s) => s.rate_percent === 5)
  assert.equal(five.treatment, 'local')
  assert.equal(five.taxable_value, 1000)
  assert.equal(five.cgst_amount, 25)
  assert.equal(five.sgst_amount, 25)
  assert.equal(five.igst_amount, null, 'an inapplicable head is UNKNOWN-shaped null, never a fake 0 read')
  const twelve = out.find((s) => s.rate_percent === 12)
  assert.equal(twelve.treatment, 'interstate')
  assert.equal(twelve.igst_amount, 90)
})

test('a one-rate summary or prose percentages never become slices', () => {
  assert.equal(textParser.parseRateWiseSummary('18% 2,000.00 180.00 180.00'), null,
    'a single rate keeps the historical no-slice path')
  assert.equal(textParser.parseRateWiseSummary('Discount 5% and GST at 18% applied\nCGST 90 SGST 90 IGST 180 Total 1180'), null,
    'mid-line prose percentages are not a rate-leading summary row')
})

// ---- per-slice ledger resolution: reuse the never-fabricate lookup ----

test('resolveSliceLedgerName echoes configured ledgers per rate and never invents one', () => {
  const mappings = [{ rate_class_key: 'local@5', ledger_name: 'Purchases @ 5%' }]
  const five = tallyMap.resolveSliceLedgerName({ rate_percent: 5, treatment: 'local' }, mappings)
  assert.equal(five.status, 'mapped')
  assert.equal(five.ledgerName, 'Purchases @ 5%')
  const eighteen = tallyMap.resolveSliceLedgerName({ rate_percent: 18, treatment: 'local' }, mappings)
  assert.equal(eighteen.status, 'mapping-required', 'a known rate without config is MISSING CONFIG, not an invention')
  assert.equal(eighteen.ledgerName, null)
  const nil = tallyMap.resolveSliceLedgerName({ rate_percent: null, treatment: 'unknown' }, mappings)
  assert.equal(nil.status, 'unresolved-rate', 'an unevidenced slice never gets a ledger by luck')
  assert.equal(nil.ledgerName, null)
})

// ---- the three-sheet register workbook ----

const REG_INV_MIXED = {
  invoice_date: '2026-09-05', invoice_number: 'MRG-1', vendor_name: 'Multi Rate Traders',
  supplier_gstin: '27AAPFU0939F1ZV',
  total_taxable_value: 3000, total_cgst: 205, total_sgst: 205, total_igst: 0,
  total_cess: null, other_charges: null, discount: null, round_off: null,
  grand_total: 3410, review_status: 'approved',
  slices: [
    { rate_percent: 5, taxable_value: 1000, cgst_amount: 25, sgst_amount: 25, igst_amount: null, treatment: 'local', provenance: 'printed-summary', validation_status: 'validated' },
    { rate_percent: 18, taxable_value: 2000, cgst_amount: 180, sgst_amount: 180, igst_amount: null, treatment: 'local', provenance: 'printed-summary', validation_status: 'validated' },
  ],
  importRows: [
    { invoice_date: '2026-09-05', invoice_number: 'MRG-1', vendor_name: 'Multi Rate Traders', supplier_gstin: '27AAPFU0939F1ZV', ledger_name: 'Purchase @ 5%', taxable_value: 1000, gst_rate_percent: 5, cgst_amount: 25, sgst_amount: 25, igst_amount: null, round_off: null, gross_total: 1050 },
    { invoice_date: '2026-09-05', invoice_number: 'MRG-1', vendor_name: 'Multi Rate Traders', supplier_gstin: '27AAPFU0939F1ZV', ledger_name: 'Purchase @ 18%', taxable_value: 2000, gst_rate_percent: 18, cgst_amount: 180, sgst_amount: 180, igst_amount: null, round_off: 0, gross_total: 2360 },
  ],
}
const REG_INV_LEGACY = {
  invoice_date: '2026-09-06', invoice_number: 'LEG-1', vendor_name: 'Acme Traders',
  supplier_gstin: '27AAPFU0939F1ZV',
  total_taxable_value: 1000, total_cgst: 90, total_sgst: 90, total_igst: 0,
  grand_total: 1180, review_status: 'approved',
  slices: [{ rate_percent: 18, taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: null, treatment: 'local', provenance: 'invoice-heads', validation_status: 'unvalidated' }],
  importRows: [
    { invoice_date: '2026-09-06', invoice_number: 'LEG-1', vendor_name: 'Acme Traders', supplier_gstin: '27AAPFU0939F1ZV', ledger_name: 'Purchase @ 18%', taxable_value: 1000, gst_rate_percent: 18, cgst_amount: 90, sgst_amount: 90, igst_amount: 0, round_off: 0, gross_total: 1180 },
  ],
}

async function loadWorkbook(buf) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  return wb
}

test('the register ships THREE sheets with exact structural counts (2 invoices, 3 slices, 3 import lines)', async () => {
  const buf = await gen.buildRegisterWorkbook([REG_INV_MIXED, REG_INV_LEGACY])
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK')
  const counts = {
    invoiceCount: 2,
    taxBreakdownRowCount: gen.expectedTaxBreakdownRowCount([REG_INV_MIXED, REG_INV_LEGACY]),
    importRowCount: 3,
  }
  assert.equal(counts.taxBreakdownRowCount, 3, 'two slices for the mixed bill, one for the legacy bill')
  await gen.validateRegisterWorkbook(buf, counts) // must NOT throw
  const wb = await loadWorkbook(buf)
  const reg = wb.getWorksheet('Purchase Register')
  const bd = wb.getWorksheet('Tax Breakdown')
  const imp = wb.getWorksheet('Purchase Import')
  assert.ok(reg && bd && imp, 'Purchase Register + Tax Breakdown + Purchase Import all exist')
  assert.equal(reg.rowCount, 3, 'EXACTLY one row per invoice, regardless of rate count')
  assert.equal(bd.rowCount, 4, 'one row per invoice per slice')
  assert.equal(imp.rowCount, 4, 'expanded import lines ride the untouched 12-column contract')
})

test('Purchase Register carries the shared dynamic per-rate columns and the invoice totals', async () => {
  const buf = await gen.buildRegisterWorkbook([REG_INV_MIXED, REG_INV_LEGACY])
  const wb = await loadWorkbook(buf)
  const reg = wb.getWorksheet('Purchase Register')
  const headers = []
  reg.getRow(1).eachCell((c, i) => { headers[i - 1] = String(c.text).trim() })
  // Deterministic ascending SHARED schema: the 5% block exists even though only
  // one invoice carries it, and every rate gets Taxable/CGST/SGST/IGST.
  assert.deepEqual(
    headers.filter((h) => /^\d/.test(h)),
    ['5% Taxable Value', '5% CGST', '5% SGST', '5% IGST',
      '18% Taxable Value', '18% CGST', '18% SGST', '18% IGST'],
  )
  assert.equal(headers[0], 'Invoice Date')
  // §3.3 ITC Eligibility is the last register column (added AFTER the totals block so
  // the fixed-header + rate-block layout the tests rely on never shifts).
  assert.equal(headers[headers.length - 1], 'ITC Eligibility')
  assert.equal(headers[headers.length - 2], 'Review/Validation Status')
  assert.ok(headers.includes('Total Taxable Value') && headers.includes('Grand Total') && headers.includes('Round Off'))

  const mixedRow = reg.getRow(2)
  const colOf = (label) => headers.indexOf(label) + 1
  assert.equal(mixedRow.getCell(colOf('5% Taxable Value')).value, 1000)
  assert.equal(mixedRow.getCell(colOf('18% CGST')).value, 180)
  assert.equal(mixedRow.getCell(colOf('Total Taxable Value')).value, 3000)
  assert.equal(mixedRow.getCell(colOf('Grand Total')).value, 3410)
  const legacyRow = reg.getRow(3)
  assert.equal(legacyRow.getCell(colOf('18% Taxable Value')).value, 1000, 'the legacy invoice shares the same columns')
  assert.ok(legacyRow.getCell(colOf('5% Taxable Value')).value == null || legacyRow.getCell(colOf('5% Taxable Value')).value === '',
    'an absent rate is BLANK, never a fabricated 0')
})

test('Tax Breakdown renders one row per slice with provenance and leaves unknown cells blank', async () => {
  const buf = await gen.buildRegisterWorkbook([REG_INV_MIXED, REG_INV_LEGACY])
  const wb = await loadWorkbook(buf)
  const bd = wb.getWorksheet('Tax Breakdown')
  const r2 = bd.getRow(2)
  assert.equal(r2.getCell(5).value, 5, 'rate is a NUMBER rendered with a % format')
  assert.equal(r2.getCell(5).numFmt, '0.##"%"')
  assert.equal(r2.getCell(7).value, 1000)
  assert.equal(String(r2.getCell(12).text).trim(), 'printed-summary', 'provenance rides the breakdown')
  assert.ok(r2.getCell(10).value == null || r2.getCell(10).value === '', 'inapplicable IGST head is BLANK, never the text null')
})

test('an invoice with NO evidenced breakdown still gets exactly one register row and one breakdown note', async () => {
  const bare = { ...REG_INV_LEGACY, slices: [] }
  const buf = await gen.buildRegisterWorkbook([bare])
  await gen.validateRegisterWorkbook(buf, { invoiceCount: 1, taxBreakdownRowCount: 1, importRowCount: 1 })
  const wb = await loadWorkbook(buf)
  assert.equal(wb.getWorksheet('Purchase Register').rowCount, 2)
  const note = wb.getWorksheet('Tax Breakdown').getRow(2).getCell(14)
  assert.equal(String(note.text).trim(), 'no rate-wise breakdown evidenced', 'never a fabricated breakdown row')
})

test('Purchase Import keeps the EXACT 12-column Tally contract inside the three-sheet register', async () => {
  const buf = await gen.buildRegisterWorkbook([REG_INV_MIXED])
  const wb = await loadWorkbook(buf)
  const imp = wb.getWorksheet('Purchase Import')
  const headers = []
  for (let i = 1; i <= 14; i += 1) {
    const t = String(imp.getRow(1).getCell(i).text ?? '').trim()
    if (t) headers.push(t)
  }
  assert.deepEqual(headers, [
    'Date', 'Invoice No', 'Supplier Name', 'GSTIN', 'Ledger Name', 'Taxable Amount',
    'Tax Rate', 'CGST Amount', 'SGST Amount', 'IGST Amount', 'Round Off', 'Gross Total',
  ], 'the two expanded per-slice lines share the untouched importer column set')
  assert.equal(imp.getRow(2).getCell(5).value, 'Purchase @ 5%', 'each slice line carries its OWN ledger')
})

test('the register validator fails CLOSED: every wrong sheet-count is refused', async () => {
  const good = await gen.buildRegisterWorkbook([REG_INV_MIXED, REG_INV_LEGACY])
  const base = { invoiceCount: 2, taxBreakdownRowCount: 3, importRowCount: 3 }
  await gen.validateRegisterWorkbook(good, base)
  const badCounts = [
    { ...base, invoiceCount: 1 }, { ...base, invoiceCount: 3 },
    { ...base, taxBreakdownRowCount: 2 }, { ...base, importRowCount: 2 },
  ]
  for (const counts of badCounts) {
    await assert.rejects(() => gen.validateRegisterWorkbook(good, counts), /WORKBOOK_INVALID/)
  }
  await assert.rejects(() => gen.validateRegisterWorkbook(good.subarray(0, 10), base), /WORKBOOK_INVALID/, 'truncated buffer never ships')
  await assert.rejects(() => gen.validateRegisterWorkbook(Buffer.from('not a zip archive at all', 'latin1'), base), /WORKBOOK_INVALID/)
})
