// §Part-2b per-category register sheets.
//
// The classification engine (Part 2a) tags every invoice with an accounting
// category; the register now splits its Purchase Register into ONE sheet per
// category while leaving the Tax Breakdown + 12-column Purchase Import sheets
// AGGREGATE (the Tally import contract is byte-for-byte unchanged). The whole
// point of this suite is that the split is DISPLAY ONLY: every invoice still
// appears exactly once, columns never shift between sheets, and a batch that
// only ever held purchases is byte-identical to the historical single sheet.
//
// The generator is alias-free, so the harness runs the REAL module. The wiring
// that reads the encrypted `_classification` sibling lives in an `@/`-aliased
// handler the harness cannot import, so it is pinned by source-contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importTs } from '../scripts/_ts-import.mjs'

const gen = await importTs('lib/excel/generator.ts')
const registerSrc = () => readFileSync(new URL('../lib/jobs/handlers/build-register.ts', import.meta.url), 'utf8')

async function loadWorkbook(buf) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  return wb
}

// Build a minimal, structurally-valid register invoice for one category.
const inv = (n, category, rate = 18, taxable = 1000) => {
  const half = Math.round(taxable * rate) / 200 // cgst == sgst == half of total tax
  const slice = {
    rate_percent: rate, taxable_value: taxable, cgst_amount: half,
    sgst_amount: half, igst_amount: 0, treatment: 'local',
    provenance: 'invoice-heads', validation_status: 'validated',
  }
  const importRow = {
    invoice_date: '2026-09-05', invoice_number: `INV-${n}`, vendor_name: `Vendor ${n}`,
    supplier_gstin: '27AAPFU0939F1ZV', ledger_name: `Purchase @ ${rate}%`,
    taxable_value: taxable, gst_rate_percent: rate, cgst_amount: half,
    sgst_amount: half, igst_amount: 0, round_off: 0, gross_total: taxable + half * 2,
  }
  return {
    invoice_date: '2026-09-05', invoice_number: `INV-${n}`, vendor_name: `Vendor ${n}`,
    supplier_gstin: '27AAPFU0939F1ZV', accountingCategory: category,
    total_taxable_value: taxable, total_cgst: half, total_sgst: half, total_igst: 0,
    total_cess: null, other_charges: null, discount: null, round_off: null,
    grand_total: taxable + half * 2, review_status: 'approved',
    slices: [slice], importRows: [importRow],
  }
}

// A register invoice that also carries a §3.3 ITC determination.
const invItc = (n, category, itc) => ({ ...inv(n, category), itcEligibility: itc })

// the header texts of a sheet, in column order
const headersOfSheet = (ws) => {
  const h = []
  ws.getRow(1).eachCell((c, i) => { h[i - 1] = String(c.text).trim() })
  return h
}

const countsFor = (list) => ({
  invoiceCount: list.length,
  taxBreakdownRowCount: gen.expectedTaxBreakdownRowCount(list),
  importRowCount: list.reduce((n, i) => n + i.importRows.length, 0),
})

// the invoice_number (column 2) of every data row on one register sheet
const sheetInvoiceNumbers = (ws) => {
  if (!ws) return null
  const out = []
  for (let r = 2; r <= ws.rowCount; r++) {
    const t = String(ws.getRow(r).getCell(2).text ?? '').trim()
    if (t) out.push(t)
  }
  return out
}
const numbersOn = (wb, name) => sheetInvoiceNumbers(wb.getWorksheet(name))

// --------------------------------------------------------------------------
test('2b-single: an all-purchase batch keeps the historical SINGLE Purchase Register (no extra sheets)', async () => {
  const list = [inv(1, 'purchase'), inv(2, null), inv(3, undefined)]
  const buf = await gen.buildRegisterWorkbook(list)
  await gen.validateRegisterWorkbook(buf, countsFor(list)) // must NOT throw
  const wb = await loadWorkbook(buf)
  const registerSheets = wb.worksheets.filter((w) => / Register$/.test(w.name)).map((w) => w.name)
  assert.deepEqual(registerSheets, ['Purchase Register'], 'undefined/null/purchase all collapse onto the single primary sheet')
  assert.equal(wb.getWorksheet('Purchase Register').rowCount, 4, 'header + exactly one row per invoice')
})

