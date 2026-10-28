// §Part-2 bill classification tests.
//
// The engine (lib/ocr/classify.ts) is alias-free + import-free, so the in-process
// harness runs the REAL module — these are behavioural tests, not mirrors. The
// WIRING lives in `@/`-aliased modules the harness cannot import, so those are
// pinned by source-contract (readFileSync) assertions, exactly like the onboarding
// suite pins migration + logging contracts. A contract change fails loudly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importTs } from '../scripts/_ts-import.mjs'

const classify = await importTs('lib/ocr/classify.ts')

const {
  DOC_TYPES, ACCOUNTING_CATEGORIES, CLASSIFICATION_METHODS, CLASSIFICATION_VERSION,
  isDocTypeFull, isAccountingCategory, headingRegion, decideDocType,
  decideAccountingCategory, classifyDocument, acceptAiClassification, applyUserClassification,
} = classify

// --- helpers ---------------------------------------------------------------
const classifyDoc = (fullText, opts = {}) => classifyDocument({
  structuralNoteType: opts.structuralNoteType ?? null,
  headingText: headingRegion(fullText),
  fullText,
})

// ===========================================================================
// Enums + guards (source of truth for DB CHECKs / validation / exports).
// ===========================================================================
test('CL-enums: strict document-type and category vocabularies are exposed', () => {
  assert.deepEqual(DOC_TYPES, [
    'invoice', 'credit_note', 'debit_note', 'bill_of_supply',
    'receipt', 'payment_voucher', 'delivery_challan', 'proforma_invoice', 'unknown',
  ])
  assert.deepEqual(ACCOUNTING_CATEGORIES, ['purchase', 'expense', 'service', 'fixed_asset', 'other', 'unknown'])
  assert.deepEqual(CLASSIFICATION_METHODS, ['rules', 'ai', 'user'])
  assert.equal(CLASSIFICATION_VERSION, 1)
  assert.equal(isDocTypeFull('bill_of_supply'), true)
  assert.equal(isDocTypeFull('Invoice'), false) // case-sensitive enum, never coerced
  assert.equal(isDocTypeFull('invoice '), false)
  assert.equal(isAccountingCategory('fixed_asset'), true)
  assert.equal(isAccountingCategory('asset'), false)
})

// ===========================================================================
// headingRegion: only the document's HEAD counts as title evidence.
// ===========================================================================
test('CL-heading: a footer "Received payment" line is outside the heading region', () => {
  const head = 'ACME TRADERS PVT LTD\nGSTIN: 27AAPFU0939F1ZV\nTAX INVOICE\nInvoice No: 42'
  const body = `${head}\n${'x'.repeat(50)}\n`.repeat(20) + 'Received payment via NEFT — thank you.'
  const region = headingRegion(body)
  assert.match(region, /TAX INVOICE/i)
  assert.doesNotMatch(region, /Received payment/i) // the signature/footer never reaches it
  assert.ok(region.length <= 800)
})

// ===========================================================================
// decideDocType: from the document's own words, never a guess.
// ===========================================================================
test('CL-type: a plain TAX INVOICE heading resolves to invoice, high confidence', () => {
  const d = decideDocType(null, headingRegion('ACME Pvt Ltd\nTAX INVOICE\nInvoice No: INV-1'))
  assert.equal(d.docType, 'invoice')
  assert.equal(d.confidence, 'high')
  assert.equal(d.conflicting, false)
})

test('CL-type: structural credit/debit note wins even when "invoice" appears in the body', () => {
  const d = decideDocType('credit_note', headingRegion('CREDIT NOTE\nAgainst invoice no. INV-100'))
  assert.equal(d.docType, 'credit_note')
  assert.equal(d.confidence, 'high')
})

test('CL-type: bill of supply and proforma are their own types (more specific than invoice)', () => {
  assert.equal(decideDocType(null, 'SUPPLY OF GOODS\nBILL OF SUPPLY').docType, 'bill_of_supply')
  assert.equal(decideDocType(null, 'PROFORMA INVOICE\nQuotation only').docType, 'proforma_invoice')
})

test('CL-type: a standalone receipt / voucher / challan (no invoice wording) is that type', () => {
  assert.equal(decideDocType(null, 'PAYMENT RECEIPT\nAmount received ₹5,000').docType, 'receipt')
  assert.equal(decideDocType(null, 'PAYMENT VOUCHER\nVoucher No: PV-1').docType, 'payment_voucher')
  assert.equal(decideDocType(null, 'DELIVERY CHALLAN\nGoods delivered').docType, 'delivery_challan')
})

// The critical regression guard: a genuine tax invoice that also prints the word
// "receipt"/"voucher" somewhere in its head must NEVER be hijacked into a
// review-forcing non-invoice type (this would silently dump real bills into review).
test('CL-type: an invoice with a stray "Receipt"/"voucher" word stays invoice (no hijack)', () => {
  const text = 'ACME Pvt Ltd\nTAX INVOICE\nInvoice No: 42\nReceipt: customer copy\nPayment terms: 30 days'
  const d = decideDocType(null, headingRegion(text))
  assert.equal(d.docType, 'invoice')
  assert.equal(d.conflicting, false)
})

