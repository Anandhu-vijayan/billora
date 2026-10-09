// lib/ocr/parser.ts
import ExcelJS from 'exceljs';
import { GoogleGenAI, Type } from '@google/genai';
import { logger } from '@/lib/logger';

export interface StructuralColumnMap {
  canonicalField: string;
  matchedSourceHeader: string;
  columnIndex: number;
  confidenceScore: number;
  resolutionPath: 'LOCAL_DETERMINISTIC' | 'AI_RECOVERED' | 'UNRESOLVED';
}

export interface ProcessingMetricsOutput {
  anonymizedHeaders: string[];
  exactTransactionRowsCount: number;
  fieldMappings: Record<string, StructuralColumnMap>;
  taxableBaseAggregationFormula: string;
}

export class SecureComplianceParser {
  private indianHeaderAliases: Record<string, string[]> = {
    supplier_gstin: ['GSTIN', 'SUPPLIER GSTIN', 'GSTIN OF SUPPLIER', 'UIN', 'SUPPLIER ID'],
    invoice_number: ['INVOICE NUMBER', 'INVOICE NO', 'INV NO', 'BILL NO', 'DOCUMENT NO'],
    invoice_date: ['INVOICE DATE', 'INV DATE', 'DATE OF INVOICE', 'BILL DATE', 'DOC DATE'],
    taxable_value: ['TAXABLE VALUE', 'TAXABLE AMOUNT', 'NET AMOUNT', 'TAXABLE AMT', 'ASSESSABLE VALUE']
  };

  private getAiClient(): GoogleGenAI | null {
    if (!process.env.GEMINI_API_KEY) return null;
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  /** Scans schemas locally; never sends customer rows to third-party endpoints. */
  public async parseWorkbookArchitecture(fileBuffer: Buffer | ArrayBuffer): Promise<ProcessingMetricsOutput> {
    const workbook = new ExcelJS.Workbook();
    const input = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
    // exceljs types pin an older Buffer; cast through unknown for Node 20+ Buffer compat.
    await workbook.xlsx.load(input as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const targetSheet = workbook.worksheets.find(ws => {
      const name = ws.name.toUpperCase();
      return !name.includes('SUMMARY') && !name.includes('READ ME') && !name.includes('INSTRUCTIONS');
    }) || workbook.worksheets[0];
    if (!targetSheet) throw new Error('UNSUPPORTED_EXCEL_LAYOUT: Workbook has no worksheets.');
    let headerRowIndex = -1;
    let rawHeaders: string[] = [];
    for (let i = 1; i <= Math.min(targetSheet.rowCount, 20); i++) {
      const row = targetSheet.getRow(i);
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      const cells = vals.map(v => this.cellToText(v));
      const hit = cells.some(v => v.toUpperCase().includes('GSTIN') || v.toUpperCase().includes('INVOICE'));
      if (hit) { headerRowIndex = i; rawHeaders = cells.filter(v => v.trim() !== ''); break; }
    }
    if (headerRowIndex === -1) throw new Error('UNSUPPORTED_EXCEL_LAYOUT: No transaction headers.');
    const anonymizedHeaders = rawHeaders.map(h => h.replace(/[^a-zA-Z0-9_\s%]/g, '').trim());
    const fieldMappings: Record<string, StructuralColumnMap> = {};
    const unmappedFields: string[] = [];
    for (const [field, aliases] of Object.entries(this.indianHeaderAliases)) {
      const idx = anonymizedHeaders.findIndex(h =>
        aliases.some(a => h.toUpperCase() === a || h.toUpperCase().includes(a)));
      if (idx !== -1) {
        fieldMappings[field] = { canonicalField: field, matchedSourceHeader: rawHeaders[idx],
          columnIndex: idx, confidenceScore: 1.0, resolutionPath: 'LOCAL_DETERMINISTIC' };
      } else unmappedFields.push(field);
    }
    if (unmappedFields.length > 0 && process.env.GEMINI_API_KEY) {
      try {
        const fixes = await this.resolveAmbiguitiesViaAi(anonymizedHeaders, unmappedFields);
        for (const f of fixes) {
          const oi = anonymizedHeaders.indexOf(f.mappedHeader);
          if (oi !== -1 && !fieldMappings[f.canonicalField]) {
            fieldMappings[f.canonicalField] = { canonicalField: f.canonicalField,
              matchedSourceHeader: rawHeaders[oi], columnIndex: oi,
              confidenceScore: f.confidence, resolutionPath: 'AI_RECOVERED' };
          }
        }
      } catch (e) { logger.error('[Parser Fallback] AI routing interrupted', { error: String(e) }); }
    }
    const taxBuckets = rawHeaders.filter(h => {
      const n = h.toUpperCase();
      return (n.includes('18%') || n.includes('12%') || n.includes('5%') || n.includes('TAXABLE'))
        && !n.includes('TOTAL') && !n.includes('GST');
    });
    return { anonymizedHeaders, exactTransactionRowsCount: targetSheet.rowCount - headerRowIndex,
      fieldMappings, taxableBaseAggregationFormula: taxBuckets.length > 0
        ? taxBuckets.map(c => `[${c}]`).join(' + ') : '[Taxable Value]' };
  }

  private cellToText(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      const r = v as { text?: unknown; result?: unknown };
      if (typeof r.text === 'string') return r.text;
      if (typeof r.result === 'string' || typeof r.result === 'number') return String(r.result);
      return '';
    }
    return String(v).trim();
  }

  private async resolveAmbiguitiesViaAi(cleanHeaders: string[], missingTargets: string[]) {
    const client = this.getAiClient();
    if (!client) return [];
    const schema = { type: Type.OBJECT,
      properties: { corrections: { type: Type.ARRAY, items: { type: Type.OBJECT,
        properties: { canonicalField: { type: Type.STRING },
          mappedHeader: { type: Type.STRING }, confidence: { type: Type.NUMBER } },
        required: ["canonicalField", "mappedHeader", "confidence"] } } },
      required: ["corrections"] };
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const res = await client.models.generateContent({ model,
      contents: `Map targets ${JSON.stringify(missingTargets)} from headers ${JSON.stringify(cleanHeaders)}.`,
      config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.0 } });
    const parsed = JSON.parse(res.text || '{"corrections":[]}') as
      { corrections?: Array<{ canonicalField: string; mappedHeader: string; confidence: number }> };
    return parsed.corrections || [];
  }
}