test('2b-split: a mixed-category batch emits one clearly-named sheet per category', async () => {
  const list = [
    inv(1, 'purchase'), inv(2, 'expense'), inv(3, 'expense'),
    inv(4, 'fixed_asset'), inv(5, 'service'), inv(6, 'other'),
  ]
  const buf = await gen.buildRegisterWorkbook(list)
  await gen.validateRegisterWorkbook(buf, countsFor(list))
  const wb = await loadWorkbook(buf)
  assert.deepEqual(
    wb.worksheets.filter((w) => / Register$/.test(w.name)).map((w) => w.name),
    ['Purchase Register', 'Expense Register', 'Service Register', 'Fixed Asset Register', 'Other Register'],
    'categories appear in the deterministic order, purchase first',
  )
  assert.deepEqual(numbersOn(wb, 'Purchase Register'), ['INV-1'])
  assert.deepEqual(numbersOn(wb, 'Expense Register'), ['INV-2', 'INV-3'])
  assert.deepEqual(numbersOn(wb, 'Fixed Asset Register'), ['INV-4'])
  assert.deepEqual(numbersOn(wb, 'Service Register'), ['INV-5'])
  assert.deepEqual(numbersOn(wb, 'Other Register'), ['INV-6'])
})

test('2b-noloss: every invoice appears EXACTLY once across the register sheets (sum == total)', async () => {
  const list = [inv(1, 'purchase'), inv(2, 'expense'), inv(3, 'fixed_asset'), inv(4, 'purchase')]
  const buf = await gen.buildRegisterWorkbook(list)
  await gen.validateRegisterWorkbook(buf, countsFor(list)) // the summed check must pass
  const wb = await loadWorkbook(buf)
  const across = wb.worksheets
    .filter((w) => / Register$/.test(w.name))
    .flatMap((w) => sheetInvoiceNumbers(w))
  assert.deepEqual([...across].sort(), ['INV-1', 'INV-2', 'INV-3', 'INV-4'], 'no invoice lost to a bucket or duplicated into two')
})

test('2b-aggregate: Tax Breakdown + Purchase Import stay whole regardless of the category split', async () => {
  const list = [inv(1, 'purchase'), inv(2, 'expense'), inv(3, 'fixed_asset')]
  const buf = await gen.buildRegisterWorkbook(list)
  const counts = countsFor(list)
  await gen.validateRegisterWorkbook(buf, counts)
  const wb = await loadWorkbook(buf)
  // one row per invoice per slice (all single-slice here) => 3 slices + header
  assert.equal(wb.getWorksheet('Tax Breakdown').rowCount, 4, 'breakdown is aggregate, never per-category')
  // 12-column import: 3 lines + header, untouched by the split
  const imp = wb.getWorksheet('Purchase Import')
  assert.equal(imp.columnCount, 12, 'the Tally import column contract is byte-for-byte intact')
  assert.equal(imp.rowCount, 4, 'every import line still lands on the single aggregate sheet')
})

