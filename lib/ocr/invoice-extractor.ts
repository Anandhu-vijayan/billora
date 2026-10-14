
import 'server-only'

import sharp from 'sharp'
import { createWorker } from 'tesseract.js'

import { logger } from '@/lib/logger'
import {
  evaluateLedger,
  mergeCandidates,
  type LedgerCandidate,
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
      .resize({
        width: MAX_RENDER_DIMENSION,
        height: MAX_RENDER_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
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

async function recognizeText(png: Buffer): Promise<string> {
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined

  try {
    worker = await createWorker(OCR_LANGUAGE)
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
  } finally {
    if (worker) {
      await worker.terminate().catch(() => undefined)
    }
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
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = Math.min(
        2,
        MAX_RENDER_DIMENSION / Math.max(baseViewport.width, baseViewport.height),
      )
      const viewport = page.getViewport({ scale: Math.max(scale, 0.5) })
      const width = Math.max(1, Math.ceil(viewport.width))
      const height = Math.max(1, Math.ceil(viewport.height))

      if (width * height > MAX_IMAGE_PIXELS) {
        throw new InvoiceExtractionError('PDF_PAGE_PIXEL_LIMIT_EXCEEDED')
      }

      const surface = canvas.createCanvas(width, height)
      const context = surface.getContext('2d')

      await page.render({
        canvasContext: context,
        viewport,
      }).promise

      const png = surface.toBuffer('image/png')
      const text = await recognizeText(png)

      if (hasMeaningfulText(text)) {
        candidates.push(parseInvoiceText(text))
      }
    }
  } catch (error) {
    if (error instanceof InvoiceExtractionError) throw error
    throw new InvoiceExtractionError('PDF_PAGE_EXTRACTION_FAILED', true)
  } finally {
    await pdf.destroy?.().catch(() => undefined)
  }

  return { candidates, pagesProcessed: pageCount }
}

async function extractLocal(
  buffer: Buffer,
  mimeType: string,
  maxPdfPages: number,
): Promise<{ candidate: LedgerCandidate | null; pagesProcessed: number }> {
  if (mimeType === PDF_MIME) {
    // Prefer genuine embedded text before spending CPU on OCR.
    try {
      const text = await extractPdfTextLayer(buffer)

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
  const text = await recognizeText(png)
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

  return {
    candidate: meaningful ? parseInvoiceText(text) : null,
    pagesProcessed: 1,
  }
}

export async function extractInvoice(
  options: InvoiceExtractionOptions,
): Promise<InvoiceExtractionResult> {
  const {
    buffer,
    minConfidence = 0.8,
    allowAI = false,
    apiKey,
    model = 'gemini-3.8-flash',
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

  try {
    const local = await extractLocal(buffer, mimeType, maxPdfPages)
    candidate = local.candidate
    pagesProcessed = local.pagesProcessed

    if (candidate) source = 'local'
  } catch (error) {
    // Local decode/OCR errors are not proof the invoice is empty.
    // Allow the explicitly authorized vision fallback to attempt extraction.
    if (!allowAI) throw error
  }

  let evaluation = candidate
    ? evaluateLedger(candidate, { minConfidence })
    : null

  const needsAI = !evaluation || evaluation.review === 'needs_review'

  if (allowAI && needsAI) {
    if (!apiKey) {
      throw new InvoiceExtractionError('AI_ENABLED_BUT_API_KEY_MISSING')
    }

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
        const normalized = await normalizeImageToPng(buffer)

        aiCandidate = await extractInvoiceFields({
          buffer: normalized,
          mimeType: 'image/png',
          apiKey,
          model,
        })
      }

      const assisted = candidate
        ? mergeCandidates(candidate, aiCandidate)
        : aiCandidate

      const aiEvaluation = evaluateLedger(assisted, { minConfidence })

      if (
        !evaluation ||
        aiEvaluation.review === 'approved' ||
        aiEvaluation.confidence > evaluation.confidence
      ) {
        candidate = assisted
        evaluation = aiEvaluation
        source = 'ai'
      }
    } catch (error) {
      if (error instanceof VisionTransientError) {
        throw new InvoiceExtractionError('VISION_TEMPORARILY_UNAVAILABLE', true)
      }
      throw error
    }
  }

  if (!evaluation) {
    evaluation = evaluateLedger(
      {},
      { minConfidence: Number.POSITIVE_INFINITY },
    )
    source = 'human'
  }

  return {
    candidate: candidate ?? {},
    source,
    review: evaluation.review,
    confidence: evaluation.confidence,
    reasons: evaluation.reasons,
    pagesProcessed,
  } 
}   
