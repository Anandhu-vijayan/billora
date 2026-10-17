
import 'server-only'

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { createWorker } from 'tesseract.js'

import { logger } from '@/lib/logger'
import {
  evaluateLedger,
  mergeCandidates,
  retryHintFor,
  selectBestCandidate,
  detectCandidateConflicts,
  type CandidateAssessment,
  type LedgerCandidate,
  type LedgerEvaluation,
} from '@/lib/ocr/ledger'
import { parseInvoiceText, hasMeaningfulText } from '@/lib/ocr/text-parser'
import { extractPdfTextLayer } from '@/lib/ocr/pdf'
import {
  extractInvoiceFields,
  VisionTransientError,
} from '@/lib/ocr/vision'

const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40_000_000
const MAX_PDF_PAGES = 10
const MAX_RENDER_DIMENSION = 2400
const OCR_LANGUAGE = 'eng'
const OCR_LANGUAGE_DATA = join(process.cwd(), `${OCR_LANGUAGE}.traineddata`)

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
])

const PDF_MIME = 'application/pdf'

export type ExtractionSource = 'local' | 'ai' | 'human'

export interface InvoiceExtractionOptions {
  buffer: Buffer
  mimeType: string
  minConfidence?: number
  amountToleranceMinorUnits?: number

  /**
   * AI is disabled unless explicitly enabled by the caller.
   * The caller must also enforce the application's paid-tier privacy gate.
   */
  allowAI?: boolean
  apiKey?: string
  model?: string

  /** Maximum PDF pages to process. Defaults to 10. */
  maxPdfPages?: number
}

export interface InvoiceExtractionResult {
  candidate: LedgerCandidate
  source: ExtractionSource
  review: 'approved' | 'needs_review'
  confidence: number
  reasons: string[]
  pagesProcessed: number
  /**
   * Critical fields on which the LOCAL and AI readings both produced a valid but
   * DIFFERENT value. Provenance for debugging; the handler refuses to auto-approve
   * over an unreconciled conflict so these land in the human-review queue.
   */
  conflictFields: string[]
}

export class InvoiceExtractionError extends Error {
  constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'InvoiceExtractionError'
  }
}

interface PdfDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPage>
  destroy?: () => Promise<void>
}

interface PdfPage {
  getViewport(options: { scale: number }): {
    width: number
    height: number
  }
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>
  render(options: Record<string, unknown>): { promise: Promise<void> }
}

interface PdfJsModule {
  getDocument(options: Record<string, unknown>): {
    promise: Promise<PdfDocument>
  }
}

interface CanvasModule {
  createCanvas(width: number, height: number): {
    width: number
    height: number
    getContext(type: '2d'): CanvasRenderingContext2D
    toBuffer(type: 'image/png'): Buffer
  }
}

function normalizeMimeType(mimeType: string): string {
  return (mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

function assertFile(buffer: Buffer, mimeType: string): void {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new InvoiceExtractionError('EMPTY_FILE')
  }

  if (buffer.length > MAX_FILE_BYTES) {
    throw new InvoiceExtractionError('FILE_TOO_LARGE')
  }

  if (
    mimeType !== PDF_MIME &&
    !IMAGE_MIME_TYPES.has(mimeType)
  ) {
    throw new InvoiceExtractionError(
      `UNSUPPORTED_MEDIA_TYPE:${mimeType || 'unknown'}`,
    )
  }

  // Do not trust the uploaded Content-Type header alone.
  if (mimeType === PDF_MIME && buffer.subarray(0, 5).toString() !== '%PDF-') {
    throw new InvoiceExtractionError('INVALID_PDF_SIGNATURE')
  }

  if (mimeType !== PDF_MIME) {
    const signature = detectImageFormat(buffer)
    if (!signature) {
      throw new InvoiceExtractionError('INVALID_IMAGE_SIGNATURE')
    }
  }
}

/**
 * Basic signature checks prevent a mislabeled or arbitrary file from being
 * sent to OCR. Sharp performs the definitive image decode afterwards.
 */
function detectImageFormat(buffer: Buffer): string | null {
  if (buffer.length < 12) return null

  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) return 'jpeg'

  if (buffer.subarray(0, 8).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )) return 'png'

  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) return 'webp'

  if (
    buffer.toString('ascii', 0, 4) === 'II*\0' ||
    buffer.toString('ascii', 0, 4) === 'MM\0*'
  ) return 'tiff'

  if (buffer.toString('ascii', 0, 2) === 'BM') return 'bmp'
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'gif'

  // AVIF and HEIF/HEIC use an ISO BMFF container with an ftyp box.
  if (
    buffer.toString('ascii', 4, 8) === 'ftyp'
  ) {
    const brand = buffer.toString('ascii', 8, 12)
    if (['avif', 'avis'].includes(brand)) return 'avif'
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return 'heif'
    }
  }

  return null
}