test('2b-shared-columns: a rate present on only one category still reserves its column on every sheet', async () => {
  // purchase at 5%, expense at 18% — the union schema (5% and 18%) must appear on BOTH sheets.
  const list = [inv(1, 'purchase', 5), inv(2, 'expense', 18)]
  const buf = await gen.buildRegisterWorkbook(list)
  await gen.validateRegisterWorkbook(buf, countsFor(list))
  const wb = await loadWorkbook(buf)
  const headersOf = (name) => {
    const h = []
    wb.getWorksheet(name).getRow(1).eachCell((c, i) => { h[i - 1] = String(c.text).trim() })
    return h.filter((x) => /^\d/.test(x))
  }
  const expected = ['5% Taxable Value', '5% CGST', '5% SGST', '5% IGST', '18% Taxable Value', '18% CGST', '18% SGST', '18% IGST']
  assert.deepEqual(headersOf('Purchase Register'), expected, 'purchase sheet carries both rate blocks')
  assert.deepEqual(headersOf('Expense Register'), expected, 'expense sheet shares the SAME column schema — a column never shifts between categories')
  // the 18%-only invoice leaves the 5% block blank (never a fabricated 0)
  const exp = wb.getWorksheet('Expense Register').getRow(2)
  const colOf = (label) => headersOf('Expense Register').indexOf(label) + 6 // +6 fixed headers precede the rate block
  assert.ok(exp.getCell(colOf('5% Taxable Value')).value == null || exp.getCell(colOf('5% Taxable Value')).value === '',
    'absent rate is BLANK on the category sheet, exactly as on the aggregate register')
})

test('2b-unknown: a classified unknown gets its own sheet, a garbage string fails open to purchase', async () => {
  const list = [inv(1, 'unknown'), inv(2, 'totally-not-a-category')]
  const buf = await gen.buildRegisterWorkbook(list)
  await gen.validateRegisterWorkbook(buf, countsFor(list)) // must NOT throw
  const wb = await loadWorkbook(buf)
  assert.deepEqual(numbersOn(wb, 'Uncategorised Register'), ['INV-1'], "the real 'unknown' enum gets its own honest sheet")
  assert.deepEqual(numbersOn(wb, 'Purchase Register'), ['INV-2'], 'a non-enum value is never a phantom sheet — it fails open to the primary purchase register')
})

test('2b-primary-exists: a batch with zero purchase rows STILL carries the required Purchase Register sheet', async () => {
  const list = [inv(1, 'expense'), inv(2, 'fixed_asset')]
  const buf = await gen.buildRegisterWorkbook(list)
  await gen.validateRegisterWorkbook(buf, countsFor(list)) // validator hard-requires Purchase Register
  const wb = await loadWorkbook(buf)
  const reg = wb.getWorksheet('Purchase Register')
  assert.ok(reg, 'the delivery/integrity contract sheet always exists')
  assert.equal(String(reg.getRow(1).getCell(1).text).trim(), 'Invoice Date', 'header renders even on an empty category sheet')
  assert.equal(reg.rowCount, 1, 'no purchase rows => header only; the split is display-only')
})

test('2b-validate-throws: a phantom extra register row is rejected (integrity gate stays honest)', async () => {
  const list = [inv(1, 'purchase'), inv(2, 'expense')]
  const buf = await gen.buildRegisterWorkbook(list)
  // claim one MORE invoice than the sheets actually hold => the summed check must fail closed
  await assert.rejects(
    () => gen.validateRegisterWorkbook(buf, { invoiceCount: 3, taxBreakdownRowCount: 2, importRowCount: 2 }),
    /register sheets expected 3 invoice row\(s\) in total, found 2/,
  )
})

