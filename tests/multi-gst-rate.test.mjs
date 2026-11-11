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
import { readFileSync } from 'node:fs'
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

// ---- combined "GST(%)" header copied into both halves: 5% must NOT export 10% ----

test('a combined-rate annotation (5% in both heads) resolves to 5%, never 10% — Devamatha regression', () => {
  // Real hospital bill S24425: the item line prints only a total "GST(%) = 5.00";
  // the reader copies 5 into BOTH per-head rate fields, while the printed CGST/SGST
  // AMOUNTS (6.33 each on ~253 taxable) are the true 2.5% halves. The register must
  // export 5% / "Purchase @ 5%", NOT the doubled 10%.
  const dev = {
    taxable_value: 253.41, cgst_amount: 6.33, sgst_amount: 6.33, igst_amount: 0,
    cgst_rate_percent: 5, sgst_rate_percent: 5,
  }
  assert.equal(tallyMap.overallGstRatePercent(dev, 'local'), 5, 'combined 5% stays 5%, not 10%')
  assert.equal(tallyMap.tallyDefaultLedgerName(tallyMap.overallGstRatePercent(dev, 'local')), 'Purchase @ 5%')
  const derived = slices.deriveSlicesFromInvoiceHeads(dev)
  assert.equal(derived.length, 1)
  assert.equal(derived[0].rate_percent, 5, 'the derived slice carries the printed combined rate')
  assert.equal(derived[0].treatment, 'local')
  // Robust to the small taxable misread the export showed (252.68 vs 253.41).
  assert.equal(tallyMap.overallGstRatePercent({ ...dev, taxable_value: 252.68 }, 'local'), 5)
})

test('genuine equal halves still sum, and a real 10% bill is never wrongly halved', () => {
  // A true 18% intra-state bill (9% + 9%, amounts 90/90 on 1000) still resolves 18.
  assert.equal(tallyMap.overallGstRatePercent({
    taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
    cgst_rate_percent: 9, sgst_rate_percent: 9,
  }, 'local'), 18, 'halves tie to the amounts -> keep the sum')
  // A true 10% bill (5% + 5%, amounts 50/50 on 1000) must NOT collapse to 5%: the
  // halves sum ties to the printed amounts, so the sum wins over the combined read.
  assert.equal(tallyMap.overallGstRatePercent({
    taxable_value: 1000, cgst_amount: 50, sgst_amount: 50, igst_amount: 0,
    cgst_rate_percent: 5, sgst_rate_percent: 5,
  }, 'local'), 10, 'a genuine 10% (5+5) is not mistaken for a copied 5% total')
})

// ---- production regression: a MULTI-rate bill never becomes a `0%` slab ----
//
// Live fixtures INV-2026-10-103 (Steel Rods 7,500 @18% + Cement 17,500 @28%) and
// INV-2026-11-201 / INV-2026-11-001 (5% + 18% on 12,500): the extraction carried ONE
// flat pair of invoice-level rate fields reading 0, the old resolver fell through to
// the UNEVIDENCED sum, and the register printed the whole taxable value under
// `0% Taxable Value` while the Tally line posted `Purchase @ 0%` against 6,250 of
// real tax. An unevidenced rate is now UNRESOLVED — blank per-rate cells and a plain
// `Purchase` ledger — and a split only ever arrives as evidenced slices (a printed
// rate-wise summary or the vision rate-wise breakdown), validated against the heads.

const FLAT_18_28 = {
  taxable_value: 25000, cgst_amount: 3125, sgst_amount: 3125, igst_amount: 0,
  total_amount: 31250, cgst_rate_percent: 0, sgst_rate_percent: 0,
}
const FLAT_5_18 = {
  taxable_value: 12500, cgst_amount: 832.5, sgst_amount: 832.5, igst_amount: 0,
  total_amount: 14165, cgst_rate_percent: 0, sgst_rate_percent: 0,
}

test('PDF text parser recognises an unlabelled Products seller header outside Bill To', () => {
  const parsed = textParser.parseInvoiceText([
    'TAX INVOICE',
    'Sunrise Agro Products',
    'GSTIN: 32AAHIJ1234D1ZU',
    'Bill To: Anandhu Enterprises',
    'GSTIN: 32AABCT1234G1ZX',
    'Invoice No: INV-2026-11-001',
    'Invoice Date: 11-Nov-2026',
    'Taxable Value: 12500.00',
    'CGST: 832.50',
    'SGST: 832.50',
    'Grand Total: 14165.00',
  ].join('\n'))
  assert.equal(parsed.vendor_name, 'Sunrise Agro Products')
  assert.equal(parsed.vendor_ambiguous, undefined)
})