/**
 * Normalize a single image/frame to a bounded PNG for OCR.
 * Sharp must be built with support for the image's actual codec.
 */
async function normalizeImageToPng(buffer: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(buffer, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
      failOn: 'error',
    }).metadata()

    if (!metadata.width || !metadata.height) {
      throw new InvoiceExtractionError('INVALID_IMAGE_DIMENSIONS')
    }

    if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
      throw new InvoiceExtractionError('IMAGE_PIXEL_LIMIT_EXCEEDED')
    }

    return await sharp(buffer, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
      failOn: 'error',
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .greyscale()
      .normalize()
      .sharpen()
      .resize({
        width: MAX_RENDER_DIMENSION,
        height: MAX_RENDER_DIMENSION,
        fit: 'inside',
        withoutEnlargement: false,
      })
      .png()
      .toBuffer()
  } catch (error) {
    if (error instanceof InvoiceExtractionError) throw error

    throw new InvoiceExtractionError(
      'IMAGE_DECODE_FAILED: image format may be unsupported by this Sharp build',
    )
  }
}

type OcrWorker = Awaited<ReturnType<typeof createWorker>>

async function withOcrWorker<T>(run: (worker: OcrWorker) => Promise<T>): Promise<T> {
  if (!existsSync(OCR_LANGUAGE_DATA)) {
    throw new InvoiceExtractionError('LOCAL_OCR_LANGUAGE_DATA_UNAVAILABLE')
  }

  let worker: OcrWorker | undefined
  try {
    worker = await createWorker(OCR_LANGUAGE, undefined, {
      langPath: process.cwd(),
      gzip: false,
    })
    return await run(worker)
  } catch (error) {
    if (error instanceof InvoiceExtractionError) throw error
    throw new InvoiceExtractionError('LOCAL_OCR_FAILED', true)
  } finally {
    if (worker) await worker.terminate().catch(() => undefined)
  }
}

async function recognizeText(png: Buffer, worker: OcrWorker): Promise<string> {

  try {
    const result = await worker.recognize(png)
    const text = result.data.text || ''
    // Metadata only (never the OCR text itself): proves whether the worker ran
    // and roughly how much it read, without leaking invoice content to logs.
    logger.info('[OCR] recognize complete', { chars: text.length, sourceBytes: png.length })
    return text
  } catch (error) {
    // Surface WHY the worker failed (a bundling/model-resolution fault in the
    // server runtime looked identical to "blank invoice" before).
    logger.warn('[OCR] tesseract worker failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw new InvoiceExtractionError('LOCAL_OCR_FAILED', true)
  }
}

function candidateHasUsefulFields(candidate: LedgerCandidate): boolean {
  return Boolean(
    candidate.invoice_date ||
    candidate.invoice_number ||
    candidate.vendor_name ||
    candidate.supplier_gstin ||
    candidate.taxable_value != null ||
    candidate.cgst_amount != null ||
    candidate.sgst_amount != null ||
    candidate.igst_amount != null ||
    candidate.total_amount != null,
  )
}

function candidateFieldCount(candidate: LedgerCandidate | null): number {
  return candidatePresentFields(candidate).length
}

function candidatePresentFields(candidate: LedgerCandidate | null): string[] {
  if (!candidate) return []
  const fields = [
    candidate.invoice_date,
    candidate.invoice_number,
    candidate.vendor_name,
    candidate.supplier_gstin,
    candidate.taxable_value,
    candidate.cgst_amount,
    candidate.sgst_amount,
    candidate.igst_amount,
    candidate.total_amount,
  ]
  const names = [
    'invoice_date',
    'invoice_number',
    'vendor_name',
    'supplier_gstin',
    'taxable_value',
    'cgst_amount',
    'sgst_amount',
    'igst_amount',
    'total_amount',
  ]
  return names.filter((_, index) => {
    const value = fields[index]
    return value !== undefined && value !== null && value !== ''
  })
}

/**
 * Combine page candidates without discarding values that were already found.
 * mergeCandidates preserves independently valid values in its primary input.
 */
function combinePageCandidates(
  candidates: LedgerCandidate[],
): LedgerCandidate | null {
  let combined: LedgerCandidate | null = null

  for (const candidate of candidates) {
    if (!candidateHasUsefulFields(candidate)) continue

    combined = combined
      ? mergeCandidates(combined, candidate)
      : candidate
  }

  return combined
}

async function loadPdfEngines(): Promise<{
  pdfjs: PdfJsModule
  canvas: CanvasModule
}> {
  try {
    const [pdfModule, canvasModule] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('@napi-rs/canvas'),
    ])

    return {
      pdfjs: pdfModule as unknown as PdfJsModule,
      canvas: canvasModule as unknown as CanvasModule,
    }
  } catch {
    throw new InvoiceExtractionError('PDF_RENDER_ENGINE_UNAVAILABLE')
  }
}

