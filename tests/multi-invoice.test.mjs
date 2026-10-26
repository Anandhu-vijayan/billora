// §P3-14 multi-invoice / multi-page PDF split. Two layers:
//   (1) the PURE page-grouping (invoiceNumberKey + groupPageCandidates) is exercised
//       IN-PROCESS by slicing it out of invoice-extractor.ts and running it with an
//       injected merge — no sharp, no ledger, no alias, fully deterministic. This is
//       the function that decides which pages belong to the SAME invoice; a bug here
//       would blend two bills' totals into one row, so it is pinned hard.
//   (2) the WIRING is a SOURCE-CONTRACT: the extractor reads the digital text layer
//       page-by-page, groups by invoice number, threads multiInvoiceDetected onto the
//       result, adds the machine reason, and can only ever push toward needs_review;
//       the handler folds the flag into the authoritative row (never approve); the code
//       maps to plain English; and pdf.ts exposes the per-page text function the
//       extractor depends on while keeping the joined-string export intact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const extractorSrc = () => readFileSync(new URL('../lib/ocr/invoice-extractor.ts', import.meta.url), 'utf8')
const pdfSrc = () => readFileSync(new URL('../lib/ocr/pdf.ts', import.meta.url), 'utf8')
const handlerSrc = () => readFileSync(new URL('../lib/jobs/handlers/extract-invoice.ts', import.meta.url), 'utf8')
const reviewSrc = () => readFileSync(new URL('../lib/whatsapp/review-edit.ts', import.meta.url), 'utf8')