test('AI supplier name fills local buyer-block ambiguity only when it is not the buyer', () => {
  const local = textParser.parseInvoiceText([
    'TAX INVOICE',
    'Bill To: Anandhu Enterprises',
    'GSTIN: 32AABCT1234G1ZX',
    'Invoice No: INV-2026-11-001',
  ].join('\n'))
  assert.equal(local.vendor_ambiguous, true)
  const merged = ledger.mergeCandidates(local, { vendor_name: 'Sunrise Agro Products' })
  assert.equal(merged.vendor_name, 'Sunrise Agro Products')
  assert.equal(merged.vendor_ambiguous, false)
  const buyerLeak = ledger.mergeCandidates(local, { vendor_name: 'Anandhu Enterprises' })
  assert.equal(buyerLeak.vendor_name, null)
  assert.equal(buyerLeak.vendor_ambiguous, true)
})

test('INV-2026-11-001 item-level 5% + 18% slices reconcile without flattening', () => {
  const ev = ledger.evaluateLedger({
    invoice_date: '05/10/2026',
    invoice_number: 'INV-2026-11-001',
    vendor_name: 'Sunrise Agro Products',
    supplier_gstin: '32AAHIJ1234D1ZU',
    taxable_value: 12500,
    cgst_amount: 832.5,
    sgst_amount: 832.5,
    igst_amount: 0,
    total_amount: 14165,
    cgst_rate_percent: 0,
    sgst_rate_percent: 0,
    tax_slices: [
      slice({ rate_percent: 5, taxable_value: 4500, cgst_amount: 112.5, sgst_amount: 112.5, treatment: 'local', provenance: 'item-level' }),
      slice({ rate_percent: 18, taxable_value: 8000, cgst_amount: 720, sgst_amount: 720, treatment: 'local', provenance: 'item-level' }),
    ],
  }, { minConfidence: 0.8, now: NOW })
  assert.equal(ev.review, 'approved', ev.reasons.join(','))
  assert.equal(ev.breakdownValidated, true, ev.reasons.join(','))
  assert.deepEqual(ev.row.tax_slices.map((x) => [x.rate_percent, x.taxable_value, x.cgst_amount, x.sgst_amount]), [
    [5, 4500, 112.5, 112.5],
    [18, 8000, 720, 720],
  ])
  assert.equal(ev.row.taxable_value, 12500)
  assert.equal(ev.row.cgst_amount, 832.5)
  assert.equal(ev.row.sgst_amount, 832.5)
  assert.equal(ev.row.total_amount, 14165)
})

test('a multi-rate bill flattened onto one head resolves to NO rate — never the 0% slab', () => {
  assert.equal(tallyMap.overallGstRatePercent(FLAT_18_28, 'local'), null, '0/0 cannot explain 6,250 of tax')
  assert.equal(tallyMap.overallGstRatePercent(FLAT_5_18, 'local'), null, '0/0 cannot explain 1,665 of tax')
  assert.equal(slices.deriveSlicesFromInvoiceHeads(FLAT_18_28), null, 'no fabricated slice from an unevidenced head')
  assert.equal(slices.deriveSlicesFromInvoiceHeads(FLAT_5_18), null)
  // So export posts NOTHING invented: an unresolved class and a plain `Purchase`
  // display default, never a `Purchase @ 0%` classification of a taxed purchase.
  const row = {
    invoice_date: '2026-10-05', invoice_number: 'INV-2026-10-103',
    vendor_name: 'Steel And Cement Traders', supplier_gstin: '27AAPFU0939F1ZV',
    igst_rate_percent: null, ...FLAT_18_28,
  }
  const res = tallyMap.resolveLedgerName(row, [])
  assert.equal(res.status, 'unresolved-rate')
  assert.equal(res.gstRatePercent, null)
  assert.equal(res.rateClassKey, 'unresolved')
  assert.equal(tallyMap.tallyDefaultLedgerName(res.gstRatePercent), 'Purchase')
})

