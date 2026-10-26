// lib/ocr/pdf.ts — REAL PDF text layer + first-page rasterization (server only).
//
// This is the local engine the hybrid pipeline leans on. It does two genuine,
// verifiable things with pdf.js:
//   1. extractPdfTextLayer(): pull the embedded text layer of every page (no
//      model, no network). A digital PDF gives real text; a scan gives almost
//      nothing, which the caller treats as "needs the image path".
//   2. renderFirstPageToPng(): rasterize ONLY the first page to a PNG via a real
//      canvas, for the (privacy-gated) AI fallback on scanned/ambiguous input.
//      Rendering one page keeps cost bounded and never touches every page.
//
// Dependencies are imported LAZILY and every failure resolves to null/'' — an
// unavailable engine is reported honestly so extraction routes to needs_review,
// never a fabricated result. Nothing here reads the DB or storage; it is pure
// bytes-in / data-out. This module is intentionally NOT importable by the
// single-file test harness (it pulls pdf.js + a native canvas), so it is covered
// by source-contract tests, while its parsing output (text-parser.ts) is unit
// tested directly.
import { createRequire } from 'node:module'

const PDFJS_LEGACY = 'pdfjs-dist/legacy/build/pdf.mjs'
const CANVAS_PKG = '@napi-rs/canvas'

type PdfModule = {
  getDocument: (opts: Record<string, unknown>) => { promise: Promise<PdfDoc> }
}
interface PdfDoc {
  numPages: number
  getPage: (n: number) => Promise<PdfPage>
  destroy?: () => Promise<void>
}
interface PdfTextItem { str: string }
interface PdfPage {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>
  getViewport: (opts: { scale: number }) => { width: number; height: number }
  render: (opts: Record<string, unknown>) => { promise: Promise<void> }
}

const RENDER_SCALE = 2 // ~144 dpi at letter size: legible for vision, bounded.
const MAX_RENDER_DIM = 2400 // hard ceiling so a huge page cannot balloon memory.
const MAX_PDF_PAGES = 10

/** Resolve pdf.js's bundled standard-fonts dir so glyph rendering has data. */
function standardFontDataUrl(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkg = req.resolve('pdfjs-dist/package.json')
    // posix + windows safe: file URL to <pkg>/standard_fonts/
    const dir = pkg.replace(/[\\/]package\.json$/, '') + '/standard_fonts/'
    return dir
  } catch {
    return undefined
  }
}

async function loadPdfjs(): Promise<PdfModule | null> {
  try {
    const mod = (await import(/* webpackIgnore: true */ PDFJS_LEGACY)) as unknown
    // Legacy build exposes getDocument at top level (and on .default for CJS).
    const asNs = mod as { getDocument?: PdfModule['getDocument']; default?: { getDocument?: PdfModule['getDocument'] } }
    const getDocument = asNs.getDocument ?? asNs.default?.getDocument
    if (!getDocument) return null
    return { getDocument }
  } catch {
    return null
  }
}

function toUint8(buffer: Buffer): Uint8Array {
  // Return a PRIVATE copy, never a view over the caller's ArrayBuffer.
  // pdf.js treats `data` as transferable and DETACHES its backing ArrayBuffer
  // (it posts it to the worker). The caller here is the decrypted media buffer,
  // so sharing its backing store would leave the handler holding a detached,
  // zero-length buffer: the AI vision fallback then sees EMPTY_MEDIA, and the
  // plaintext wipe `plain.fill(0)` throws
  // "Cannot perform %TypedArray%.prototype.fill on a detached ArrayBuffer".
  // Copying keeps pdf.js's transfer separate from the caller's bytes.
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy
}

async function openDoc(pdfjs: PdfModule, buffer: Buffer): Promise<PdfDoc> {
  return pdfjs.getDocument({
    data: toUint8(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableAutoFetch: true,
    standardFontDataUrl: standardFontDataUrl(),
  }).promise
}

/**
 * Extract the embedded text layer as ONE STRING PER PAGE (index 0 = page 1),
 * bounded by maxPages. Page boundaries are preserved so a caller can GROUP pages
 * by invoice number instead of blindly concatenating a multi-invoice PDF into a
 * single read (§P3-14). A scanned/image PDF yields near-empty per-page strings —
 * an honest nothing, never a guess.
 */
export async function extractPdfTextLayerPages(
  buffer: Buffer,
  maxPages = MAX_PDF_PAGES,
): Promise<string[]> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PDF_PAGES) {
    throw new Error(`maxPages must be between 1 and ${MAX_PDF_PAGES}`)
  }
  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('PDF_ENGINE_UNAVAILABLE: pdf.js not resolvable')
  const doc = await openDoc(pdfjs, buffer)
  try {
    const chunks: string[] = []
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n += 1) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      chunks.push(content.items.map((it) => it.str).join('\n'))
    }
    return chunks
  } finally {
    await doc.destroy?.().catch(() => {})
  }
}

/**
 * Extract the embedded text layer from at most ten pages, joined into a single
 * string. Kept for callers that do not need page boundaries; a scanned/image PDF
 * returns '' — an honest empty, never a guess.
 */
export async function extractPdfTextLayer(
  buffer: Buffer,
  maxPages = MAX_PDF_PAGES,
): Promise<string> {
  const pages = await extractPdfTextLayerPages(buffer, maxPages)
  return pages.join('\n')
}

/**
 * Rasterize ONLY the first page to a PNG buffer for the AI fallback. Returns
 * null when the engine or a real canvas is unavailable (the caller then reports
 * an honest miss instead of sending a blank image). Never renders extra pages.
 */
export async function renderFirstPageToPng(buffer: Buffer): Promise<Buffer | null> {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) return null
  let canvasLib: { createCanvas: (w: number, h: number) => {
    getContext: (t: '2d') => CanvasRenderingContext2D; width: number; height: number
    toBuffer: (type: 'image/png') => Buffer
  } }
  try {
    canvasLib = (await import(/* webpackIgnore: true */ CANVAS_PKG)) as unknown as typeof canvasLib
  } catch {
    return null
  }
  const doc = await openDoc(pdfjs, buffer)
  try {
    const page = await doc.getPage(1) // FIRST PAGE ONLY — by design.
    let viewport = page.getViewport({ scale: RENDER_SCALE })
    if (viewport.width > MAX_RENDER_DIM || viewport.height > MAX_RENDER_DIM) {
      const shrink = Math.min(MAX_RENDER_DIM / viewport.width, MAX_RENDER_DIM / viewport.height)
      viewport = page.getViewport({ scale: RENDER_SCALE * shrink })
    }
    const canvas = canvasLib.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    // pdf.js paints on a transparent canvas; composite onto white so the image
    // path fed to vision looks like paper, not alpha holes.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    return canvas.toBuffer('image/png')
  } finally {
    await doc.destroy?.().catch(() => {})
  }
}

/** True only when BOTH a resolvable pdf.js and a canvas are present. */
export async function pdfEngineAvailable(): Promise<boolean> {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) return false
  try {
    await import(/* webpackIgnore: true */ CANVAS_PKG)
    return true
  } catch {
    return false
  }
}
