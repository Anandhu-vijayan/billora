// lib/exports/tally-xml.ts — a TallyPrime "Purchase" voucher XML importer (§P4-17).
//
// SCOPE + HONESTY: this renders a TallyPrime-compatible XML *Import Data* envelope
// from the SAME fully-resolved `TallyImportRowInput` lines the approved Excel
// register already uses — so it can never introduce a value the workbook did not.
// It is a GENERATOR only: it is deliberately NOT wired into the accountant-facing
// delivery pipeline, because correctness here depends on the tenant's TallyPrime
// ledger masters (the supplier, Purchase, CGST/SGST/IGST and Round Off ledgers must
// exist or be created first) and on a real import test we cannot run from this
// repo. A human MUST import a generated file into a TallyPrime TEST company and
// confirm the vouchers land before this is ever trusted on live books.
//
// Why pure + alias-free: it touches no DB/crypto/ExcelJS (the input type is imported
// as an ERASED `import type`, so exceljs is never loaded at runtime), which keeps it
// unit-testable in-process and lets a future version extend it without touching OCR.
//
// Double-entry rule that keeps every voucher balanced (Tally rejects un-balanced
// vouchers, and we must NEVER fabricate to force a tie):
//   Debit Purchase(taxable) + Debit(CGST/SGST/IGST, each non-zero)
//     + a balancing "Round Off" ledger (gross_total - the sum of the above)
//     = Credit Supplier(gross_total).
// The printed gross total is authoritative; the Round Off leg is the arithmetical
// remainder (standard rounding treatment), never a guessed amount.
import type { TallyImportRowInput } from '../excel/generator'

/** Result of a render: the document plus integrity counts (never any row values). */
export interface TallyXmlResult {
  xml: string
  /** Vouchers actually emitted. */
  voucherCount: number
  /** Lines skipped for being incomplete (never emitted as a malformed voucher). */
  skippedCount: number
}

/** Escape the five XML predefined entities; a null becomes the empty string. */
function esc(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Fixed 2-dp amount with no thousands separator; Tally's own numeric rendering. */
function amt(n: number): string {
  // Round to the paisa first so float noise (e.g. 0.1+0.2) never leaks a long tail.
  const r = Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
  return Object.is(r, -0) ? '0.00' : r.toFixed(2)
}

/** ISO `YYYY-MM-DD` -> Tally `YYYYMMDD`, or null when unparseable. */
function tallyDate(iso: string | null): string | null {
  if (typeof iso !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) return null
  return `${m[1]}${m[2]}${m[3]}`
}

/** A finite number or null; blank/NaN never becomes a fabricated 0. */
function num(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** One `<ALLLEDGERENTRIESLIST>` leg. ISDEEMEDPOSITIVE mirrors the sign of `amount`. */
function ledgerLeg(name: string, amount: number): string {
  const deemed = amount >= 0 ? 'Yes' : 'No'
  return [
    '      <ALLLEDGERENTRIESLIST>',
    `        <LEDGERNAME>${esc(name)}</LEDGERNAME>`,
    `        <ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>`,
    `        <AMOUNT>${amt(amount)}</AMOUNT>`,
    '      </ALLLEDGERENTRIESLIST>',
  ].join('\n')
}

/**
 * Render one voucher, or null when the line is too incomplete to import safely.
 * A missing date, invoice number, supplier, purchase ledger, taxable value or gross
 * total is NOT silently defaulted — it is skipped and counted, so a half-read bill
 * can never become a confidently-wrong voucher in someone's books.
 */
function renderVoucher(d: TallyImportRowInput): { xml: string } | null {
  const date = tallyDate(d.invoice_date)
  const invoiceNumber = d.invoice_number && d.invoice_number.trim() !== '' ? d.invoice_number.trim() : null
  const supplier = d.vendor_name && d.vendor_name.trim() !== '' ? d.vendor_name.trim() : null
  const purchaseLedger = d.ledger_name && d.ledger_name.trim() !== '' ? d.ledger_name.trim() : null
  const taxable = num(d.taxable_value)
  const gross = num(d.gross_total)

  if (date === null || invoiceNumber === null || supplier === null || purchaseLedger === null || taxable === null || gross === null) {
    return null
  }

  const cgst = num(d.cgst_amount) ?? 0
  const sgst = num(d.sgst_amount) ?? 0
  const igst = num(d.igst_amount) ?? 0

  const legs: string[] = []
  // Debit: the purchase (taxable) ledger.
  legs.push(ledgerLeg(purchaseLedger, taxable))
  // Debit: each non-zero duty ledger. A genuine 0 is omitted (never a phantom leg).
  if (cgst !== 0) legs.push(ledgerLeg('CGST', cgst))
  if (sgst !== 0) legs.push(ledgerLeg('SGST', sgst))
  if (igst !== 0) legs.push(ledgerLeg('IGST', igst))
  // Balancing Round Off leg = the remainder so debits tie exactly to the printed gross.
  const roundOffLeg = Math.round((gross - (taxable + cgst + sgst + igst)) * 100) / 100
  if (roundOffLeg !== 0) legs.push(ledgerLeg('Round Off', roundOffLeg))
  // Credit: the supplier for the full printed total. By construction the legs sum
  // to zero (debits = gross = the single credit leg), which is the balance Tally
  // requires; the tests re-derive the sum from the emitted <AMOUNT> nodes.
  legs.push(ledgerLeg(supplier, -gross))

  const head = [
    '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    '      <VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Accounting Voucher View">',
    `        <DATE>${date}</DATE>`,
    `        <EFFECTIVEDATE>${date}</EFFECTIVEDATE>`,
    '        <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>',
    '        <VOUCHERNUMBER></VOUCHERNUMBER>',
    `        <REFERENCE>${esc(invoiceNumber)}</REFERENCE>`,
    `        <PARTYLEDGERNAME>${esc(supplier)}</PARTYLEDGERNAME>`,
    '        <NARRATION>Billora register import</NARRATION>',
  ].join('\n')
  const tail = [
    '      </VOUCHER>',
    '    </TALLYMESSAGE>',
  ].join('\n')

  return { xml: `${head}\n${legs.join('\n')}\n${tail}` }
}

/**
 * Build a TallyPrime XML *Import Data* document of Purchase vouchers from approved
 * register lines. Incomplete lines are skipped (never emitted malformed); balanced
 * lines are wrapped in the standard ENVELOPE/IMPORTDATA/REQUESTDATA structure.
 */
export function buildTallyPrimePurchaseXml(lines: readonly TallyImportRowInput[]): TallyXmlResult {
  const vouchers: string[] = []
  let skippedCount = 0
  for (const line of lines) {
    const v = renderVoucher(line)
    if (v === null) { skippedCount += 1; continue }
    vouchers.push(v.xml)
  }

  if (vouchers.length === 0) {
    return { xml: '', voucherCount: 0, skippedCount }
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '  <HEADER>',
    '    <TALLYREQUEST>Import Data</TALLYREQUEST>',
    '  </HEADER>',
    '  <BODY>',
    '    <IMPORTDATA>',
    '      <REQUESTDESC>',
    '        <REPORTNAME>Vouchers</REPORTNAME>',
    '      </REQUESTDESC>',
    '      <REQUESTDATA>',
    vouchers.join('\n'),
    '      </REQUESTDATA>',
    '    </IMPORTDATA>',
    '  </BODY>',
    '</ENVELOPE>',
    '',
  ].join('\n')

  return { xml, voucherCount: vouchers.length, skippedCount }
}