/**
 * Render each page of a scanned PDF, bounded by maxPdfPages.
 * Page text is handled separately by extractPdfTextLayer().
 */
async function extractScannedPdf(
  buffer: Buffer,
  maxPages: number,
): Promise<{ candidates: LedgerCandidate[]; pagesProcessed: number }> {
  const { pdfjs, canvas } = await loadPdfEngines()
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableAutoFetch: true,
  }).promise

  const candidates: LedgerCandidate[] = []
  const pageCount = Math.min(pdf.numPages, maxPages)

  try {
    await withOcrWorker(async (worker) => {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber)
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = Math.min(
          2,
          MAX_RENDER_DIMENSION / Math.max(baseViewport.width, baseViewport.height),
        )
        const viewport = page.getViewport({ scale })
        const width = Math.max(1, Math.ceil(viewport.width))
        const height = Math.max(1, Math.ceil(viewport.height))

        if (width > MAX_RENDER_DIMENSION || height > MAX_RENDER_DIMENSION
          || width * height > MAX_IMAGE_PIXELS) {
          throw new InvoiceExtractionError('PDF_PAGE_PIXEL_LIMIT_EXCEEDED')
        }

        const surface = canvas.createCanvas(width, height)
        const context = surface.getContext('2d')

        await page.render({
          canvasContext: context,
          viewport,
        }).promise

        const png = await normalizeImageToPng(surface.toBuffer('image/png'))
        const text = await recognizeText(png, worker)

        if (hasMeaningfulText(text)) {
          const candidate = parseInvoiceText(text)
          if (candidateHasUsefulFields(candidate)) candidates.push(candidate)
        }
      }
    })
  } catch (error) {
    if (error instanceof InvoiceExtractionError) throw error
    throw new InvoiceExtractionError('PDF_PAGE_EXTRACTION_FAILED', true)
  } finally {
    await pdf.destroy?.().catch(() => undefined)
  }

  return { candidates, pagesProcessed: pageCount }
}

/**
 * The image Gemini receives. NOT the OCR copy: normalizeImageToPng() makes a
 * greyscale, contrast-stretched, up-to-2400px PNG for Tesseract (3.0 MB for a
 * 126 KB phone JPEG), and uploading that 4 MB payload is what timed the call out.
 * Vision models want the colour page at a modest size: EXIF-rotated, long edge
 * <= 1600 px, JPEG q82 (typically 100-400 KB). Still decodes anything sharp can
 * (HEIC/TIFF/WebP...), so unsupported-type handling is unchanged.
 */
const VISION_MAX_EDGE = 1600
const VISION_JPEG_QUALITY = 82
async function prepareImageForVision(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false, failOn: 'error' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: VISION_MAX_EDGE, height: VISION_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: VISION_JPEG_QUALITY })
      .toBuffer()
  } catch (error) {
    if (error instanceof InvoiceExtractionError) throw error
    throw new InvoiceExtractionError(
      'IMAGE_DECODE_FAILED: image format may be unsupported by this Sharp build',
    )
  }
}

/**
 * Permanent AI failures that say "the model answered but its answer did not pass
 * validation" (or the provider refused). They do NOT mean the invoice is
 * unprocessable, so the invoice settles on the local result for human review
 * instead of failing outright. Configuration / input faults (unsupported type,
 * missing key, empty media) still fail the job so an operator sees them.
 */
const SETTLEABLE_VISION_FAILURE =
  /^(VISION_SCHEMA_KEYS_INVALID|VISION_CONFIDENCE_KEYS_INVALID|VISION_CONFIDENCE_INVALID|VISION_FIELD_TYPE_INVALID|EMPTY_VISION_RESPONSE|UNPARSEABLE_VISION_JSON|provider_error)/