test('CL-type: an unheadered page is unknown, never a silent invoice default', () => {
  const d = decideDocType(null, 'some numbers 12345 and words but no title at all')
  assert.equal(d.docType, 'unknown')
  assert.equal(d.confidence, 'low')
  assert.equal(d.conflicting, false)
})

test('CL-type: two competing standalone titles conflict (a machine must not pick)', () => {
  const d = decideDocType(null, 'PAYMENT VOUCHER / DELIVERY CHALLAN')
  assert.equal(d.docType, 'unknown')
  assert.equal(d.conflicting, true)
})

// ===========================================================================
// decideAccountingCategory: explicit evidence only, else review / purchase default.
// ===========================================================================
test('CL-cat: a plain invoice books as purchase (the historical register intent)', () => {
  const c = decideAccountingCategory('invoice', 'TAX INVOICE for steel goods, taxable value ₹10000')
  assert.equal(c.category, 'purchase')
  assert.equal(c.needsReview, false)
})

test('CL-cat: fixed-asset wording books as fixed_asset without review', () => {
  const c = decideAccountingCategory('invoice', 'Industrial machinery and equipment, Serial No: XY-123, installation included')
  assert.equal(c.category, 'fixed_asset')
  assert.equal(c.needsReview, false)
})

test('CL-cat: a receipt is not invoice-shaped so its category awaits a human', () => {
  const c = decideAccountingCategory('receipt', 'PAYMENT RECEIPT amount received')
  assert.equal(c.category, 'unknown')
  assert.equal(c.needsReview, true)
  assert.equal(c.reason, 'payment-evidence-not-an-invoice')
})

test('CL-cat: unknown type keeps the purchase default (recall preserved, not blocked)', () => {
  const c = decideAccountingCategory('unknown', 'no useful text here')
  assert.equal(c.category, 'purchase')
  assert.equal(c.needsReview, false)
})

// ===========================================================================
// classifyDocument: end-to-end review gating is additive only.
// ===========================================================================
test('CL-doc: a clean tax invoice classifies invoice/purchase and does NOT need review', () => {
  const r = classifyDoc('ACME Pvt Ltd\nTAX INVOICE\nInvoice No: 42\ntaxable value ₹10,000 cgst 900 sgst 900')
  assert.equal(r.documentType, 'invoice')
  assert.equal(r.accountingCategory, 'purchase')
  assert.equal(r.method, 'rules')
  assert.equal(r.needsReview, false)
  assert.deepEqual(r.reviewReasons, [])
  assert.equal(r.version, CLASSIFICATION_VERSION)
})

test('CL-doc: a standalone receipt forces review with a plain reason', () => {
  const r = classifyDoc('PAYMENT RECEIPT\nAmount received ₹5,000 against order 77')
  assert.equal(r.documentType, 'receipt')
  assert.equal(r.accountingCategory, 'unknown')
  assert.equal(r.needsReview, true)
  assert.ok(r.reviewReasons.includes('payment-evidence-not-an-invoice'))
})

test('CL-doc: a heading conflict forces review and a machine never resolves it alone', () => {
  const r = classifyDoc('PAYMENT VOUCHER / DELIVERY CHALLAN\ntwo titles side by side')
  assert.equal(r.documentType, 'unknown')
  assert.equal(r.needsReview, true)
  assert.ok(r.reviewReasons.includes('document-heading-conflict'))
})

test('CL-doc: a credit note keeps its OWN type and preserves the original-invoice reference', () => {
  const r = classifyDoc('CREDIT NOTE\nAgainst invoice no. INV-2026-0042\nreverses part of the supply', { structuralNoteType: 'credit_note' })
  assert.equal(r.documentType, 'credit_note')
  assert.equal(r.originalInvoiceRef, 'INV-2026-0042')
  // a note is invoice-shaped and books as purchase by default; it is the handler's
  // §P3-16 note gate (not this classifier) that forces it to review.
  assert.equal(r.accountingCategory, 'purchase')
  assert.equal(r.needsReview, false)
})

// ===========================================================================
// acceptAiClassification: strict schema, never coerced, confidence capped.
// ===========================================================================
test('CL-ai: rejects an out-of-enum label (never maps or guesses it)', () => {
  const rules = classifyDoc('no heading at all here, just numbers 999')
  const res = acceptAiClassification({ documentType: 'TAX INVOICE', accountingCategory: 'purchase', confidence: 'high' }, rules)
  assert.equal(res.accepted, false)
})

test('CL-ai: only overrides when the rules themselves were undecided, and caps at medium', () => {
  const rules = classifyDoc('no heading at all here, just numbers 999') // docType unknown, low
  assert.equal(rules.documentType, 'unknown')
  const res = acceptAiClassification({ documentType: 'invoice', accountingCategory: 'purchase', confidence: 'high' }, rules)
  assert.equal(res.accepted, true)
  assert.equal(res.result.method, 'ai')
  assert.equal(res.result.confidence, 'medium') // a model self-report is never promoted to high
})

