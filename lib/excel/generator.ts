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
  writePurchaseImportSheet(workbook, records);
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as unknown as ArrayBuffer);
}

/**
 * Render the accountant's fixed 12-column purchase-import sheet into an EXISTING
 * workbook (so the single-sheet builder and the three-sheet register share ONE
 * column contract and can never drift). Header order, widths, styling and the
 * null=>blank / 0=>0 / text-@ cell rules are exactly as the standalone importer.
 */
function writePurchaseImportSheet(workbook: ExcelJS.Workbook, records: TallyImportRowInput[]): ExcelJS.Worksheet {
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
  return worksheet;
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
  const ws = check.getWorksheet(TALLY_SHEET_NAME) ?? check.worksheets[0];
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

// ============================================================================
// §Multi-GST-rate register: one workbook, THREE sheets.
//
//   1. `Purchase Register` — EXACTLY one row per invoice. Fixed invoice-identity
//      columns, then a DYNAMIC block of `{rate}% Taxable/CGST/SGST/IGST` columns
//      (only the rates actually present anywhere in the batch, in a deterministic
//      ascending order SHARED by every row), then the invoice-level totals.
//   2. `Tax Breakdown` — one row per invoice PER rate slice. A genuinely unknown
//      cell is left BLANK (never the literal text "null").
//   3. `Purchase Import` — the untouched 12-column Tally contract.
//
// This module receives fully-resolved values only (amounts numeric-or-null, one
// slice per rate, per-slice import lines already ledger-mapped) and renders them;
// it never re-extracts, re-rounds or back-computes a figure, and never adds a
// summary row that a downstream importer could read as a phantom voucher.
// ============================================================================

export const PURCHASE_REGISTER_SHEET_NAME = 'Purchase Register';
export const TAX_BREAKDOWN_SHEET_NAME = 'Tax Breakdown';

// §Part-2b: the register splits into ONE sheet per accounting category. The
// primary sheet keeps its historical name (it is the required sheet the whole
// delivery + integrity contract keys on); every other category rides its own
// clearly-labelled sheet. Ordering is deterministic so a rebuild is byte-stable
// and an accountant always finds purchases first.
const REGISTER_CATEGORY_ORDER = ['purchase', 'expense', 'service', 'fixed_asset', 'capital_purchase', 'sales', 'other', 'unknown'] as const;
const REGISTER_CATEGORY_SHEET: Record<string, string> = {
  purchase: PURCHASE_REGISTER_SHEET_NAME,
  expense: 'Expense Register',
  service: 'Service Register',
  fixed_asset: 'Fixed Asset Register',
  capital_purchase: 'Capital Purchase Register',
  sales: 'Sales Register',
  other: 'Other Register',
  unknown: 'Uncategorised Register',
};
/** A missing/unknown category is the historical default: the primary purchase sheet. */
function normalizeRegisterCategory(value: string | null | undefined): string {
  return value && REGISTER_CATEGORY_SHEET[value] ? value : 'purchase';
}
/** True for any per-category register sheet (all end in " Register"), false for Tax Breakdown / Purchase Import. */
function isRegisterSheetName(name: string): boolean {
  return /\sRegister$/.test(name);
}

/**
 * §3.3 render the machine/human ITC determination as stable, accountant-readable
 * text. An absent/legacy value renders BLANK (never a fabricated 'eligible'); the
 * machine itself only ever produces 'ineligible' or 'needs_review'.
 */
const ITC_ELIGIBILITY_LABEL: Record<string, string> = {
  eligible: 'ITC eligible', ineligible: 'ITC ineligible', needs_review: 'ITC needs review',
};
function itcLabel(value: string | null | undefined): string | null {
  return typeof value === 'string' ? (ITC_ELIGIBILITY_LABEL[value] ?? null) : null;
}

/** One rate/treatment slice as the register renders it (every money is number|null). */
export interface RegisterSliceCell {
  rate_percent: number | null;
  taxable_value: number | null;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  cess_amount?: number | null;
  treatment?: string | null;
  provenance?: string | null;
  confidence?: number | null;
  validation_status?: string | null;
  review_notes?: string | null;
}

/** One invoice for the register: identity + totals + its slices + its import rows. */
export interface RegisterInvoiceInput {
  invoice_date: string | null;
  invoice_number: string | null;
  vendor_name: string | null;
  supplier_gstin: string | null;
  place_of_supply?: string | null;
  document_type?: string | null;
  /**
   * §Part-2b the accounting category this invoice was classified into, so the
   * register can split into one sheet per category. Absent/null is treated as
   * 'purchase' — the historical single-sheet behaviour is the default, and a
   * legacy row (or any row with no machine classification) never lands anywhere
   * but the primary Purchase Register. This only chooses a SHEET; it never
   * touches an amount, a ledger mapping, or the aggregate Tax Breakdown / import.
   */
  accountingCategory?: string | null;
  /**
   * §3.3 the ITC-eligibility determination for this invoice (eligible / ineligible /
   * needs_review). DESCRIPTIVE ONLY: it never filters the row out of the register (§5),
   * it is rendered as one added column on the per-category REGISTER sheets, and the
   * 12-column Purchase Import contract is untouched. Absent/legacy renders blank.
   */
  itcEligibility?: string | null;
  total_taxable_value: number | null;
  total_cgst: number | null;
  total_sgst: number | null;
  total_igst: number | null;
  total_cess?: number | null;
  other_charges?: number | null;
  discount?: number | null;
  round_off?: number | null;
  grand_total: number | null;
  review_status: string | null;
  /** The rate-wise breakdown; empty when the source evidenced none. */
  slices: RegisterSliceCell[];
  /** Already-resolved 12-column import rows for THIS invoice (may be one or many). */
  importRows: TallyImportRowInput[];
}

/** Format a rate for a stable column label: 18 -> "18", 2.5 -> "2.5". */
function rateLabel(rate: number): string {
  return String(Number(rate.toFixed(2)))
}

const REGISTER_FIXED_HEADERS = [
  'Invoice Date', 'Invoice No', 'Supplier Name', 'Supplier GSTIN', 'Place of Supply', 'Document Type',
] as const;
const REGISTER_TOTAL_HEADERS = [
  'Total Taxable Value', 'Total CGST', 'Total SGST', 'Total IGST', 'Total Cess',
  'Other Charges', 'Discount', 'Round Off', 'Grand Total', 'Review/Validation Status',
  'ITC Eligibility',
] as const;
const BREAKDOWN_HEADERS = [
  'Invoice Date', 'Invoice No', 'Supplier Name', 'Supplier GSTIN', 'Tax Rate', 'Tax Treatment',
  'Taxable Value', 'CGST', 'SGST', 'IGST', 'Cess', 'Source/Provenance', 'Validation Status', 'Review Notes',
] as const;

/**
 * The deterministic per-rate column schema for a whole workbook: the union of
 * every distinct numeric rate (INCLUDING a nil 0%) across all invoices, sorted
 * ascending. Every row uses this SAME set, so an invoice that omits a rate just
 * leaves those cells blank rather than shifting the columns.
 */
export function rateColumnSchema(invoices: readonly RegisterInvoiceInput[]): number[] {
  const rates = new Set<number>()
  for (const inv of invoices) {
    for (const s of inv.slices) {
      if (typeof s.rate_percent === 'number' && Number.isFinite(s.rate_percent) && s.rate_percent >= 0) {
        rates.add(Number(s.rate_percent.toFixed(2)))
      }
    }
  }
  return [...rates].sort((a, b) => a - b)
}

/** True when any invoice carries a taxable slice with NO rate (exempt / nil / non-GST). */
function hasUnratedTaxable(invoices: readonly RegisterInvoiceInput[]): boolean {
  return invoices.some((inv) => inv.slices.some((s) =>
    (s.rate_percent === null || s.rate_percent === undefined)
    && typeof s.taxable_value === 'number' && s.taxable_value > 0))
}

/** The dynamic `{rate}% …` column labels, in the shared deterministic order. */
export function registerDynamicHeaders(rates: readonly number[]): string[] {
  const out: string[] = []
  for (const r of rates) {
    const l = rateLabel(r)
    out.push(`${l}% Taxable Value`, `${l}% CGST`, `${l}% SGST`, `${l}% IGST`)
  }
  return out
}

/** Sum the invoice's slices that carry a given rate (null rate => the nil bucket). */
function sliceSumForRate(slices: readonly RegisterSliceCell[], rate: number | null) {
  let taxable = 0, cgst = 0, sgst = 0, igst = 0
  let any = false
  for (const s of slices) {
    const sRate = (typeof s.rate_percent === 'number' && Number.isFinite(s.rate_percent))
      ? Number(s.rate_percent.toFixed(2)) : null
    if (sRate !== rate) continue
    any = true
    taxable += typeof s.taxable_value === 'number' ? s.taxable_value : 0
    cgst += typeof s.cgst_amount === 'number' ? s.cgst_amount : 0
    sgst += typeof s.sgst_amount === 'number' ? s.sgst_amount : 0
    igst += typeof s.igst_amount === 'number' ? s.igst_amount : 0
  }
  if (!any) return { taxable: null, cgst: null, sgst: null, igst: null }
  return { taxable, cgst, sgst, igst }
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * §Part-2b: render ONE per-category register sheet with the workbook-wide shared
 * column schema. Extracted from `buildRegisterWorkbook` so every category sheet is
 * structurally identical (same headers, widths, styles, freeze + autofilter) and a
 * per-rate column can never shift between categories. An empty category still gets
 * a header row (rowCount 1) so the required primary sheet always exists.
 */
function renderRegisterSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  invoices: readonly RegisterInvoiceInput[],
  rates: readonly number[],
  nilColumn: boolean,
  coreFont: { name: string },
): void {
  const ws = workbook.addWorksheet(sheetName);
  const dynHeaders = registerDynamicHeaders(rates);
  const headers = [...REGISTER_FIXED_HEADERS, ...dynHeaders,
    ...(nilColumn ? ['Exempt/Nil/Non-GST Taxable'] : []), ...REGISTER_TOTAL_HEADERS];
  ws.columns = headers.map((header, i) => ({ header, key: `r${i}`, width: i < 6 ? [12, 18, 30, 18, 16, 14][i] : 15 }));
  ws.getRow(1).eachCell((cell) => {
    cell.font = { ...coreFont, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (const inv of invoices) {
    const row = ws.addRow([]);
    let c = 1;
    writeDateCell(row.getCell(c++), inv.invoice_date);
    writeTextCell(row.getCell(c++), inv.invoice_number);
    writeTextCell(row.getCell(c++), inv.vendor_name);
    writeTextCell(row.getCell(c++), inv.supplier_gstin);
    writeTextCell(row.getCell(c++), inv.place_of_supply ?? null);
    writeTextCell(row.getCell(c++), inv.document_type ?? null);
    for (const rate of rates) {
      const sum = sliceSumForRate(inv.slices, rate);
      writeNumberCell(row.getCell(c++), sum.taxable === null ? null : r2(sum.taxable), MONEY_FMT);
      writeNumberCell(row.getCell(c++), sum.cgst === null ? null : r2(sum.cgst), MONEY_FMT);
      writeNumberCell(row.getCell(c++), sum.sgst === null ? null : r2(sum.sgst), MONEY_FMT);
      writeNumberCell(row.getCell(c++), sum.igst === null ? null : r2(sum.igst), MONEY_FMT);
    }
    if (nilColumn) {
      const nil = sliceSumForRate(inv.slices, null);
      writeNumberCell(row.getCell(c++), nil.taxable === null ? null : r2(nil.taxable), MONEY_FMT);
    }
    writeNumberCell(row.getCell(c++), inv.total_taxable_value, MONEY_FMT);
    writeNumberCell(row.getCell(c++), inv.total_cgst, MONEY_FMT);
    writeNumberCell(row.getCell(c++), inv.total_sgst, MONEY_FMT);
    writeNumberCell(row.getCell(c++), inv.total_igst, MONEY_FMT);
    writeNumberCell(row.getCell(c++), inv.total_cess ?? null, MONEY_FMT);
    writeNumberCell(row.getCell(c++), inv.other_charges ?? null, MONEY_FMT);
    writeNumberCell(row.getCell(c++), inv.discount ?? null, MONEY_FMT);
    writeNumberCell(row.getCell(c++), inv.round_off ?? null, MONEY_FMT);
    writeNumberCell(row.getCell(c++), inv.grand_total, MONEY_FMT);
    writeTextCell(row.getCell(c++), inv.review_status ?? null);
    writeTextCell(row.getCell(c++), itcLabel(inv.itcEligibility));
    row.eachCell((cell) => { if (!cell.font) cell.font = coreFont; });
  }
  ws.views = [{ showGridLines: true, state: 'frozen', xSplit: 2, ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
}

/**
 * Build the accountant's register. Its detail sheets are derived from the SAME
 * validated invoice set, so the Purchase Register (one row/invoice, split per
 * accounting category — §Part-2b), the Tax Breakdown (one row/slice) and the
 * Purchase Import (resolved rows) can never disagree with one another or
 * double-count an invoice. The per-category split is DISPLAY only: every invoice
 * still appears exactly once across the register sheets, and the Tax Breakdown
 * and 12-column Purchase Import stay aggregate so the Tally import contract is
 * byte-for-byte unchanged.
 */
export async function buildRegisterWorkbook(invoices: RegisterInvoiceInput[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const coreFont = { name: 'Segoe UI' };
  const rates = rateColumnSchema(invoices);
  const nilColumn = hasUnratedTaxable(invoices);

  // ---- Sheet(s) 1: one register sheet per accounting category ----------------
  // §Part-2b: purchases stay on the primary "Purchase Register"; each other
  // present category rides its own clearly-named sheet. The primary sheet ALWAYS
  // exists (the integrity + delivery contract requires it), even for a batch that
  // happens to hold no purchase-category row. The shared `rates`/`nilColumn` keep
  // every register sheet on one identical column schema.
  const byCategory = new Map<string, RegisterInvoiceInput[]>();
  for (const inv of invoices) {
    const cat = normalizeRegisterCategory(inv.accountingCategory);
    const bucket = byCategory.get(cat);
    if (bucket) bucket.push(inv); else byCategory.set(cat, [inv]);
  }
  renderRegisterSheet(workbook, PURCHASE_REGISTER_SHEET_NAME, byCategory.get('purchase') ?? [], rates, nilColumn, coreFont);
  for (const cat of REGISTER_CATEGORY_ORDER) {
    if (cat === 'purchase') continue;
    const bucket = byCategory.get(cat);
    if (bucket && bucket.length > 0) {
      renderRegisterSheet(workbook, REGISTER_CATEGORY_SHEET[cat], bucket, rates, nilColumn, coreFont);
    }
  }

  // ---- Sheet 2: Tax Breakdown (one row per invoice per slice) ----------------
  const bd = workbook.addWorksheet(TAX_BREAKDOWN_SHEET_NAME);
  bd.columns = BREAKDOWN_HEADERS.map((header, i) => ({ header, key: `b${i}`, width: i < 4 ? [12, 18, 30, 18][i] : 15 }));
  bd.getRow(1).eachCell((cell) => {
    cell.font = { ...coreFont, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (const inv of invoices) {
    const rows = inv.slices.length > 0 ? inv.slices : [null];
    for (const s of rows) {
      const row = bd.addRow([]);
      writeDateCell(row.getCell(1), inv.invoice_date);
      writeTextCell(row.getCell(2), inv.invoice_number);
      writeTextCell(row.getCell(3), inv.vendor_name);
      writeTextCell(row.getCell(4), inv.supplier_gstin);
      if (s === null) {
        writeTextCell(row.getCell(14), 'no rate-wise breakdown evidenced');
      } else {
        writeNumberCell(row.getCell(5), s.rate_percent, RATE_FMT);
        writeTextCell(row.getCell(6), s.treatment ?? null);
        writeNumberCell(row.getCell(7), s.taxable_value, MONEY_FMT);
        writeNumberCell(row.getCell(8), s.cgst_amount, MONEY_FMT);
        writeNumberCell(row.getCell(9), s.sgst_amount, MONEY_FMT);
        writeNumberCell(row.getCell(10), s.igst_amount, MONEY_FMT);
        writeNumberCell(row.getCell(11), s.cess_amount ?? null, MONEY_FMT);
        writeTextCell(row.getCell(12), s.provenance ?? null);
        writeTextCell(row.getCell(13), s.validation_status ?? null);
        writeTextCell(row.getCell(14), s.review_notes ?? null);
      }
      row.eachCell((cell) => { if (!cell.font) cell.font = coreFont; });
    }
  }
  bd.views = [{ showGridLines: true, state: 'frozen', ySplit: 1 }];
  bd.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: BREAKDOWN_HEADERS.length } };

  // ---- Sheet 3: Purchase Import (existing 12-column contract) ----------------
  const importRows = invoices.flatMap((inv) => inv.importRows);
  writePurchaseImportSheet(workbook, importRows);

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as unknown as ArrayBuffer);
}

/** Row counts a register workbook must contain to be considered intact. */
export interface RegisterWorkbookCounts {
  invoiceCount: number;
  taxBreakdownRowCount: number;
  importRowCount: number;
}

/** The number of Tax Breakdown rows a set of invoices produces (>=1 per invoice). */
export function expectedTaxBreakdownRowCount(invoices: readonly RegisterInvoiceInput[]): number {
  return invoices.reduce((n, inv) => n + (inv.slices.length > 0 ? inv.slices.length : 1), 0);
}

/**
 * Reopen a freshly built register and fail CLOSED unless it is a genuine .xlsx
 * with EXACTLY the three required sheets, the intact 12-column Purchase Import
 * header, and the precise row counts (no phantom summary row, no dropped invoice
 * or slice). It never logs any row value — only the structural failure reason.
 */
export async function validateRegisterWorkbook(buf: Buffer, counts: RegisterWorkbookCounts): Promise<void> {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new Error('WORKBOOK_INVALID: missing ZIP/OOXML signature');
  }
  const check = new ExcelJS.Workbook();
  try {
    await check.xlsx.load(buf as unknown as Parameters<typeof check.xlsx.load>[0]);
  } catch {
    throw new Error('WORKBOOK_INVALID: buffer is not a parseable workbook');
  }
  const reg = check.getWorksheet(PURCHASE_REGISTER_SHEET_NAME);
  const bd = check.getWorksheet(TAX_BREAKDOWN_SHEET_NAME);
  const imp = check.getWorksheet(TALLY_SHEET_NAME);
  if (!reg) throw new Error('WORKBOOK_INVALID: "Purchase Register" worksheet is missing');
  if (!bd) throw new Error('WORKBOOK_INVALID: "Tax Breakdown" worksheet is missing');
  if (!imp) throw new Error('WORKBOOK_INVALID: "Purchase Import" worksheet is missing');

  if (String(reg.getRow(1).getCell(1).text).trim() !== 'Invoice Date') {
    throw new Error('WORKBOOK_INVALID: Purchase Register header row did not render');
  }
  // §Part-2b: the register may span one sheet per accounting category. Every
  // invoice must appear EXACTLY once across ALL register sheets (name ends in
  // " Register") — never lost to a bucket, never duplicated into two. Summing the
  // data rows across those sheets and comparing to the total invoice count proves
  // the split is faithful, while the Tax Breakdown / import stay aggregate below.
  let registerRows = 0;
  for (const sheet of check.worksheets) {
    if (!isRegisterSheetName(sheet.name)) continue;
    if (String(sheet.getRow(1).getCell(1).text).trim() !== 'Invoice Date') {
      throw new Error(`WORKBOOK_INVALID: "${sheet.name}" header row did not render`);
    }
    registerRows += Math.max(0, sheet.rowCount - 1);
  }
  if (registerRows !== counts.invoiceCount) {
    throw new Error(`WORKBOOK_INVALID: register sheets expected ${counts.invoiceCount} invoice row(s) in total, found ${registerRows}`);
  }
  if (bd.rowCount !== counts.taxBreakdownRowCount + 1) {
    throw new Error(`WORKBOOK_INVALID: Tax Breakdown expected ${counts.taxBreakdownRowCount} slice row(s), found ${bd.rowCount - 1}`);
  }
  if (imp.columnCount !== TALLY_HEADERS.length) {
    throw new Error(`WORKBOOK_INVALID: Purchase Import expected ${TALLY_HEADERS.length} columns, found ${imp.columnCount}`);
  }
  const impHeader = imp.getRow(1);
  for (let i = 0; i < TALLY_HEADERS.length; i += 1) {
    const got = String(impHeader.getCell(i + 1).text ?? '').trim();
    if (got !== TALLY_HEADERS[i]) {
      throw new Error(`WORKBOOK_INVALID: Purchase Import column ${i + 1} header is "${got}" not "${TALLY_HEADERS[i]}"`);
    }
  }
  if (imp.rowCount !== counts.importRowCount + 1) {
    throw new Error(`WORKBOOK_INVALID: Purchase Import expected ${counts.importRowCount} row(s), found ${imp.rowCount - 1}`);
  }
}