test('a printed rate that cannot reproduce its own tax head derives nothing — local and interstate', () => {
  // Interstate: a printed 5% IGST rate against 180 on 1,000 is a misread, not a slab.
  assert.equal(slices.deriveSlicesFromInvoiceHeads({
    taxable_value: 1000, cgst_amount: 0, sgst_amount: 0, igst_amount: 180, igst_rate_percent: 5,
  }), null)
  // Local: equal printed halves are only evidence if they explain the tax charged.
  assert.equal(slices.deriveSlicesFromInvoiceHeads({
    taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
    cgst_rate_percent: 12, sgst_rate_percent: 12,
  }), null, 'a 24% sum contradicts the 180 charged; asserting it would misclassify')
  // No resolvable taxable value means nothing to corroborate the rate against.
  assert.equal(slices.deriveSlicesFromInvoiceHeads({
    taxable_value: null, cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
    cgst_rate_percent: 9, sgst_rate_percent: 9,
  }), null)
  // A rate that DOES explain its halves still derives its one evidenced slice.
  const ok = slices.deriveSlicesFromInvoiceHeads({
    taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
    cgst_rate_percent: 9, sgst_rate_percent: 9,
  })
  assert.equal(ok.length, 1)
  assert.equal(ok[0].rate_percent, 18)
})