test('CL-ai: cannot override a confident deterministic answer (strong rules evidence wins)', () => {
  const rules = classifyDoc('ACME Pvt Ltd\nTAX INVOICE\nInvoice No: 42') // invoice/purchase high
  const res = acceptAiClassification({ documentType: 'receipt', accountingCategory: 'other' }, rules)
  assert.equal(res.accepted, false)
})

// ===========================================================================
// applyUserClassification: user-confirmed provenance, clears ONLY machine reasons.
// ===========================================================================
test('CL-user: a confirmed re-classification becomes method=user and lifts the machine guard', () => {
  const rules = classifyDoc('PAYMENT VOUCHER / DELIVERY CHALLAN\ntwo titles') // conflict, needsReview
  assert.equal(rules.needsReview, true)
  const r = applyUserClassification(rules, { documentType: 'invoice', accountingCategory: 'purchase' })
  assert.equal(r.method, 'user')
  assert.equal(r.documentType, 'invoice')
  assert.equal(r.confidence, 'high')
  assert.equal(r.needsReview, false)
  assert.ok(!r.reviewReasons.includes('document-heading-conflict'))
})

test('CL-user: leaving a value unknown keeps the row in review (never a fake resolve)', () => {
  const rules = classifyDoc('no heading at all here, just numbers 999')
  const r = applyUserClassification(rules, { documentType: 'unknown', accountingCategory: 'unknown' })
  assert.equal(r.method, 'user')
  assert.equal(r.confidence, 'low')
  assert.equal(r.needsReview, true)
  assert.ok(r.reviewReasons.includes('category-could-not-be-determined'))
})

// ===========================================================================
// SOURCE CONTRACT — the wiring the harness cannot import.
// ===========================================================================
const extractSrc = () => readFileSync(new URL('../lib/jobs/handlers/extract-invoice.ts', import.meta.url), 'utf8')
const extractorSrc = () => readFileSync(new URL('../lib/ocr/invoice-extractor.ts', import.meta.url), 'utf8')
const reviewSrc = () => readFileSync(new URL('../lib/invoices/review.ts', import.meta.url), 'utf8')
const editorSrc = () => readFileSync(new URL('../lib/whatsapp/review-edit.ts', import.meta.url), 'utf8')

test('CL-wire: the extractor surfaces the local raw text as rawText (never for the AI read)', () => {
  const src = extractorSrc()
  assert.match(src, /rawText\?:\s*string/, 'InvoiceExtractionResult must expose rawText')
  assert.match(src, /rawText:\s*localText/, 'the final result carries the local text only')
  assert.match(src, /localText\s*=\s*local\.text/, 'extractLocal text is captured into localText')
})

test('CL-wire: extract-invoice classifies and folds an ADDITIVE review gate + persists the sibling', () => {
  const src = extractSrc()
  assert.match(src, /import \{ classifyDocument, headingRegion \} from '@\/lib\/ocr\/classify'/, 'classify engine imported')
  assert.match(src, /const classification = classifyDocument\(/, 'runs the classifier per invoice')
  // additive only: it forces needs_review, never approves.
  assert.match(src, /if \(classification\.needsReview\)[\s\S]*?evaluation\.review = 'needs_review'/)
  assert.match(src, /_classification:\s*classification/, 'persisted as an encrypted sibling')
  // metadata must never overwrite the canonical row: it is a sibling key after ...evaluation.row
  assert.match(src, /\.\.\.evaluation\.row,[\s\S]*?_classification:/)
})

test('CL-wire: review.ts makes _classification a first-class sibling that survives edits', () => {
  const src = reviewSrc()
  assert.match(src, /const CLASSIFICATION_KEY = '_classification'/)
  // split out of the candidate on read so it can never merge as invoice data …
  assert.match(src, /\[CLASSIFICATION_KEY\]: classRaw, \.\.\.candidate/)
  // … and re-attached on write, so a correction/approval never drops it.
  assert.match(src, /if \(classification\) payload\[CLASSIFICATION_KEY\] = classification/)
  // its review guard is re-folded ADDITIVELY on every re-score.
  assert.match(src, /function foldClassificationGuard\(/)
  assert.match(src, /review = foldClassificationGuard\(/)
  // a user-confirmed patch goes through applyUserClassification (never raw coercion).
  assert.match(src, /applyUserClassification\(/)
})

test('CL-wire: parseReviewCorrections validates classification enums and rejects out-of-enum', () => {
  const src = reviewSrc()
  assert.match(src, /if \(!isDocTypeFull\(c\.documentType\)\) errors\.push/)
  assert.match(src, /if \(!isAccountingCategory\(c\.accountingCategory\)\) errors\.push/)
})

test('CL-wire: the review editor explains every classification reason in plain English', () => {
  const src = editorSrc()
  for (const reason of [
    'document-heading-conflict', 'payment-evidence-not-an-invoice',
    'delivery-challan-not-a-tax-invoice', 'proforma-not-a-tax-invoice',
    'category-evidence-conflict', 'category-could-not-be-determined',
  ]) {
    assert.ok(src.includes(`'${reason}'`), `REASON_TEXT missing ${reason}`)
  }
})
