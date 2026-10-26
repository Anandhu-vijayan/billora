// §P3-16 credit / debit notes. Two layers:
//   (1) PURE detection + carry-through, run IN-PROCESS:
//       - text-parser.detectDocumentType reads a note ONLY from its printed TITLE
//         (never a bare "credit" in payment terms), returns the right type, and
//         parseInvoiceText tags a note but leaves a plain invoice untouched;
//       - evaluateLedger carries row.document_type and stays INFORMATIONAL (it does
//         NOT add a review reason, so the human review path is never permanently
//         blocked on a note the machine flagged);
//       - mergeCandidates preserves a locally-detected note type across an AI merge
//         (the AI schema never returns it).
//   (2) WIRING is a SOURCE-CONTRACT: the extraction HANDLER forces a note to
//       needs_review (never auto-approved) and records 'credit-debit-note'; that
//       code maps to plain English; and nothing relaxes the negative-amount hard
//       trigger. The full "export a note as a negative, typed voucher" flow is a
//       documented hard block (the editor forbids negative required amounts and the
//       fixed 12-column profile has no voucher-type column).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importTs } from '../scripts/_ts-import.mjs'

const textParser = await importTs('lib/ocr/text-parser.ts')
const ledger = await importTs('lib/ocr/ledger.ts')

const handlerSrc = () => readFileSync(new URL('../lib/jobs/handlers/extract-invoice.ts', import.meta.url), 'utf8')
const reviewSrc = () => readFileSync(new URL('../lib/whatsapp/review-edit.ts', import.meta.url), 'utf8')

const BASE = {
  invoice_date: '05/09/2026', invoice_number: 'INV-42', vendor_name: 'Acme Traders Pvt Ltd',
  supplier_gstin: '27AAPFU0939F1ZV', taxable_value: 1000, cgst_amount: 90, sgst_amount: 90,
  igst_amount: 0, total_amount: 1180,
}

// ---- (1a) title-only detection ----------------------------------------------
test('P3-16 detectDocumentType reads a note only from its title', () => {
  assert.equal(textParser.detectDocumentType('CREDIT NOTE\nRef: invoice INV-42'), 'credit_note')
  assert.equal(textParser.detectDocumentType('Invoice\nDEBIT NOTE No DN-7'), 'debit_note')
  assert.equal(textParser.detectDocumentType('TAX INVOICE\nAcme Traders'), 'invoice')
})

test('P3-16 detectDocumentType never false-positives on a bare "credit"/"debit" word', () => {
  // Payment terms / ledger words that are NOT a note title must stay 'invoice'.
  assert.equal(textParser.detectDocumentType('Terms: payment on credit, 30 days'), 'invoice')
  assert.equal(textParser.detectDocumentType('Debit card surcharge applies'), 'invoice')
})

test('P3-16 detectDocumentType resolves a combined heading by first token (informational)', () => {
  assert.equal(textParser.detectDocumentType('CREDIT / DEBIT NOTE'), 'credit_note', 'credit token appears first')
  assert.equal(textParser.detectDocumentType('DEBIT / CREDIT NOTE'), 'debit_note', 'debit token appears first')
})

// ---- (1b) the parser tags a note, leaves a plain invoice untouched ----------
test('P3-16 parseInvoiceText sets document_type only for a note', () => {
  const noteText = ['CREDIT NOTE', 'Invoice No: CN-1', 'Date: 05/09/2026',
    'Supplier: Acme Traders Pvt Ltd', 'GSTIN: 27AAPFU0939F1ZV',
    'Taxable Value: 1000', 'CGST 90', 'SGST 90', 'Grand Total 1180'].join('\n')
  assert.equal(textParser.parseInvoiceText(noteText).document_type, 'credit_note')
  // A plain invoice leaves the field absent, so stored payloads stay lean (§common case).
  const plainText = ['TAX INVOICE', 'Invoice No: INV-42', 'Date: 05/09/2026',
    'Supplier: Acme Traders Pvt Ltd', 'GSTIN: 27AAPFU0939F1ZV',
    'Taxable Value: 1000', 'CGST 90', 'SGST 90', 'Grand Total 1180'].join('\n')
  assert.equal(textParser.parseInvoiceText(plainText).document_type, undefined)
})

// ---- (1c) evaluateLedger carries the type but stays informational ----------
test('P3-16 evaluateLedger defaults row.document_type to invoice and adds NO note reason', () => {
  const ev = ledger.evaluateLedger({ ...BASE }, { minConfidence: 0.8 })
  assert.equal(ev.row.document_type, 'invoice', 'a plain candidate is an invoice')
  assert.ok(!ev.reasons.includes('credit-debit-note'), 'evaluateLedger never invents a note reason')
})

test('P3-16 evaluateLedger carries a detected note type WITHOUT forcing its own reason (human path stays unblocked)', () => {
  const ev = ledger.evaluateLedger({ ...BASE, document_type: 'credit_note' }, { minConfidence: 0.8 })
  assert.equal(ev.row.document_type, 'credit_note', 'the stored row is self-describing')
  assert.ok(!ev.reasons.includes('credit-debit-note'),
    'the shared re-scorer must not force review on type, or a human could never approve a corrected note')
})

test('P3-16 a NEGATIVE total on a note is STILL a hard review trigger (type never relaxes the amount gate)', () => {
  const ev = ledger.evaluateLedger({ ...BASE, total_amount: -1180, document_type: 'credit_note' }, { minConfidence: 0.8 })
  assert.ok(ev.reasons.includes('negative-amount'), 'negatives stay flagged regardless of document type')
  assert.equal(ev.review, 'needs_review', 'a negative note is never auto-approved')
})

// ---- (1d) merge preserves the locally-detected type ------------------------
test('P3-16 mergeCandidates keeps a local note type when the AI candidate reports none', () => {
  const local = { ...BASE, document_type: 'debit_note' }
  const ai = { ...BASE } // AI schema never returns document_type
  assert.equal(ledger.mergeCandidates(local, ai).document_type, 'debit_note')
  // And a note on an otherwise-equal invoice-only primary is not silently dropped.
  assert.equal(ledger.mergeCandidates(ai, local).document_type, 'debit_note', 'fallback type is not lost either')
})

// ---- (2) wiring -------------------------------------------------------------
test('P3-16 the extraction handler forces a note to review and records the reason', () => {
  const h = handlerSrc()
  assert.ok(h.includes("const documentType = evaluation.row.document_type ?? 'invoice'"), 'reads the carried type defensively')
  assert.ok(h.includes('if (documentType !== \'invoice\') {'), 'routes a non-invoice document to review')
  assert.ok(h.includes("if (evaluation.review === 'approved') evaluation.review = 'needs_review'"), 'a note is never auto-approved')
  assert.ok(h.includes("'credit-debit-note'"), 'records the machine reason')
})

test('P3-16 credit-debit-note maps to a plain-English review reason', () => {
  assert.match(reviewSrc(), /'credit-debit-note': '/)
})