export function isSettleableVisionFailure(message: string): boolean {
  return SETTLEABLE_VISION_FAILURE.test(message)
}

async function extractLocal(
  buffer: Buffer,
  mimeType: string,
  maxPdfPages: number,
): Promise<{ candidate: LedgerCandidate | null; pagesProcessed: number }> {
  if (mimeType === PDF_MIME) {
    // Prefer genuine embedded text before spending CPU on OCR.
    try {
      const text = await extractPdfTextLayer(buffer, maxPdfPages)

      if (hasMeaningfulText(text)) {
        const candidate = parseInvoiceText(text)
        if (candidateHasUsefulFields(candidate)) {
          return {
            candidate,
            pagesProcessed: 0,
          }
        }
      }
    } catch {
      // A failed text-layer extraction is not a fabricated success.
      // Continue to raster/OCR, which will raise a clear error if unavailable.
    }

    const scanned = await extractScannedPdf(buffer, maxPdfPages)

    return {
      candidate: combinePageCandidates(scanned.candidates),
      pagesProcessed: scanned.pagesProcessed,
    }
  }

  const png = await normalizeImageToPng(buffer)
  const text = await withOcrWorker((worker) => recognizeText(png, worker))
  const meaningful = hasMeaningfulText(text)
  if (!meaningful) {
    // An image that OCRs to almost nothing is the exact silent failure that
    // used to look like "extraction is broken": record the counts so ops can
    // tell an empty OCR result from a real, readable invoice.
    logger.warn('[OCR] image produced no meaningful text', {
      chars: text.length,
      digits: (text.match(/\d/g) ?? []).length,
    })
  }

  const parsed = meaningful ? parseInvoiceText(text) : null

  return {
    candidate: parsed && candidateHasUsefulFields(parsed) ? parsed : null,
    pagesProcessed: 1,
  }
}

/**
 * A result is "sufficient" only when it independently cleared review (approved).
 * Used to decide whether a transient AI failure may be swallowed (we already
 * hold a good row) or MUST be propagated for retry (what we hold is known-bad).
 */
function isResultSufficient(evaluation: LedgerEvaluation | null): boolean {
  return evaluation !== null && evaluation.review === 'approved'
}

