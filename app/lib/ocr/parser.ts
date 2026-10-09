import ExcelJS from 'exceljs';

export interface FinalLedgerRecord {
  invoice_date: string;
  invoice_number: string;
  vendor_name: string;
  net_amount: number;
  tax_amount: number;
  total_amount: number;
}

export async function compileExcelWorkbookBuffer(
  records: FinalLedgerRecord[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Purchase Register');
  
  worksheet.views = [{ showGridLines: true }];

  const fontConfig = { name: 'Segoe UI' };
  const headers = [
    { header: 'Invoice Date', key: 'invoice_date', width: 15 },
    { header: 'Invoice Number', key: 'invoice_number', width: 20 },
    { header: 'Supplier Name', key: 'vendor_name', width: 35 },
    { header: 'Taxable Base Value', key: 'net_amount', width: 20 },
    { header: 'Calculated GST', key: 'tax_amount', width: 18 },
    { header: 'Total Value', key: 'total_amount', width: 20 }
  ];

  worksheet.columns = headers;

  // Format Header Band Row
  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { ...fontConfig, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  // Hydrate Data Lines
  records.forEach((rec) => {
    const row = worksheet.addRow({
      invoice_date: rec.invoice_date,
      invoice_number: rec.invoice_number,
      vendor_name: rec.vendor_name,
      net_amount: Number(rec.net_amount || 0),
      tax_amount: Number(rec.tax_amount || 0),
      total_amount: Number(rec.total_amount || 0)
    });

    row.getCell('invoice_date').alignment = { horizontal: 'center' };
    row.getCell('net_amount').numberFormat = '#,##0.00';
    row.getCell('tax_amount').numberFormat = '#,##0.00';
    row.getCell('total_amount').numberFormat = '#,##0.00';
    
    row.eachCell((c) => { c.font = fontConfig; });
  });

  // Format Dynamic Aggregations Row
  const lastRowIdx = worksheet.lastRow ? worksheet.lastRow.number : 1;
  const summaryRowIdx = lastRowIdx + 1;
  const summaryRow = worksheet.getRow(summaryRowIdx);

  summaryRow.getCell(3).value = 'Total';
  summaryRow.getCell(3).font = { ...fontConfig, bold: true };
  summaryRow.getCell(3).alignment = { horizontal: 'right' };

  ['D', 'E', 'F'].forEach((col) => {
    const cell = summaryRow.getBufferCell ? summaryRow.getCell(col) : summaryRow.getCell(col);
    cell.value = { formula: `=SUM(${col}2:${col}${lastRowIdx})`, date1904: false };
    cell.font = { ...fontConfig, bold: true };
    cell.numberFormat = '#,##0.00';
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'double', color: { argb: 'FF000000' } }
    };
  });

  return workbook.xlsx.writeBuffer() as Promise<Buffer>;
}
