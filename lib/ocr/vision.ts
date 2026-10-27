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

// Per-call Gemini ceiling. A throttled/free-tier key can take 25s+ for a single
// read, so this is operator-configurable (VISION_TIMEOUT_MS) instead of pinned
// to 15s — a pinned 15s aborted every real call as GEMINI_TIMEOUT before the
// answer arrived. Default 40s clears the observed worst case while staying under
// the worker's 60s function limit; the extractor bounds the SECOND pass
// separately (VISION_MAX_TOTAL_MS) so two slow reads cannot exceed maxDuration.
function callTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.VISION_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : 40_000
}

/** The active per-call Gemini ceiling, exported so callers can budget retries. */
export function visionCallTimeoutMs(): number {
  return callTimeoutMs()
}

export class VisionTransientError extends Error {
  override name = 'VisionTransientError'
}

export class VisionPermanentError extends Error {
  override name = 'VisionPermanentError'
}

// recipient_gstin is optional: a retail bill may print no buyer GSTIN, and forcing
// the field invites the model to invent one. A supplier GSTIN equal to the
// recipient's is NEVER silently repaired here — it means the model took the
// buyer's GSTIN as the seller's, and ledger.ts must route it to review.
const TEXT_FIELDS = [
  'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
] as const
const OPTIONAL_EVIDENCE_FIELDS = [
  'cgst_rate_percent', 'sgst_rate_percent', 'igst_rate_percent', 'total_amount_in_words',
] as const
const AMOUNT_FIELDS = [
  'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
] as const
// Optional structural components a plain `taxable + tax = total` cannot carry
// (discount, freight, cess, deduction, round-off). NEVER required and NEVER
// given a confidence key: a model that omits them, or returns a malformed value
// for them, must still be accepted — they only assist the shared reconciliation
// engine and can never, on their own, approve or fail an invoice.
const OPTIONAL_AMOUNT_FIELDS = [
  'cess_amount', 'shipping_amount', 'discount_amount', 'deduction_amount', 'round_off',
] as const
// The confidence object the model is ASKED for (see confidenceSchema below) has
// exactly these nine keys. The four optional evidence fields carry no confidence
// of their own. The validator below must accept what the schema asks for: the
// previous validator demanded 13 keys while the schema requested 9, so EVERY
// valid Gemini answer was rejected as VISION_CONFIDENCE_KEYS_INVALID (permanent).
const CORE_CONFIDENCE_FIELDS = [
  'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
  'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
] as const
/** Confidence for an unknown amount may legitimately be null (schema: nullable). */
const NULLABLE_CONFIDENCE_FIELDS = new Set<string>([
  'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
])
/** Keys that MUST be present in a response; the optional evidence fields may be absent. */
const REQUIRED_RESPONSE_FIELDS = [...TEXT_FIELDS, ...AMOUNT_FIELDS, 'confidence'] as const

/** Only these transport types are meaningful image/PDF inputs for vision. */
const SUPPORTED_MIME = /^(image\/(jpeg|png|webp)|application\/pdf)$/i