// ---- (1) pure grouping, sliced + run standalone -----------------------------
function loadPure() {
  const src = extractorSrc()
  const from = src.indexOf('function invoiceNumberKey')
  const to = src.indexOf('function combinePageCandidates')
  assert.ok(from >= 0 && to > from, 'pure region markers found')
  const region = src.slice(from, to).replace(/^export /gm, '')
  const js = ts.transpileModule(region, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return new Function(`${js}\nreturn { invoiceNumberKey, groupPageCandidates }`)()
}

// A values-preserving merge that keeps the FIRST non-empty value, mirroring the real
// mergeCandidates enough to prove a page never donates its total to a DIFFERENT
// invoice's group.
const testMerge = (primary, fallback) => {
  const out = { ...primary }
  for (const [k, v] of Object.entries(fallback)) {
    if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v
  }
  return out
}

test('P3-14 invoiceNumberKey normalises case and inner whitespace', () => {
  const { invoiceNumberKey } = loadPure()
  assert.equal(invoiceNumberKey('  inv-1 '), 'INV-1')
  assert.equal(invoiceNumberKey('INV  1'), 'INV1')
  assert.equal(invoiceNumberKey(null), '')
  assert.equal(invoiceNumberKey(undefined), '')
})

test('P3-14 same invoice number across pages merges into ONE group', () => {
  const { groupPageCandidates } = loadPure()
  const groups = groupPageCandidates([
    { invoice_number: 'INV-1', total_amount: 100, vendor_name: 'Acme' },
    { invoice_number: 'inv-1', taxable_value: 90 },
  ], testMerge)
  assert.equal(groups.groups.length, 1, 'one invoice')
  assert.equal(groups.distinctInvoiceNumbers, 1)
  assert.equal(groups.multiInvoiceDetected, false)
  assert.equal(groups.groups[0].candidate.total_amount, 100)
  assert.equal(groups.groups[0].candidate.taxable_value, 90, 'page 2 fills a field page 1 missed')
})

test('P3-14 a numberless continuation page joins the CURRENT invoice', () => {
  const { groupPageCandidates } = loadPure()
  const groups = groupPageCandidates([
    { invoice_number: 'INV-1', total_amount: 100 },
    { invoice_number: null, taxable_value: 90 },
    { invoice_number: '', cgst_amount: 5 },
  ], testMerge)
  assert.equal(groups.groups.length, 1, 'all three pages are one bill')
  assert.equal(groups.multiInvoiceDetected, false)
  assert.equal(groups.groups[0].candidate.cgst_amount, 5)
})

test('P3-14 two distinct numbers split into TWO groups and never cross-blend', () => {
  const { groupPageCandidates } = loadPure()
  const groups = groupPageCandidates([
    { invoice_number: 'INV-A', total_amount: 100, vendor_name: 'Acme' },
    { invoice_number: 'INV-A', taxable_value: 90 },
    { invoice_number: 'INV-B', total_amount: 500, vendor_name: 'Beta' },
  ], testMerge)
  assert.equal(groups.groups.length, 2, 'two invoices on one document')
  assert.equal(groups.distinctInvoiceNumbers, 2)
  assert.equal(groups.multiInvoiceDetected, true)
  const a = groups.groups.find((g) => g.invoiceNumber === 'INV-A')
  const b = groups.groups.find((g) => g.invoiceNumber === 'INV-B')
  assert.equal(a.candidate.total_amount, 100)
  assert.equal(b.candidate.total_amount, 500, "B's total is NOT blended into A")
  assert.equal(a.candidate.vendor_name, 'Acme')
  assert.equal(b.candidate.vendor_name, 'Beta')
})

test('P3-14 interleaved pages rejoin the same invoice number', () => {
  const { groupPageCandidates } = loadPure()
  const groups = groupPageCandidates([
    { invoice_number: 'INV-A', total_amount: 100 },
    { invoice_number: 'INV-B', total_amount: 200 },
    { invoice_number: 'INV-A', taxable_value: 90 },
  ], testMerge)
  assert.equal(groups.groups.length, 2)
  const a = groups.groups.find((g) => g.invoiceNumber === 'INV-A')
  assert.equal(a.candidate.taxable_value, 90, 'A page 3 rejoined A, not B')
  assert.equal(a.candidate.total_amount, 100)
})

test('P3-14 a leading numberless page opens an anonymous group (no phantom split)', () => {
  const { groupPageCandidates } = loadPure()
  const groups = groupPageCandidates([
    { invoice_number: null, taxable_value: 10 },
    { invoice_number: null, cgst_amount: 1 },
  ], testMerge)
  assert.equal(groups.groups.length, 1, 'two blank-number pages stay one group')
  assert.equal(groups.distinctInvoiceNumbers, 0)
  assert.equal(groups.multiInvoiceDetected, false, 'no legible second number -> not flagged')
})

// ---- (2) wiring, source-contract --------------------------------------------
test('P3-14 extractor: digital PDF read page-by-page, grouped, flag threaded to result', () => {
  const e = extractorSrc()
  assert.ok(e.includes('extractPdfTextLayerPages(buffer, maxPdfPages)'), 'digital text layer read per page')
  assert.ok(e.includes('groupPageCandidates('), 'pages are grouped, not blindly concatenated')
  assert.ok(e.includes('multiInvoiceDetected: combined.multiInvoiceDetected'), 'both PDF branches report the flag')
  // The reason is added and can ONLY ever widen the review gate, never bless a row.
  assert.ok(e.includes("...(multiInvoiceDetected ? ['multi-invoice-document'] : [])"), 'machine reason added for a multi-invoice doc')
  assert.ok(e.includes('|| multiInvoiceDetected'), 'the flag forces needs_review (added to the approve-veto condition)')
  // It can never flip to approved: finalReview only ever degrades approved -> review.
  assert.ok(!/multiInvoiceDetected[\s\S]{0,60}\?\s*'approved'/.test(e), 'the flag never produces an approved verdict')
})

test('P3-14 handler: multi-invoice flag folds into the authoritative row as review', () => {
  const h = handlerSrc()
  assert.ok(h.includes('if (result.multiInvoiceDetected) {'), 'the handler reads the engine flag')
  assert.ok(h.includes("evaluation.review = 'needs_review'"), 'it forces review')
  assert.ok(h.includes("'multi-invoice-document'"), 'it records the machine reason')
})

test('P3-14 multi-invoice-document maps to a plain-English review reason', () => {
  const r = reviewSrc()
  assert.ok(r.includes("'multi-invoice-document': '"), 'reason has a customer-facing explanation')
})

test('P3-14 pdf.ts: per-page text export added, joined-string export kept intact', () => {
  const p = pdfSrc()
  assert.ok(p.includes('export async function extractPdfTextLayerPages'), 'the per-page function exists')
  assert.ok(/extractPdfTextLayerPages\([\s\S]*\): Promise<string\[\]>/.test(p), 'it returns one string per page')
  assert.ok(p.includes('const pages = await extractPdfTextLayerPages(buffer, maxPages)'), 'the joined export delegates to it')
  assert.ok(p.includes('return pages.join'), 'the joined export still returns a single string')
  assert.ok(p.includes('getTextContent'), 'the real pdf.js text layer is still used')
  assert.ok(p.includes('Math.min(doc.numPages, maxPages)'), 'page count stays bounded')
})