// ==========================================================================
// Source-contract: the handler reads the classified category off the encrypted
// sibling and feeds it to the generator — WITHOUT touching delivery/naming.
// ==========================================================================
test('2b-wire: build-register passes _classification.accountingCategory and emits ONE FILE PER category', () => {
  const src = registerSrc()
  assert.match(src, /_classification\?:\s*\{ accountingCategory\?:\s*unknown(?:;\s*itcEligibility\?:\s*unknown)? \}/, 'the decrypted payload type carries the classification sibling')
  assert.match(
    src,
    /accountingCategory:\s*typeof row\._classification\?\.accountingCategory === 'string'\s*\?\s*row\._classification\.accountingCategory\s*:\s*null/,
    'a string category rides through; anything else is null (generator defaults it to purchase)',
  )
  // §separate-files-per-category: the handler now buckets the resolved invoices by
  // the SAME normalization the renderer uses, walks a deterministic order, and
  // builds exactly ONE workbook per present category — the old single-workbook
  // display split is intentionally gone.
  assert.match(src, /normalizeRegisterCategory\(inv\.accountingCategory\)/, 'invoices are bucketed by the normalized accounting category')
  assert.match(src, /REGISTER_CATEGORY_ORDER\.filter\(/, 'categories are emitted in a deterministic order')
  assert.match(src, /REGISTER_BUCKET_ERROR/, 'a normalization drift that drops an invoice fails CLOSED before storage')
  assert.equal((src.match(/await buildCategoryWorkbook\(/g) ?? []).length, 1, 'exactly one per-category build call site (looped over buckets)')
  assert.equal((src.match(/await buildRegisterWorkbook\(/g) ?? []).length, 0, 'the old single-workbook build is gone from the handler')
  // each category file is validated with ITS OWN bucket row count and sheet name
  assert.match(src, /invoiceCount:\s*bucket\.length/, 'the register-row integrity check is keyed on the bucket, per file')
  assert.match(src, /registerSheetName:\s*sheetName/, 'the validator asserts the category-specific register sheet')
})

// ==========================================================================
// §3.3 ITC eligibility: DESCRIPTIVE register column; the Purchase Import
// (Tally) contract stays byte-for-byte 12 columns; a review-only category
// set by a human gets its own sheet.
// ==========================================================================
test('3.3-itc-column: ITC Eligibility rides the register sheets, never the 12-col Purchase Import', async () => {
  const list = [invItc(1, 'purchase', 'needs_review'), invItc(2, 'receipt', 'ineligible'), inv(3, 'expense')]
  const buf = await gen.buildRegisterWorkbook(list)
  await gen.validateRegisterWorkbook(buf, countsFor(list)) // the extra total column must not break integrity
  const wb = await loadWorkbook(buf)
  const reg = wb.getWorksheet('Purchase Register')
  const idx = headersOfSheet(reg).indexOf('ITC Eligibility')
  assert.ok(idx >= 0, 'the Purchase Register carries an ITC Eligibility column')
  assert.equal(String(reg.getRow(2).getCell(idx + 1).text).trim(), 'ITC needs review', 'an invoice-shaped row reads needs_review')
  // The Tally import contract is untouched: still exactly 12 columns, no ITC column.
  const imp = wb.getWorksheet('Purchase Import')
  assert.equal(imp.columnCount, 12, 'the 12-column Tally import sheet is byte-for-byte intact')
  assert.ok(!headersOfSheet(imp).includes('ITC Eligibility'), 'ITC never leaks into the import contract')
})

test('3.3-itc-descriptive: a needs_review ITC row is STILL in the register (never filtered, §5)', async () => {
  const list = [invItc(1, 'purchase', 'needs_review'), invItc(2, 'purchase', 'eligible')]
  const buf = await gen.buildRegisterWorkbook(list)
  await gen.validateRegisterWorkbook(buf, countsFor(list))
  const wb = await loadWorkbook(buf)
  assert.deepEqual(numbersOn(wb, 'Purchase Register'), ['INV-1', 'INV-2'], 'ITC status never removes a valid approved record from its register')
})

test('3.3-capital-purchase-sheet: a human-classified capital_purchase gets its own sheet', async () => {
  const list = [inv(1, 'purchase'), inv(2, 'capital_purchase'), inv(3, 'sales')]
  const buf = await gen.buildRegisterWorkbook(list)
  await gen.validateRegisterWorkbook(buf, countsFor(list))
  const wb = await loadWorkbook(buf)
  assert.deepEqual(
    wb.worksheets.filter((w) => / Register$/.test(w.name)).map((w) => w.name),
    ['Purchase Register', 'Capital Purchase Register', 'Sales Register'],
  )
  assert.deepEqual(numbersOn(wb, 'Capital Purchase Register'), ['INV-2'], 'capital_purchase lands on its own sheet, never folded into purchase')
  assert.deepEqual(numbersOn(wb, 'Sales Register'), ['INV-3'])
})
