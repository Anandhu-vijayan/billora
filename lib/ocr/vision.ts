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
import { logger } from '@/lib/logger'
import type { LedgerCandidate } from '@/lib/ocr/ledger'
import { buildGeminiInvoiceRequest } from '@/lib/ocr/gemini-request'

const CALL_TIMEOUT_MS = 15_000

export class VisionTransientError extends Error {
  override name = 'VisionTransientError'
}

export class VisionPermanentError extends Error {
  override name = 'VisionPermanentError'
}

const TEXT_FIELDS = [
  'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin', 'recipient_gstin',
] as const
const OPTIONAL_EVIDENCE_FIELDS = [
  'cgst_rate_percent', 'sgst_rate_percent', 'igst_rate_percent', 'total_amount_in_words',
] as const
const AMOUNT_FIELDS = [
  'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
] as const
const CONFIDENCE_FIELDS = [
  'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
  'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
  'cgst_rate_percent', 'sgst_rate_percent', 'igst_rate_percent', 'total_amount_in_words',
] as const
const RESPONSE_FIELDS = [...TEXT_FIELDS, ...OPTIONAL_EVIDENCE_FIELDS, ...AMOUNT_FIELDS, 'confidence'] as const

/** Only these transport types are meaningful image/PDF inputs for vision. */
const SUPPORTED_MIME = /^(image\/(jpeg|png|webp)|application\/pdf)$/i

const VISION_PROMPT = [
  'You are reading a single Indian GST tax invoice. Extract ONLY values that are',
  'explicitly printed on the document. Never guess, infer or compute a number, a',
  'date, or a GSTIN. If a text field is not present or not legible, return an',
  'empty string. For amount fields return null when unknown and numeric 0 only',
  'when zero is explicitly printed or the tax head is demonstrably absent.',
  'Give every extracted field a confidence (0.0-1.0; never default to high).',
  'PARTIES: the SUPPLIER is the seller who ISSUED the invoice (letterhead, "Sold',
  'by", "Seller", "From"). The RECIPIENT is the buyer ("Bill to", "Ship to",',
  '"Buyer", "Customer"). supplier_gstin and vendor_name belong to the SUPPLIER',
  'only; put the buyer\'s GSTIN in recipient_gstin. Never swap them.',
  'AMOUNTS: taxable_value is the total taxable value before tax; cgst_amount,',
  'sgst_amount and igst_amount are the invoice-level tax amounts per head (not',
  'rates, not percentages); total_amount is the final payable invoice total',
  'including tax and round-off. Use plain numbers (no currency symbol, no',
  'thousands separators). If the tax-rate percentages are explicitly printed,',
  'return them as strings without the percent sign; otherwise return an empty',
  'string. Copy the printed total amount-in-words exactly, or return an empty',
  'string when it is absent. Never infer a rate or amount-in-words.',
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
    taxable_value: { type: Type.NUMBER, nullable: true },
    cgst_amount: { type: Type.NUMBER, nullable: true },
    sgst_amount: { type: Type.NUMBER, nullable: true },
    igst_amount: { type: Type.NUMBER, nullable: true },
    total_amount: { type: Type.NUMBER, nullable: true },
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
    cgst_rate_percent: { type: Type.STRING, nullable: true },
    sgst_rate_percent: { type: Type.STRING, nullable: true },
    igst_rate_percent: { type: Type.STRING, nullable: true },
    total_amount_in_words: { type: Type.STRING, nullable: true },
    confidence: confidenceSchema,
  },
  required: [
    'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin', 'recipient_gstin',
    'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
    'cgst_rate_percent', 'sgst_rate_percent', 'igst_rate_percent', 'total_amount_in_words', 'confidence',
  ],
  propertyOrdering: [
    'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin', 'recipient_gstin',
    'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
    'cgst_rate_percent', 'sgst_rate_percent', 'igst_rate_percent', 'total_amount_in_words', 'confidence',
  ],
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new VisionTransientError('GEMINI_TIMEOUT')), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** Classify a raw thrown provider error into transient vs permanent. */
function classifyProviderError(error: unknown): Error {
  const status = providerStatus(error)
  const reason = providerFailureReason(error)
  if (status === 429 || (status !== null && status >= 500)
    || reason === 'timeout' || reason === 'network') {
    return new VisionTransientError(reason)
  }
  return new VisionPermanentError(reason)
}

function providerFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = providerStatus(error)
  if (status === 429) return 'rate_limited'
  if (status !== null && status >= 500) return 'provider_unavailable'
  if (/timeout|deadline/i.test(message)) return 'timeout'
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate_limited'
  if (/\b5\d\d\b|unavailable|overloaded|temporar/i.test(message)) return 'provider_unavailable'
  if (/network|socket|fetch/i.test(message)) return 'network'
  return 'provider_error'
}

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const value = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode
  return typeof value === 'number' && Number.isInteger(value) ? value : null
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
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new VisionPermanentError('UNPARSEABLE_VISION_JSON')
  }
  const candidate = json as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  const expectedKeys = [...RESPONSE_FIELDS].sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new VisionPermanentError('VISION_SCHEMA_KEYS_INVALID')
  }
  for (const field of TEXT_FIELDS) {
    if (typeof candidate[field] !== 'string') {
      throw new VisionPermanentError(`VISION_FIELD_TYPE_INVALID:${field}`)
    }
  }
  for (const field of OPTIONAL_EVIDENCE_FIELDS) {
    if (candidate[field] !== null && typeof candidate[field] !== 'string') {
      throw new VisionPermanentError(`VISION_FIELD_TYPE_INVALID:${field}`)
    }
  }
  for (const field of AMOUNT_FIELDS) {
    const value = candidate[field]
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new VisionPermanentError(`VISION_FIELD_TYPE_INVALID:${field}`)
    }
  }
  if (!candidate.confidence || typeof candidate.confidence !== 'object' || Array.isArray(candidate.confidence)) {
    throw new VisionPermanentError('VISION_CONFIDENCE_INVALID')
  }
  const confidence = candidate.confidence as Record<string, unknown>
  const confidenceKeys = Object.keys(confidence).sort()
  const expectedConfidenceKeys = [...CONFIDENCE_FIELDS].sort()
  if (confidenceKeys.length !== expectedConfidenceKeys.length
    || confidenceKeys.some((key, index) => key !== expectedConfidenceKeys[index])) {
    throw new VisionPermanentError('VISION_CONFIDENCE_KEYS_INVALID')
  }
  for (const field of CONFIDENCE_FIELDS) {
    const value = confidence[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new VisionPermanentError(`VISION_CONFIDENCE_INVALID:${field}`)
    }
  }
  return candidate as unknown as LedgerCandidate
}

/**
 * Send one invoice document to Gemini and return the raw extracted candidate.
 * Transient failures are retried by the durable job queue, not here, so a worker
 * request never spends its whole execution budget on duplicate provider calls.
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
  const request = buildGeminiInvoiceRequest({
    model,
    mimeType,
    imageBase64: buffer.toString('base64'),
    prompt: hint ? `${VISION_PROMPT} ${hint}` : VISION_PROMPT,
    responseSchema: LEDGER_SCHEMA,
  })

  const imagePart = request.contents[0].parts.find((part) => 'inlineData' in part)
  const promptPart = request.contents[0].parts.find((part) => 'text' in part)
  if (!imagePart || !('inlineData' in imagePart) || !promptPart || !('text' in promptPart)) {
    throw new VisionPermanentError('INVALID_GEMINI_REQUEST_SHAPE')
  }

  const startedAt = Date.now()
  logger.info('[Vision] Gemini request prepared', {
    model,
    mimeType,
    imageBytes: buffer.length,
    encodedImageBytes: imagePart.inlineData.data.length,
    promptBytes: Buffer.byteLength(promptPart.text, 'utf8'),
    contentPartCount: request.contents[0].parts.length,
    responseMimeType: request.config.responseMimeType,
    schemaFieldNames: Object.keys(LEDGER_SCHEMA.properties),
  })
  try {
    const response = await withTimeout(
      ai.models.generateContent(request),
      CALL_TIMEOUT_MS,
    )
    const text = (response as { text?: string }).text ?? ''
    const candidate = parseVisionJson(text)
    return candidate
  } catch (error) {
    const classified = error instanceof VisionTransientError || error instanceof VisionPermanentError
      ? error
      : classifyProviderError(error)
    logger.warn('[Vision] Gemini request failed', {
      model,
      durationMs: Date.now() - startedAt,
      failureClass: classified instanceof VisionTransientError ? 'transient' : 'permanent',
      failureReason: providerFailureReason(error),
      httpStatus: providerStatus(error),
    })
    throw classified
  }
}
