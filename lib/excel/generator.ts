// lib/excel/generator.ts
import ExcelJS from 'exceljs';

export interface IndianLedgerRowInput {
  invoice_date: string;
  invoice_number: string;
  vendor_name: string;
  supplier_gstin: string;
  // Amounts arrive null when unknown (never guessed). Only approved rows reach
  // the workbook, and approved inter-state rows legitimately carry null for
  // the unused tax head — the renderer below coalesces those to 0.
  taxable_value: number | null;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  total_amount: number | null;
}

export async function buildComplianceExcelWorkbook(records: IndianLedgerRowInput[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('GSTR-2B Purchase Register');
  worksheet.views = [{ showGridLines: true }];
  const coreFont = { name: 'Segoe UI' };
  worksheet.columns = [
    { header: 'Invoice Date', key: 'invoice_date', width: 14 },
    { header: 'Invoice Number', key: 'invoice_number', width: 18 },
    { header: 'Supplier Name', key: 'vendor_name', width: 32 },
    { header: 'Supplier GSTIN', key: 'supplier_gstin', width: 18 },
    { header: 'Taxable Value', key: 'taxable_value', width: 16 },
    { header: 'CGST Amount', key: 'cgst_amount', width: 14 },
    { header: 'SGST Amount', key: 'sgst_amount', width: 14 },
    { header: 'IGST Amount', key: 'igst_amount', width: 14 },
    { header: 'Total Invoice Value', key: 'total_amount', width: 20 }
  ];
  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { ...coreFont, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  records.forEach((d) => {
    const row = worksheet.addRow({
      invoice_date: d.invoice_date, invoice_number: d.invoice_number,
      vendor_name: d.vendor_name, supplier_gstin: d.supplier_gstin,
      taxable_value: Number(d.taxable_value || 0), cgst_amount: Number(d.cgst_amount || 0),
      sgst_amount: Number(d.sgst_amount || 0), igst_amount: Number(d.igst_amount || 0),
      total_amount: Number(d.total_amount || 0)
    });
    row.getCell('invoice_date').alignment = { horizontal: 'center' };
    row.getCell('supplier_gstin').alignment = { horizontal: 'center' };
    ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount'].forEach((k) => {
      row.getCell(k).numFmt = '#,##0.00';
    });
    row.eachCell((c) => { c.font = coreFont; });
  });
  const finalRowIndex = worksheet.lastRow ? worksheet.lastRow.number : 1;
  const summaryRow = worksheet.getRow(finalRowIndex + 1);
  summaryRow.getCell(4).value = 'Total';
  summaryRow.getCell(4).font = { ...coreFont, bold: true };
  summaryRow.getCell(4).alignment = { horizontal: 'right' };
  ['E', 'F', 'G', 'H', 'I'].forEach((col) => {
    const cell = summaryRow.getCell(col);
    cell.value = { formula: `=SUM(${col}2:${col}${finalRowIndex})`, date1904: false };
    cell.font = { ...coreFont, bold: true };
    cell.numFmt = '#,##0.00';
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'double', color: { argb: 'FF000000' } }
    };
  });
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

/**
 * Reopen a freshly generated workbook and prove it is a genuine, readable
 * .xlsx before it is ever encrypted, stored, or delivered. A "successful"
 * writeBuffer() that returns a nonzero size is NOT proof the bytes are a valid
 * OOXML archive — a truncated/partial write or an ExcelJS regression would
 * otherwise ship a register the customer cannot open (and, once stored, we
 * would claim delivery of a file that does not work). This gate fails CLOSED:
 * any structural problem throws so the caller requeues instead of persisting a
 * bad workbook. It never logs row data — only the failure reason.
 */
export const WORKBOOK_SHEET_NAME = 'GSTR-2B Purchase Register';
export async function validateComplianceWorkbook(buf: Buffer): Promise<void> {
  // A ZIP/OOXML file must start with the local-file-header magic "PK\u{03}\u{04}".
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new Error('WORKBOOK_INVALID: missing ZIP/OOXML signature');
  }
  const check = new ExcelJS.Workbook();
  try {
    // ExcelJS types its own `Buffer` (extends ArrayBuffer); a Node Buffer is
    // accepted at runtime, so bridge the nominal type the same way the writer
    // side bridges `writeBuffer()`'s return.
    await check.xlsx.load(buf as unknown as Parameters<typeof check.xlsx.load>[0]);
  } catch {
    throw new Error('WORKBOOK_INVALID: buffer is not a parseable workbook');
  }
  const ws = check.worksheets[0];
  if (!ws || ws.name !== WORKBOOK_SHEET_NAME) {
    throw new Error('WORKBOOK_INVALID: expected worksheet is missing');
  }
  // The register always renders its 9 headed columns and at least the header row.
  if (ws.columnCount < 9 || ws.rowCount < 1) {
    throw new Error('WORKBOOK_INVALID: header row did not render');
  }
}
