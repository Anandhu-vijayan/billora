// lib/ocr/vision.ts — Gemini Vision invoice extraction (server only).
//
// Selection lives behind EXTRACTION_PROVIDER: `gemini` is the only implemented
// engine (`tesseract` is reserved and throws a permanent config error, so the
// queue settles such a job instead of silently doing nothing). The model is
// pinned to EXTRACTION_VISION_MODEL (default GEMINI_MODEL) and is asked for a
// STRICT JSON object shaped like `LedgerCandidate` (ledger fields + a
// per-field confidence), so downstream review routing in lib/ocr/ledger.ts has
// the signal it needs.
//
// Error taxonomy is what the job queue depends on (rule 3 / rule 5):
//   * VisionTransientError  -> 429/5xx/network/timeout — a retry may help, so
//     the handler rethrows a normal error and fail_processing_job backoffs.
//   * VisionPermanentError  -> unsupported type, empty/unparseable JSON, or a
//     refused/blocked prompt — a retry can never help, so the handler raises a
//     PermanentJobError and the job settles.
// Nothing here touches the database or storage; it is a pure provider call and
// its result is only ever a candidate the caller validates before trusting.
import { GoogleGenAI, Type } from '@google/genai'
import type { LedgerCandidate } from '@/lib/ocr/ledger'

const CALL_TIMEOUT_MS = 25_000

export class VisionTransientError extends Error {
  override name = 'VisionTransientError'
}

export class VisionPermanentError extends Error {
  override name = 'VisionPermanentError'
}

/** Only these transport types are meaningful image/PDF inputs for vision. */
const SUPPORTED_MIME = /^(image\/(jpeg|png|webp)|application\/pdf)$/i

const VISION_PROMPT = [
  'You are reading a single Indian GST tax invoice. Extract ONLY values that are',
  'explicitly printed on the document. Never guess, infer or compute a number, a',
  'date, or a GSTIN. If a field is not present or not legible, return an empty',
  'string for text fields and 0 for amount fields, and give that field a low',
  'confidence (0.0-1.0 per field; be honest, do not default to high).',
  'PARTIES: the SUPPLIER is the seller who ISSUED the invoice (letterhead, "Sold',
  'by", "Seller", "From"). The RECIPIENT is the buyer ("Bill to", "Ship to",',
  '"Buyer", "Customer"). supplier_gstin and vendor_name belong to the SUPPLIER',
  'only; put the buyer\'s GSTIN in recipient_gstin. Never swap them.',
  'AMOUNTS: taxable_value is the total taxable value before tax; cgst_amount,',
  'sgst_amount and igst_amount are the invoice-level tax amounts per head (not',
  'rates, not percentages); total_amount is the final payable invoice total',
  'including tax and round-off. Use plain numbers (no currency symbol, no',
  'thousands separators).',
  'DATES: invoice_date is the INVOICE date, never the due, order, delivery or PO',
  'date. Return it as printed (prefer DD/MM/YYYY or YYYY-MM-DD).',
  'GSTIN is exactly 15 characters: 2 digits, 5 letters, 4 digits, 1 letter, 1',
  'alphanumeric, "Z", 1 alphanumeric. Read it character by character.',
  'If the page shows several invoices, read only the first/most prominent one.',
].join(' ')

const confidenceSchema = {
  type: Type.OBJECT,
  properties: {
    invoice_date: { type: Type.NUMBER },
    invoice_number: { type: Type.NUMBER },
    vendor_name: { type: Type.NUMBER },
    supplier_gstin: { type: Type.NUMBER },
    taxable_value: { type: Type.NUMBER },
    cgst_amount: { type: Type.NUMBER },
    sgst_amount: { type: Type.NUMBER },
    igst_amount: { type: Type.NUMBER },
    total_amount: { type: Type.NUMBER },
  },
  required: [
    'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
    'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
  ],
  propertyOrdering: [
    'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
    'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
  ],
}