const VISION_PROMPT = [
  'You are reading a single Indian GST tax invoice. Extract ONLY values that are',
  'explicitly printed on the document. Never guess, infer or compute a number, a',
  'date, or a GSTIN. If a text field is not present or not legible, return an',
  'empty string. For amount fields return null when unknown and numeric 0 only',
  'when zero is explicitly printed or the tax head is demonstrably absent. An',
  'invoice charges EITHER IGST OR CGST+SGST, never both: when IGST is charged',
  'return 0 for cgst_amount and sgst_amount; when CGST and SGST are charged',
  'return 0 for igst_amount.',
  'Give every extracted field a confidence (0.0-1.0; never default to high).',
  'PARTIES: the SUPPLIER is the seller who ISSUED the invoice (letterhead, "Sold',
  'by", "Seller", "From"). The RECIPIENT is the buyer ("Bill to", "Ship to",',
  '"Buyer", "Customer"). supplier_gstin and vendor_name belong to the SUPPLIER',
  'only; put the buyer\'s GSTIN in recipient_gstin. Never swap them. The',
  'supplier GSTIN is printed under the company logo / letterhead at the top and',
  'again in the invoice-details box beside Invoice No and Date; the GSTIN inside',
  'the "Bill To" / "Ship To" box is the BUYER\'s. A GSTIN may be printed with a',
  'space after the 2-digit state code; return it without spaces. If the buyer',
  'has no GSTIN printed return an empty string for recipient_gstin; NEVER repeat',
  'the supplier\'s GSTIN there.',
  'AMOUNTS: taxable_value is the total taxable value before tax; cgst_amount,',
  'sgst_amount and igst_amount are the invoice-level tax amounts per head (not',
  'rates, not percentages); total_amount is the final payable invoice total',
  'including tax and round-off (labelled Total Invoice Value / Grand Total /',
  'Net Payable). A row labelled just "Total Amount" or "Sales Amount" is often the',
  'PRE-TAX subtotal, not the invoice total. Use plain numbers (no currency symbol, no',
  'thousands separators). If the tax-rate percentages are explicitly printed,',
  'return them as strings without the percent sign; otherwise return an empty',
  'string. Copy the printed total amount-in-words exactly, or return an empty',
  'string when it is absent. Never infer a rate or amount-in-words.',
  'TOTAL CHECK: the printed total in words and the numeric grand total are the',
  'same figure; read both and make sure total_amount matches the words line.',
  'OPTIONAL COMPONENTS: when the invoice EXPLICITLY prints any of these amounts,',
  'return them (plain numbers); otherwise return null for each. discount_amount',
  'is a line or invoice-level discount; shipping_amount is freight / packaging /',
  'handling / other charges; cess_amount is a GST cess; deduction_amount is an',
  'explicit deduction (e.g. advance or TDS on payment); round_off is the final',
  'rounding (may be negative). Never compute or guess one that is not printed.',
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
    recipient_gstin: { type: Type.STRING, nullable: true },
    taxable_value: { type: Type.NUMBER },
    cgst_amount: { type: Type.NUMBER },
    sgst_amount: { type: Type.NUMBER },
    igst_amount: { type: Type.NUMBER },
    total_amount: { type: Type.NUMBER },
    cess_amount: { type: Type.NUMBER, nullable: true },
    shipping_amount: { type: Type.NUMBER, nullable: true },
    discount_amount: { type: Type.NUMBER, nullable: true },
    deduction_amount: { type: Type.NUMBER, nullable: true },
    round_off: { type: Type.NUMBER, nullable: true },
    cgst_rate_percent: { type: Type.STRING, nullable: true },
    sgst_rate_percent: { type: Type.STRING, nullable: true },
    igst_rate_percent: { type: Type.STRING, nullable: true },
    total_amount_in_words: { type: Type.STRING, nullable: true },
    confidence: confidenceSchema,
  },
  required: [
    'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin',
    'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
    'cgst_rate_percent', 'sgst_rate_percent', 'igst_rate_percent', 'total_amount_in_words', 'confidence',
  ],
  propertyOrdering: [
    'invoice_date', 'invoice_number', 'vendor_name', 'supplier_gstin', 'recipient_gstin',
    'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
    'cess_amount', 'shipping_amount', 'discount_amount', 'deduction_amount', 'round_off',
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
  // Required keys must be present. Optional evidence fields may be absent (read
  // as null) and unknown extra keys are ignored: failing a whole invoice (a
  // PERMANENT job failure) over metadata drift is far costlier than ignoring it.
  for (const key of REQUIRED_RESPONSE_FIELDS) {
    if (!(key in candidate)) throw new VisionPermanentError('VISION_SCHEMA_KEYS_INVALID')
  }
  for (const field of TEXT_FIELDS) {
    if (typeof candidate[field] !== 'string') {
      throw new VisionPermanentError(`VISION_FIELD_TYPE_INVALID:${field}`)
    }
  }
  // Buyer GSTIN: optional; normalised only (no spaces, upper-case). Kept even
  // when identical to the supplier's so `supplier-equals-recipient` still fires.
  candidate.recipient_gstin = typeof candidate.recipient_gstin === 'string'
    ? candidate.recipient_gstin.replace(/\s+/g, '').toUpperCase() : ''
  for (const field of OPTIONAL_EVIDENCE_FIELDS) {
    if (candidate[field] === undefined) candidate[field] = null
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
  // Optional structural components: absent or malformed is tolerated as null,
  // never a permanent failure — they only assist reconciliation.
  for (const field of OPTIONAL_AMOUNT_FIELDS) {
    const value = candidate[field]
    if (value === undefined) { candidate[field] = null; continue }
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) candidate[field] = null
  }
  // §multi-rate: a rate-wise breakdown is OPTIONAL AI evidence. Preserve it when
  // the model returns a well-formed array of slice objects, but NEVER fail the
  // whole invoice over a malformed one (that would be a permanent job failure over
  // metadata drift). Absent/invalid simply means "no breakdown from AI", which the
  // deterministic parser + invoice-heads derivation still cover. It is never given
  // a confidence key and never overrides stronger validated local evidence — the
  // merge in ledger.ts keeps the local slices and only fills rates local omitted.
  if (Array.isArray(candidate.tax_slices)) {
    const slices = (candidate.tax_slices as unknown[])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s))
      .map((s) => {
        const money = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
        const rate = typeof s.rate_percent === 'number' && Number.isFinite(s.rate_percent)
          && s.rate_percent >= 0 && s.rate_percent <= 100 ? s.rate_percent : null
        const treat = s.treatment === 'interstate' ? 'interstate'
          : s.treatment === 'local' ? 'local' : 'unknown'
        return {
          rate_percent: rate,
          taxable_value: money(s.taxable_value),
          cgst_amount: money(s.cgst_amount),
          sgst_amount: money(s.sgst_amount),
          igst_amount: money(s.igst_amount),
          cess_amount: money(s.cess_amount),
          treatment: treat,
          provenance: 'item-level',
          confidence: null,
          validation_status: 'unvalidated',
        }
      })
    candidate.tax_slices = slices.length > 0 ? slices : null
  } else {
    delete candidate.tax_slices
  }
  if (!candidate.confidence || typeof candidate.confidence !== 'object' || Array.isArray(candidate.confidence)) {
    throw new VisionPermanentError('VISION_CONFIDENCE_INVALID')
  }
  const rawConfidence = candidate.confidence as Record<string, unknown>
  const confidence: Record<string, number> = {}
  for (const field of CORE_CONFIDENCE_FIELDS) {
    if (!(field in rawConfidence)) throw new VisionPermanentError('VISION_CONFIDENCE_KEYS_INVALID')
    const value = rawConfidence[field]
    // A null confidence for an unknown amount means "no belief": score it 0 so
    // the ledger can only ever downgrade, never approve, on it.
    if (value === null && NULLABLE_CONFIDENCE_FIELDS.has(field)) { confidence[field] = 0; continue }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new VisionPermanentError(`VISION_CONFIDENCE_INVALID:${field}`)
    }
    confidence[field] = value
  }
  // Normalised: exactly the keys downstream consumes, all finite numbers in [0, 1].
  candidate.confidence = confidence
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
      callTimeoutMs(),
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
