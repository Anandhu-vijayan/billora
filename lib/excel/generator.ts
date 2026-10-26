// lib/excel/generator.ts — the TallyPrime purchase-import workbook profile.
//
// Produces the accountant's 12-column purchase-import sheet from APPROVED,
// already-mapped invoice lines. This module deliberately knows NOTHING about
// OCR, the database, or delivery: it receives fully-resolved `TallyImportRowInput`
// values (amounts numeric-or-null, ledger name resolved-or-null) and renders them.
// Keeping the export transformation here — not scattered through the worker —
// is what lets a future template version be added without touching extraction.
//
// Non-negotiables enforced by the renderer:
//   * Column set + ORDER are fixed by `TALLY_HEADERS` and verified on reopen.
//   * Dates are REAL Excel date cells displayed DD-MM-YYYY (not text), so Tally's
//     importer reads a date, not a string.
//   * Monetary cells are NUMBERS (2dp), tax rate is a NUMBER — never a string.
//   * `null`/`undefined` renders as a BLANK cell. A genuine `0` renders as `0` —
//     zero is never confused with "unknown" (the old GSTR-2B renderer coalesced
//     null to 0; an import sheet must not, or a missing ledger/rate looks valid).
//   * There is NO grand-total / summary row. On an import sheet a trailing total
//     would be parsed as one more voucher. Never add one here.
//   * Free-text columns are written as explicit TEXT ('@'), so a supplier name or
//     invoice number that happens to begin with '=' / '+' is stored literally and
//     can never be interpreted as a formula (no CSV/Excel formula injection).
import ExcelJS from 'exceljs';

/** One fully-resolved import line. Every amount is numeric-or-null; null = blank. */
export interface TallyImportRowInput {
  invoice_date: string | null;
  invoice_number: string | null;
  vendor_name: string | null;
  supplier_gstin: string | null;
  /** Resolved target ledger, or null when unresolved — rendered blank, never guessed. */
  ledger_name: string | null;
  taxable_value: number | null;
  gst_rate_percent: number | null;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  round_off: number | null;
  gross_total: number | null;
}

export const TALLY_SHEET_NAME = 'Purchase Import';

/** The exact 12 headers, in the exact order the accountant's template expects. */
export const TALLY_HEADERS = [
  'Date', 'Invoice No', 'Supplier Name', 'GSTIN', 'Ledger Name', 'Taxable Amount',
  'Tax Rate', 'CGST Amount', 'SGST Amount', 'IGST Amount', 'Round Off', 'Gross Total',
] as const;

const MONEY_FMT = '#,##0.00';
// Up to 2 decimals, no trailing zeros, DISPLAYED with a trailing percent sign:
// 18 -> "18%", 1.5 -> "1.5%", 5 -> "5%". The stored value stays a plain NUMBER
// (18, not 0.18 and not the text "18%"), so Tally's importer reads a numeric rate
// while an accountant eyeballing the sheet sees the % they expect (§user #4).
const RATE_FMT = '0.##"%"';
const DATE_FMT = 'DD-MM-YYYY';

/** Parse a canonical `YYYY-MM-DD` date into a local Date, or null if unparseable. */
function toExcelDate(iso: string | null): Date | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Write a genuine date cell (blank when unresolvable), displayed DD-MM-YYYY. */
function writeDateCell(cell: ExcelJS.Cell, iso: string | null): void {
  const d = toExcelDate(iso);
  if (d) {
    cell.value = d;
    cell.numFmt = DATE_FMT;
  }
  cell.alignment = { horizontal: 'center' };
}

/** Write a literal TEXT cell; blank for null. '@' format blocks formula parsing. */
function writeTextCell(cell: ExcelJS.Cell, value: string | null): void {
  if (value !== null && value !== undefined) {
    cell.value = String(value);
    cell.numFmt = '@';
  }
}

/** Write a NUMBER cell (0 is a real number and is kept); blank for null/undefined. */
function writeNumberCell(cell: ExcelJS.Cell, value: number | null, fmt: string): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    cell.value = value;
    cell.numFmt = fmt;
  }
}

