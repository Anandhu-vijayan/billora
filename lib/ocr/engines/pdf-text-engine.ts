// lib/ocr/engines/pdf-text-engine.ts — the wired LOCAL engine adapter.
//
// This is the concrete LocalEngineAdapter the hybrid pipeline registers: it
// turns a digital PDF's real text layer (lib/ocr/pdf.ts) into a deterministic
// LedgerCandidate (lib/ocr/text-parser.ts). It is deliberately honest:
//   * a PDF with a usable text layer -> a parsed candidate (which ledger.ts then
//     independently scores);
//   * a scanned / image-only PDF (no text layer), or a bare image upload -> null
//     (NO local OCR here). The caller then either rasterizes + calls the gated AI
//     or, with AI disabled, routes to needs_review. It never guesses fields.
//
// Registration is done by the worker bootstrap (handlers/index) so the pure
// lib/ocr/local.ts seam stays dependency-free and unit-testable in isolation.
import { parseInvoiceText, hasMeaningfulText } from '@/lib/ocr/text-parser'
import { extractPdfTextLayer } from '@/lib/ocr/pdf'
import type { LocalEngineAdapter } from '@/lib/ocr/local'
import type { LedgerCandidate } from '@/lib/ocr/ledger'

const PDF_MIME = /^application\/pdf$/i

/** The one local engine we ship a real implementation for: PDF text layer. */
export function createPdfTextEngine(): LocalEngineAdapter {
  return {
    id: 'pdfjs-text',
    async extract({ buffer, mimeType }): Promise<LedgerCandidate | null> {
      // Only digital PDFs have a text layer to read locally. Images and any
      // other type are NOT locally processable here -> null (never a guess).
      if (!PDF_MIME.test(mimeType ?? '')) return null
      const text = await extractPdfTextLayer(buffer)
      if (!hasMeaningfulText(text)) return null // scanned / blank layer
      const candidate = parseInvoiceText(text)
      // An empty parse (no field located at all) is not a candidate.
      const hasAny = candidate.invoice_number || candidate.invoice_date
        || candidate.supplier_gstin || candidate.vendor_name
        || candidate.total_amount
      return hasAny ? candidate : null
    },
  }
}