const LEDGER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    invoice_date: { type: Type.STRING },
    invoice_number: { type: Type.STRING },
    vendor_name: { type: Type.STRING },
    supplier_gstin: { type: Type.STRING },
    recipient_gstin: { type: Type.STRING },
    taxable_value: { type: Type.NUMBER },
    cgst_amount: { type: Type.NUMBER },
    sgst_amount: { type: Type.NUMBER },
    igst_amount: { type: Type.NUMBER },
    total_amount: { type: Type.NUMBER },
    confidence: confidenceSchema,
  },
  required: [
    'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin', 'recipient_gstin',
    'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
    'confidence',
  ],
  propertyOrdering: [
    'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin', 'recipient_gstin',
    'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
    'confidence',
  ],
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new VisionTransientError(`${label}: timeout ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** Classify a raw thrown provider error into transient vs permanent. */
function classifyProviderError(error: unknown): Error {
  const msg = error instanceof Error ? error.message : String(error)
  if (/(\b429\b|rate.?limit|\b5\d\d\b|unavailable|deadline|timeout|overloaded|temporar|network|socket)/i.test(msg)) {
    return new VisionTransientError(msg.slice(0, 200))
  }
  return new VisionPermanentError(msg.slice(0, 200))
}

/** Parse the model's JSON text into a candidate; malformed output is permanent. */
export function parseVisionJson(text: string): LedgerCandidate {
  const trimmed = (text ?? '').trim()
  if (!trimmed) throw new VisionPermanentError('EMPTY_VISION_RESPONSE')
  // Tolerate a fenced block even with responseMimeType set; take the outer object.
  const braceStart = trimmed.indexOf('{')
  const braceEnd = trimmed.lastIndexOf('}')
  if (braceStart < 0 || braceEnd <= braceStart) throw new VisionPermanentError('UNPARSEABLE_VISION_JSON')
  let json: unknown
  try {
    json = JSON.parse(trimmed.slice(braceStart, braceEnd + 1))
  } catch {
    throw new VisionPermanentError('UNPARSEABLE_VISION_JSON')
  }
  if (!json || typeof json !== 'object') throw new VisionPermanentError('UNPARSEABLE_VISION_JSON')
  return json as LedgerCandidate
}

/**
 * Send one invoice document to Gemini and return the raw extracted candidate.
 * A single in-handler retry covers a transient blip; persistent failures throw
 * VisionTransientError (retryable) or VisionPermanentError (terminal).
 */
export async function extractInvoiceFields(args: {
  buffer: Buffer
  mimeType: string
  apiKey: string
  model: string
  /**
   * Second-pass only: the failed validation checks from the first read (see
   * retryHintFor in ledger.ts). The model is told what did not add up and asked
   * to re-read — it is still forbidden to guess.
   */
  hint?: string | null
}): Promise<LedgerCandidate> {
  const { buffer, mimeType, apiKey, model, hint } = args
  if (!SUPPORTED_MIME.test(mimeType)) {
    throw new VisionPermanentError(`UNSUPPORTED_MEDIA_TYPE: ${mimeType}`)
  }
  if (!apiKey) throw new VisionPermanentError('VISION_UNCONFIGURED: GEMINI_API_KEY missing')
  if (!buffer || buffer.length === 0) throw new VisionPermanentError('EMPTY_MEDIA')

  const ai = new GoogleGenAI({ apiKey })
  const contents = [{
    role: 'user',
    parts: [
      { inlineData: { mimeType, data: buffer.toString('base64') } },
      { text: hint ? `${VISION_PROMPT} ${hint}` : VISION_PROMPT },
    ],
  }]

  let lastTransient: Error | null = null
  // Two attempts total (one retry) — but only for transient failures.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents,
          config: { responseMimeType: 'application/json', responseSchema: LEDGER_SCHEMA, temperature: 0 },
        }),
        CALL_TIMEOUT_MS,
        'gemini_generate_content',
      )
      const text = (response as { text?: string }).text ?? ''
      return parseVisionJson(text)
    } catch (e) {
      const classified = e instanceof VisionTransientError || e instanceof VisionPermanentError
        ? e
        : classifyProviderError(e)
      if (classified instanceof VisionPermanentError) throw classified
      lastTransient = classified
      // one retry on transient, then fall through to rethrow below
    }
  }
  throw lastTransient ?? new VisionTransientError('VISION_UNAVAILABLE')
}