test('evaluateLedger leaves an unevidenced multi-rate bill with NO breakdown on the row', () => {
  const ev = ledger.evaluateLedger({
    invoice_date: '05/10/2026', invoice_number: 'INV-2026-10-103',
    vendor_name: 'Steel And Cement Traders', supplier_gstin: '27AAPFU0939F1ZV',
    ...FLAT_18_28,
  }, { minConfidence: 0.8, now: NOW })
  assert.ok(!ev.row.tax_slices, 'the row carries no invented rate-wise breakdown')
  assert.equal(slices.normalizeSlices(ev.row.tax_slices) ?? slices.deriveSlicesFromInvoiceHeads(ev.row), null,
    'what build-register resolves for display is NOTHING — blank per-rate cells')
  assert.equal(ev.review, 'needs_review', 'explicit 0% heads cannot approve positive tax without a rate-wise breakdown')
  assert.ok(ev.reasons.includes(R.rateUnresolved), ev.reasons.join(','))
  assert.ok(!ev.reasons.includes(R.breakdownMissing), 'do not claim a mixed breakdown was read when none was supplied')
  // Amounts are never rewritten to make a slab fit.
  assert.equal(ev.row.taxable_value, 25000)
  assert.equal(ev.row.cgst_amount, 3125)
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

// ---- capability: the split must be REPORTABLE, or it can only ever be blank ----

/** Mirror the register's per-slice import expansion: one line per evidenced slab. */
const slabImportLines = (slicesList, inv) => slicesList.map((s) => {
  const r = tallyMap.resolveSliceLedgerName(s, [])
  return {
    invoice_date: inv.invoice_date, invoice_number: inv.invoice_number,
    vendor_name: inv.vendor_name, supplier_gstin: inv.supplier_gstin,
    ledger_name: r.ledgerName ?? tallyMap.tallyDefaultLedgerName(r.gstRatePercent),
    taxable_value: s.taxable_value, gst_rate_percent: s.rate_percent,
    cgst_amount: s.cgst_amount, sgst_amount: s.sgst_amount, igst_amount: s.igst_amount,
    round_off: null,
    gross_total: (s.taxable_value ?? 0) + (s.cgst_amount ?? 0) + (s.sgst_amount ?? 0) + (s.igst_amount ?? 0),
  }
})

test('an evidenced rate-wise breakdown splits 18% / 28% and the register prints BOTH slab columns', async () => {
  // Production fixture INV-2026-10-103 read WITH its printed slab split (a printed
  // rate-wise summary or the vision rate-wise breakdown — the same explicit-slice
  // path either source feeds). 7,500 @18% + 17,500 @28% = 25,000 taxable, 6,250 tax.
  const ev = ledger.evaluateLedger({
    invoice_date: '05/10/2026', invoice_number: 'INV-2026-10-103',
    vendor_name: 'Steel And Cement Traders', supplier_gstin: '27AAPFU0939F1ZV',
    taxable_value: 25000, cgst_amount: 3125, sgst_amount: 3125, igst_amount: 0,
    total_amount: 31250, cgst_rate_percent: 0, sgst_rate_percent: 0,
    tax_slices: [
      slice({ rate_percent: 18, taxable_value: 7500, cgst_amount: 675, sgst_amount: 675, treatment: 'local', provenance: 'item-level' }),
      slice({ rate_percent: 28, taxable_value: 17500, cgst_amount: 2450, sgst_amount: 2450, treatment: 'local', provenance: 'item-level' }),
    ],
  }, { minConfidence: 0.8, now: NOW })
  assert.equal(ev.review, 'approved', ev.reasons.join(','))
  assert.equal(ev.breakdownValidated, true, 'the split reconciles to the invoice heads')
  assert.equal(ev.row.tax_slices.length, 2)

  const inv = {
    invoice_date: '2026-10-05', invoice_number: 'INV-2026-10-103',
    vendor_name: 'Steel And Cement Traders', supplier_gstin: '27AAPFU0939F1ZV',
    total_taxable_value: 25000, total_cgst: 3125, total_sgst: 3125, total_igst: 0,
    total_cess: null, other_charges: null, discount: null, round_off: null,
    grand_total: 31250, review_status: 'approved',
    slices: ev.row.tax_slices,
    importRows: slabImportLines(ev.row.tax_slices, { invoice_date: '2026-10-05', invoice_number: 'INV-2026-10-103', vendor_name: 'Steel And Cement Traders', supplier_gstin: '27AAPFU0939F1ZV' }),
  }
  const buf = await gen.buildRegisterWorkbook([inv])
  await gen.validateRegisterWorkbook(buf, { invoiceCount: 1, taxBreakdownRowCount: 2, importRowCount: 2 })
  const wb = await loadWorkbook(buf)
  const reg = wb.getWorksheet('Purchase Register')
  const headers = []
  reg.getRow(1).eachCell((c, i) => { headers[i - 1] = String(c.text).trim() })
  assert.deepEqual(headers.filter((h) => /^\d/.test(h)), [
    '18% Taxable Value', '18% CGST', '18% SGST', '18% IGST',
    '28% Taxable Value', '28% CGST', '28% SGST', '28% IGST',
  ], 'BOTH slabs print as their own columns — never a `0% Taxable Value` catch-all')
  const colOf = (label) => headers.indexOf(label) + 1
  assert.equal(reg.getRow(2).getCell(colOf('18% Taxable Value')).value, 7500)
  assert.equal(reg.getRow(2).getCell(colOf('28% Taxable Value')).value, 17500)
  assert.equal(reg.getRow(2).getCell(colOf('18% CGST')).value, 675)
  assert.equal(reg.getRow(2).getCell(colOf('28% SGST')).value, 2450)
  assert.equal(reg.getRow(2).getCell(colOf('Total Taxable Value')).value, 25000, 'the invoice stays ONE row')
  const imp = wb.getWorksheet('Purchase Import')
  assert.equal(String(imp.getRow(2).getCell(5).text), 'Purchase @ 18%', 'each slab posts to its OWN ledger')
  assert.equal(String(imp.getRow(3).getCell(5).text), 'Purchase @ 28%')
})

test('the vision schema ASKS for the printed rate-wise breakdown, and keeps it optional', () => {
  const src = readFileSync(new URL('../lib/ocr/vision.ts', import.meta.url), 'utf8')
  assert.match(src, /tax_slices: \{ type: Type\.ARRAY/, 'the flat heads cannot carry a slab split, so the schema must request one')
  assert.match(src, /RATE-WISE BREAKDOWN/)
  assert.match(src, /Never split the invoice into multiple invoice rows/, 'one invoice remains one register row')
  assert.ok(src.includes("'by the exact printed rate AND treatment, and SUM ONLY the printed taxable'"), 'explicit item-level evidence is grouped by slab')
  assert.match(src, /Return an EMPTY array when neither a printed summary nor complete item-level/, 'missing evidence remains unknown')
  // OPTIONAL, never required: a single-rate bill or a model that omits the key must
  // still be a valid response, not a permanent job failure over missing metadata.
  const body = src.slice(src.indexOf('const LEDGER_SCHEMA'))
  const requiredLists = [...body.matchAll(/required: \[([\s\S]*?)\]/g)].map((m) => m[1])
  assert.ok(requiredLists.length > 0, 'the schema declares a required list')
  assert.ok(requiredLists.every((r) => !r.includes('tax_slices')), 'tax_slices stays optional')
})
