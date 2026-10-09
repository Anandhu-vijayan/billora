import ExcelJS from 'exceljs'
interface InvoiceRow {
  invoice_date: string | null
  supplier_name: string | null
  supplier_gstin: string | null
  invoice_number: string | null
  taxable_value: number | null
  cgst: number | null
  sgst: number | null
  igst: number | null
  cess: number | null
  invoice_total: number | null
  file_ref: string
}
export async function generatePurchaseWorkbook(rows: InvoiceRow[], periodLabel: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Billora'
  const ws = wb.addWorksheet(`Purchase - ${periodLabel}`)
  ws.columns = [
    { header: 'Invoice Date', key: 'invoice_date', width: 14 },
    { header: 'Supplier Name', key: 'supplier_name', width: 30 },
    { header: 'GSTIN', key: 'supplier_gstin', width: 18 },
    { header: 'Invoice Number', key: 'invoice_number', width: 20 },
    { header: 'Taxable Value', key: 'taxable_value', width: 15, style: { numFmt: '#,##0.00' } },
    { header: 'CGST', key: 'cgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'SGST', key: 'sgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'IGST', key: 'igst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Cess', key: 'cess', width: 10, style: { numFmt: '#,##0.00' } },
    { header: 'Invoice Total', key: 'invoice_total', width: 15, style: { numFmt: '#,##0.00' } },
    { header: 'File Ref', key: 'file_ref', width: 20 },
  ]
  const headerRow = ws.getRow(1)
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } }
  headerRow.commit()
  for (const r of rows) {
    ws.addRow({
      invoice_date: r.invoice_date ? new Date(r.invoice_date) : null,
      supplier_name: r.supplier_name,
      supplier_gstin: r.supplier_gstin,
      invoice_number: r.invoice_number,
      taxable_value: r.taxable_value,
      cgst: r.cgst,
      sgst: r.sgst,
      igst: r.igst,
      cess: r.cess,
      invoice_total: r.invoice_total,
      file_ref: r.file_ref
    })
  }
  const totalRow = ws.getRow(ws.rowCount + 1)
  totalRow.getCell(1).value = 'TOTAL'
  totalRow.getCell(5).value = { formula: `SUM(E2:E${ws.rowCount})` } as any
  totalRow.getCell(6).value = { formula: `SUM(F2:F${ws.rowCount})` } as any
  totalRow.getCell(7).value = { formula: `SUM(G2:G${ws.rowCount})` } as any
  totalRow.getCell(8).value = { formula: `SUM(H2:H${ws.rowCount})` } as any
  totalRow.getCell(10).value = { formula: `SUM(J2:J${ws.rowCount})` } as any
  totalRow.font = { bold: true }
  totalRow.commit()
  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer as ArrayBuffer)
}
export function formatPeriodLabel(date: Date): string {
  return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}