export async function buildTallyImportWorkbook(records: TallyImportRowInput[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(TALLY_SHEET_NAME);
  worksheet.views = [{ showGridLines: true, state: 'frozen', ySplit: 1 }];
  const coreFont = { name: 'Segoe UI' };

  worksheet.columns = TALLY_HEADERS.map((header, i) => ({
    header,
    key: `c${i}`,
    width: [12, 18, 30, 18, 22, 16, 10, 14, 14, 14, 12, 16][i],
  }));

  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { ...coreFont, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  for (const d of records) {
    const row = worksheet.addRow([]);
    writeDateCell(row.getCell(1), d.invoice_date);
    writeTextCell(row.getCell(2), d.invoice_number);
    writeTextCell(row.getCell(3), d.vendor_name);
    writeTextCell(row.getCell(4), d.supplier_gstin);
    writeTextCell(row.getCell(5), d.ledger_name);
    writeNumberCell(row.getCell(6), d.taxable_value, MONEY_FMT);
    writeNumberCell(row.getCell(7), d.gst_rate_percent, RATE_FMT);
    writeNumberCell(row.getCell(8), d.cgst_amount, MONEY_FMT);
    writeNumberCell(row.getCell(9), d.sgst_amount, MONEY_FMT);
    writeNumberCell(row.getCell(10), d.igst_amount, MONEY_FMT);
    writeNumberCell(row.getCell(11), d.round_off, MONEY_FMT);
    writeNumberCell(row.getCell(12), d.gross_total, MONEY_FMT);
    row.eachCell((c) => { if (!c.font) c.font = coreFont; });
  }

  // Deliberately NO summary/total row appended — this sheet is imported as
  // vouchers, and a trailing total would be read as one more voucher.
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as unknown as ArrayBuffer);
}

/**
 * Reopen a freshly generated workbook and prove it is a genuine, structurally
 * correct .xlsx BEFORE it is ever encrypted, stored, or delivered — failing
 * CLOSED so a partial write or an ExcelJS regression requeues the job instead of
 * persisting a register the accountant cannot import. It verifies the ZIP/OOXML
 * signature, the sheet name, the EXACT 12 headers in order, and (when given
 * `expectedRowCount`) that there are precisely that many data rows and no stray
 * extra (e.g. an accidental summary) row. It never logs row data — only the
 * structural failure reason.
 */
export async function validateTallyWorkbook(buf: Buffer, expectedRowCount?: number): Promise<void> {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new Error('WORKBOOK_INVALID: missing ZIP/OOXML signature');
  }
  const check = new ExcelJS.Workbook();
  try {
    // ExcelJS types its own `Buffer` (extends ArrayBuffer); a Node Buffer is
    // accepted at runtime, so bridge the nominal type the writer side also bridges.
    await check.xlsx.load(buf as unknown as Parameters<typeof check.xlsx.load>[0]);
  } catch {
    throw new Error('WORKBOOK_INVALID: buffer is not a parseable workbook');
  }
  const ws = check.worksheets[0];
  if (!ws || ws.name !== TALLY_SHEET_NAME) {
    throw new Error('WORKBOOK_INVALID: expected "Purchase Import" worksheet is missing');
  }
  if (ws.columnCount !== TALLY_HEADERS.length) {
    throw new Error(`WORKBOOK_INVALID: expected ${TALLY_HEADERS.length} columns, found ${ws.columnCount}`);
  }
  const headerRow = ws.getRow(1);
  for (let i = 0; i < TALLY_HEADERS.length; i += 1) {
    const got = String(headerRow.getCell(i + 1).text ?? '').trim();
    if (got !== TALLY_HEADERS[i]) {
      throw new Error(`WORKBOOK_INVALID: column ${i + 1} header is "${got}" not "${TALLY_HEADERS[i]}"`);
    }
  }
  if (ws.rowCount < 1) {
    throw new Error('WORKBOOK_INVALID: header row did not render');
  }
  if (typeof expectedRowCount === 'number' && ws.rowCount !== expectedRowCount + 1) {
    // A count mismatch means a stray row (e.g. a summary that would import as a
    // phantom voucher) or a dropped data row — refuse to persist it.
    throw new Error(`WORKBOOK_INVALID: expected ${expectedRowCount} data row(s), found ${ws.rowCount - 1}`);
  }
}