export async function extractInvoice(
  options: InvoiceExtractionOptions,
): Promise<InvoiceExtractionResult> {
  const {
    buffer,
    minConfidence = 0.8,
    amountToleranceMinorUnits = 101,
    allowAI = false,
    apiKey,
    model = 'gemini-flash-lite-latest',
    maxPdfPages = MAX_PDF_PAGES,
  } = options

  const mimeType = normalizeMimeType(options.mimeType)
  assertFile(buffer, mimeType)

  if (!Number.isInteger(maxPdfPages) || maxPdfPages < 1 || maxPdfPages > MAX_PDF_PAGES) {
    throw new InvoiceExtractionError(
      `MAX_PDF_PAGES must be between 1 and ${MAX_PDF_PAGES}`,
    )
  }

  let candidate: LedgerCandidate | null = null
  let source: ExtractionSource = 'human'
  let pagesProcessed = 0
  let localErrorCode: string | null = null
  let conflictFields: string[] = []

  try {
    const local = await extractLocal(buffer, mimeType, maxPdfPages)
    candidate = local.candidate
    pagesProcessed = local.pagesProcessed

    if (candidate) source = 'local'
  } catch (error) {
    // Local decode/OCR errors are not proof the invoice is empty.
    // Allow the explicitly authorized vision fallback to attempt extraction.
    localErrorCode = error instanceof InvoiceExtractionError
      ? error.message.split(':')[0]
      : 'LOCAL_EXTRACTION_FAILED'
    if (!allowAI) throw error
  }

  let evaluation = candidate
    ? evaluateLedger(candidate, { minConfidence, amountToleranceMinorUnits })
    : null

  logger.info('[Extract] local evaluation complete', {
    mimeType,
    hasCandidate: candidate !== null,
    fieldCount: candidateFieldCount(candidate),
    presentFieldNames: candidatePresentFields(candidate),
    review: evaluation?.review ?? 'no_candidate',
    confidence: evaluation?.confidence ?? null,
    reasonCodes: evaluation?.reasons.slice(0, 8) ?? [],
    localErrorCode,
    pagesProcessed,
  })

  const needsAI = !evaluation || evaluation.review === 'needs_review'

  if (allowAI && needsAI) {
    if (!apiKey) {
      throw new InvoiceExtractionError('AI_ENABLED_BUT_API_KEY_MISSING')
    }

    logger.info('[Extract] AI fallback started', {
      mimeType,
      model,
      localFieldCount: candidateFieldCount(candidate),
      localFieldNames: candidatePresentFields(candidate),
      reasonCodes: evaluation?.reasons.slice(0, 8) ?? ['local-candidate-missing'],
      localErrorCode,
    })
    const aiStartedAt = Date.now()
    try {
      let aiCandidate: LedgerCandidate

      if (mimeType === PDF_MIME) {
        // The existing vision helper accepts PDFs, but the caller must
        // explicitly bound document size/pages for provider cost control.
        aiCandidate = await extractInvoiceFields({
          buffer,
          mimeType: PDF_MIME,
          apiKey,
          model,
        })
      } else {
        // Gemini's existing transport supports JPEG/PNG/WebP.
        // Convert TIFF/BMP/GIF/HEIC/AVIF into a supported PNG first.
        const visionImage = await prepareImageForVision(buffer)

        aiCandidate = await extractInvoiceFields({
          buffer: visionImage,
          mimeType: 'image/jpeg',
          apiKey,
          model,
        })
      }

      let assisted = candidate
        ? mergeCandidates(candidate, aiCandidate)
        : aiCandidate

      let aiEvaluation = evaluateLedger(assisted, { minConfidence, amountToleranceMinorUnits })
      let secondPass = false
      // Bounded second pass: a targeted re-read can fix a misread digit, a
      // swapped party or a wrong total — but a field simply absent from the
      // page is never "fixed" by asking again (retryHintFor returns null for
      // those reasons). Exactly one extra provider call, same model; the hint
      // still forbids guessing and the merge below can never downgrade a
      // validated local approval.
      if (aiEvaluation.review === 'needs_review') {
        const hint = retryHintFor(aiEvaluation.reasons)
        if (hint) {
          secondPass = true
          logger.info('[Extract] AI second pass started', {
            model,
            durationMs: Date.now() - aiStartedAt,
            reasonCodes: aiEvaluation.reasons.slice(0, 8),
          })
          const retryCandidate = await extractInvoiceFields(
            mimeType === PDF_MIME
              ? { buffer, mimeType: PDF_MIME, apiKey, model, hint }
              : { buffer: await prepareImageForVision(buffer), mimeType: 'image/jpeg', apiKey, model, hint },
          )
          const retryAssisted = candidate
            ? mergeCandidates(candidate, retryCandidate)
            : retryCandidate
          const retryEvaluation = evaluateLedger(retryAssisted, { minConfidence, amountToleranceMinorUnits })
          logger.info('[Extract] AI second pass completed', {
            model,
            durationMs: Date.now() - aiStartedAt,
            fieldCount: candidateFieldCount(retryCandidate),
            fieldNames: candidatePresentFields(retryCandidate),
            review: retryEvaluation.review,
            confidence: retryEvaluation.confidence,
            reasonCodes: retryEvaluation.reasons.slice(0, 8),
          })
          // Adopt the re-read only when it is the BETTER merged result under the
          // SAME ranking the final decision uses (approval, then fewer hard
          // failures, then completeness, then measured confidence) — never on a
          // bare "confidence went up", which threw away equally-safe, fuller reads.
          const passChoice = selectBestCandidate([
            { candidate: assisted, evaluation: aiEvaluation, source: 'ai' },
            { candidate: retryAssisted, evaluation: retryEvaluation, source: 'ai' },
          ])! 
          if (passChoice.candidate === retryAssisted) {
            aiCandidate = retryCandidate
            assisted = retryAssisted
            aiEvaluation = retryEvaluation
          }
        }
      }
      logger.info('[Extract] AI fallback completed', {
        model,
        durationMs: Date.now() - aiStartedAt,
        fieldCount: candidateFieldCount(aiCandidate),
        fieldNames: candidatePresentFields(aiCandidate),
        review: aiEvaluation.review,
        confidence: aiEvaluation.confidence,
        reasonCodes: aiEvaluation.reasons.slice(0, 8),
        secondPass,
      })

      // Choose between the LOCAL-only result and the LOCAL+AI MERGE with one
      // ranking rule (ledger.selectBestCandidate). The old gate kept the sparser
      // local candidate whenever the merge was not approved AND its (self-report-
      // capped) confidence did not strictly rise, so a far more complete AI read
      // was silently thrown away. Confidence is now a tie-breaker, not a gate; a
      // strictly more complete, equally-safe merge wins.
      const localCandidate = candidate
      const localEvaluation = evaluation
      const localAssessment: CandidateAssessment | null =
        localCandidate && localEvaluation
          ? { candidate: localCandidate, evaluation: localEvaluation, source }
          : null
      const chosen = selectBestCandidate(
        localAssessment
          ? [localAssessment, { candidate: assisted, evaluation: aiEvaluation, source: 'ai' }]
          : [{ candidate: assisted, evaluation: aiEvaluation, source: 'ai' }],
      )!
      conflictFields = localCandidate ? detectCandidateConflicts(localCandidate, aiCandidate) : []
      candidate = chosen.candidate
      evaluation = chosen.evaluation
      if (chosen.source === 'ai') source = 'ai'

      logger.info('[Extract] candidate selected', {
        model,
        chosenSource: source,
        localFieldCount: candidateFieldCount(localCandidate),
        localFieldNames: candidatePresentFields(localCandidate),
        aiFieldCount: candidateFieldCount(aiCandidate),
        aiFieldNames: candidatePresentFields(aiCandidate),
        selectedFieldCount: candidateFieldCount(candidate),
        conflictFields,
        review: evaluation.review,
        confidence: evaluation.confidence,
        reasonCodes: evaluation.reasons.slice(0, 8),
      })
    } catch (error) {
      if (error instanceof VisionTransientError) {
        // We only enter the AI block when the local result was ALREADY
        // insufficient, so in the common case the best we hold here is still
        // insufficient. Swallowing the error would "complete" the job on a
        // known-bad candidate and strand the invoice in needs_review forever.
        // Preserve it ONLY when it is independently sufficient (an approved
        // first pass that a later provider call could not improve); otherwise
        // propagate a retryable error so the worker requeues the whole job.
        const currentBestIsSufficient = isResultSufficient(evaluation)
        logger.warn('[Extract] AI fallback failed transiently', {
          model,
          durationMs: Date.now() - aiStartedAt,
          failureCode: error.message.split(':')[0] || 'VISION_TRANSIENT',
          currentBestIsSufficient,
          localCandidatePreserved: candidate !== null,
        })
        if (!currentBestIsSufficient) {
          throw new InvoiceExtractionError('VISION_TEMPORARILY_UNAVAILABLE', true)
        }
        logger.info('[Extract] keeping current best result despite transient AI failure', {
          review: evaluation?.review ?? 'no_candidate',
          confidence: evaluation?.confidence ?? null,
        })
      }
      else {
        const failureCode = error instanceof Error ? error.message.split(':')[0] : 'VISION_PERMANENT'
        const settleable = error instanceof Error && isSettleableVisionFailure(error.message)
        logger.warn('[Extract] AI fallback failed permanently', {
          model,
          durationMs: Date.now() - aiStartedAt,
          failureCode,
          settleOnLocal: settleable,
        })
        // A validation/provider-answer failure must not destroy the invoice: keep
        // the local candidate (or an empty row) as needs_review so the customer
        // can still correct it. Config/input faults still fail the job loudly.
        if (!settleable) throw error
        logger.error('[Extract] AI result unusable; settling on local result for review', {
          model, failureCode, localCandidatePreserved: candidate !== null,
        })
      }
    }
  }

  if (!evaluation) {
    evaluation = evaluateLedger(
      {},
      { minConfidence: Number.POSITIVE_INFINITY },
    )
    source = 'human'
  }

  // A critical-field conflict between the two sources is unreconciled
  // disagreement: even a row that would otherwise auto-approve must NOT be
  // silently blessed over it. Record it as an explicit, actionable reason and
  // force human review (the handler enforces the same rule on its re-evaluation).
  const finalReasons = [
    ...evaluation.reasons,
    ...conflictFields.map((field) => `candidate-conflict:${field}`),
  ]
  const finalReview: 'approved' | 'needs_review' =
    evaluation.review === 'approved' && conflictFields.length > 0
      ? 'needs_review'
      : evaluation.review

  return {
    candidate: candidate ?? {},
    source,
    review: finalReview,
    confidence: evaluation.confidence,
    reasons: finalReasons,
    pagesProcessed,
    conflictFields,
  }
}
