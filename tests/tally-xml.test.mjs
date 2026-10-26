// §P4-17 (TallyPrime XML). The generator is the deliverable; a REAL import into a
// TallyPrime test company is a human verification step this repo cannot run. What
// is proven here is the structural + arithmetic contract that keeps a generated file
// from becoming confidently-wrong books data:
//   * every emitted voucher is a BALANCED double entry (the <AMOUNT> legs sum to 0),
//     so Tally will not reject it and no value is invented to force a tie;
//   * well-formed ENVELOPE/IMPORTDATA structure with one TALLYMESSAGE per voucher;
//   * free text is XML-escaped (no raw & < > " ' can break the document);
//   * an incomplete line is SKIPPED and counted, never emitted as a malformed voucher;
//   * a genuine 0 duty is omitted, the printed gross drives the Round Off leg, and
//     the date renders as Tally's YYYYMMDD.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importTs } from '../scripts/_ts-import.mjs'

const { buildTallyPrimePurchaseXml } = await importTs('lib/exports/tally-xml.ts')

const LINE = {
  invoice_date: '2026-09-05', invoice_number: 'INV-42', vendor_name: 'Acme Traders',
  supplier_gstin: '27AAPFU0939F1ZV', ledger_name: 'Purchase @ 18%',
  taxable_value: 1000, gst_rate_percent: 18, cgst_amount: 90, sgst_amount: 90,
  igst_amount: 0, round_off: 0, gross_total: 1180,
}

/** Split a document into per-voucher chunks (each starts at a TALLYMESSAGE). */
function vouchers(xml) {
  return xml.split('<TALLYMESSAGE').slice(1).map((s) => `<TALLYMESSAGE${s}`)
}
/** The signed <AMOUNT> numbers inside one voucher. */
function amounts(chunk) {
  return [...chunk.matchAll(/<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g)].map((m) => Number(m[1]))
}

test('P4-17 xml: emits a well-formed envelope with one message per valid voucher', () => {
  const r = buildTallyPrimePurchaseXml([LINE, { ...LINE, invoice_number: 'INV-43' }])
  assert.equal(r.voucherCount, 2)
  assert.equal(r.skippedCount, 0)
  assert.ok(r.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'has an XML declaration')
  assert.equal((r.xml.match(/<ENVELOPE>/g) ?? []).length, 1, 'exactly one ENVELOPE')
  assert.ok(r.xml.includes('<TALLYREQUEST>Import Data</TALLYREQUEST>'), 'Import Data request')
  assert.ok(r.xml.includes('<REPORTNAME>Vouchers</REPORTNAME>'), 'voucher report target')
  assert.equal(vouchers(r.xml).length, 2)
  // Every opened ALLLEDGERENTRIESLIST is closed (a stray open tag breaks import).
  assert.equal((r.xml.match(/<ALLLEDGERENTRIESLIST>/g) ?? []).length,
    (r.xml.match(/<\/ALLLEDGERENTRIESLIST>/g) ?? []).length, 'leg tags balanced')
})

test('P4-17 xml: every voucher is a BALANCED double entry (legs sum to zero)', () => {
  const r = buildTallyPrimePurchaseXml([LINE])
  for (const v of vouchers(r.xml)) {
    const sum = amounts(v).reduce((a, b) => a + b, 0)
    assert.equal(Math.round(sum * 100) / 100, 0, `voucher legs balance: ${amounts(v).join(' + ')}`)
  }
})

test('P4-17 xml: maps date/invoice/supplier/purchase ledger and omits a genuine 0 duty', () => {
  const r = buildTallyPrimePurchaseXml([LINE])
  const v = vouchers(r.xml)[0]
  assert.ok(v.includes('<DATE>20260905</DATE>'), 'ISO becomes Tally YYYYMMDD')
  assert.ok(v.includes('<REFERENCE>INV-42</REFERENCE>'), 'invoice number carried as the reference')
  assert.ok(v.includes('<PARTYLEDGERNAME>Acme Traders</PARTYLEDGERNAME>'), 'supplier is the party ledger')
  assert.ok(v.includes('<LEDGERNAME>Purchase @ 18%</LEDGERNAME>'), 'resolved purchase ledger name is used')
  assert.ok(v.includes('<LEDGERNAME>CGST</LEDGERNAME>') && v.includes('<LEDGERNAME>SGST</LEDGERNAME>'), 'non-zero duties present')
  assert.ok(!v.includes('<LEDGERNAME>IGST</LEDGERNAME>'), 'a genuine 0 IGST is never a phantom leg')
  assert.ok(v.includes('<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>') && v.includes('VCHTYPE="Purchase"'), 'purchase voucher type')
})

test('P4-17 xml: a Round Off balancing leg appears when the gross exceeds the components', () => {
  // printed gross 1181 but taxable+duties = 1180 -> a +1.00 Round Off debit ties it.
  const r = buildTallyPrimePurchaseXml([{ ...LINE, gross_total: 1181 }])
  const v = vouchers(r.xml)[0]
  assert.ok(v.includes('<LEDGERNAME>Round Off</LEDGERNAME>'), 'a balancing round-off leg is emitted')
  const sum = amounts(v).reduce((a, b) => a + b, 0)
  assert.equal(Math.round(sum * 100) / 100, 0, 'still perfectly balanced')
})

test('P4-17 xml: free text is escaped so it can never break the document', () => {
  const evil = { ...LINE, vendor_name: 'A & B <Traders> "x"', invoice_number: `INV'1` }
  const r = buildTallyPrimePurchaseXml([evil])
  assert.ok(r.xml.includes('A &amp; B &lt;Traders&gt; &quot;x&quot;'), 'supplier name entities escaped')
  assert.ok(r.xml.includes('INV&apos;1'), 'invoice reference apostrophe escaped')
  // No raw ampersand/angle bracket survives inside a value.
  assert.ok(!/<LEDGERNAME>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/.test(r.xml), 'no unescaped & in a ledger name')
})

test('P4-17 xml: an incomplete line is SKIPPED, never emitted as a malformed voucher', () => {
  const cases = [
    { ...LINE, invoice_date: null },
    { ...LINE, ledger_name: null },        // unresolved ledger => not importable safely
    { ...LINE, taxable_value: null },
    { ...LINE, gross_total: null },
    { ...LINE, vendor_name: '   ' },       // blank is treated as missing
  ]
  const r = buildTallyPrimePurchaseXml(cases)
  assert.equal(r.voucherCount, 0, 'none of the incomplete rows produced a voucher')
  assert.equal(r.skippedCount, cases.length, 'each skip is counted (never silently dropped)')
  assert.equal(r.xml, '', 'an empty register yields no document, not a hollow envelope')
})

test('P4-17 xml: skips only the bad lines and keeps the valid ones', () => {
  const r = buildTallyPrimePurchaseXml([LINE, { ...LINE, invoice_number: null }])
  assert.equal(r.voucherCount, 1)
  assert.equal(r.skippedCount, 1)
})
