// lib/media/file-type.ts — authoritative, dependency-free media typing for intake.
//
// WhatsApp's declared mime_type / filename / extension are HINTS, never proof:
// a caller can claim image/png while sending bytes of any other shape. We sniff
// the ACTUAL leading bytes and only accept formats whose full path works
// (validate -> encrypt -> private store -> decrypt -> vision -> ledger). Formats
// that need a conversion we do not perform (HEIC/HEIF) are DETECTED so the user
// gets a precise reply, but never accepted — we do not advertise what we cannot
// process. This module imports nothing aliased so it is unit-testable in
// isolation (no logger, no env, no DB, no network).
//
// Limits guard oversized input, decompression bombs and resource exhaustion. We
// never trust a declared size alone: the real downloaded byte length is capped,
// and image dimensions / PDF page counts are parsed from the bytes themselves.

export type MediaKind = 'pdf' | 'jpeg' | 'png' | 'webp' | 'heif' | 'gif' | 'tiff' | 'unknown'

// Hard caps. MAX_FILE_BYTES stays under the 20 MiB bucket limit so a stored
// object is never rejected for size after we already accepted the upload.
export const MAX_FILE_BYTES = 15 * 1024 * 1024 // 15 MiB
export const MAX_IMAGE_PIXELS = 40_000_000 // ~40 MP — well past any real invoice
export const MAX_PDF_PAGES = 20
export const MIN_FILE_BYTES = 32 // anything smaller is not a real document

// Formats whose complete pipeline works. HEIC/HEIF are intentionally absent.
const ACCEPTED: Partial<Record<MediaKind, { mime: string; ext: string }>> = {
  pdf: { mime: 'application/pdf', ext: 'pdf' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
}

const GENERIC_UNSUPPORTED_REPLY =
  'Sorry, I can only process invoice PDF, JPG, PNG or WebP files. Please resend as one of those — or type Help.'

/** latin1 lets us compare raw leading bytes without any decoding surprises. */
function ascii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString('latin1')
}

/** Sniff the real container from magic bytes. Never trusts declared metadata. */
export function sniffMediaKind(buf: Buffer): MediaKind {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return 'unknown'
  // %PDF-
  if (buf[0] === 0x25 && ascii(buf, 0, 5) === '%PDF-') return 'pdf'
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png'
  // WEBP: 'RIFF' <size> 'WEBP'
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp'
  // HEIF/HEIC: ISO-BMFF 'ftyp' at byte 4 with a HEIC/AVC brand at 8.
  if (buf.length >= 12 && ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12).toLowerCase()
    if (/^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avci|avcs|avcp)$/.test(brand)) return 'heif'
  }
  // GIF: 'GIF8'
  if (ascii(buf, 0, 4) === 'GIF8') return 'gif'
  // TIFF: 'II*\0' (little) or 'MM\0*' (big)
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00)
    || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return 'tiff'
  return 'unknown'
}

/** True only for kinds that can actually be extracted end to end. */
export function isSupportedMediaKind(kind: MediaKind): boolean {
  return ACCEPTED[kind] !== undefined
}

/** Read canvas dimensions from PNG / JPEG / WebP headers. Defensive: null on any anomaly. */
export function readImageDimensions(kind: MediaKind, buf: Buffer): { width: number; height: number } | null {
  try {
    if (kind === 'png') {
      if (buf.length < 24 || ascii(buf, 12, 16) !== 'IHDR') return null
      const width = buf.readUInt32BE(16)
      const height = buf.readUInt32BE(20)
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (kind === 'jpeg') {
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off += 1; continue }
        const marker = buf[off + 1]
        // Standalone markers carry no length segment.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue }
        // Start-Of-Frame (baseline/progressive): dims live right after the header.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = buf.readUInt16BE(off + 5)
          const width = buf.readUInt16BE(off + 7)
          return width > 0 && height > 0 ? { width, height } : null
        }
        const segLen = buf.readUInt16BE(off + 2)
        if (segLen < 2) return null
        off += 2 + segLen
      }
      return null
    }
    if (kind === 'webp') {
      const fourcc = ascii(buf, 12, 16)
      if (fourcc === 'VP8X' && buf.length >= 30) {
        const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1
        const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1
        return { width, height }
      }
      if (fourcc === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
        const bits = buf.readUInt32LE(21)
        const width = (bits & 0x3fff) + 1
        const height = ((bits >>> 14) & 0x3fff) + 1
        return { width, height }
      }
      if (fourcc === 'VP8 ' && buf.length >= 30) {
        // Locate the 3-byte sync code (0x9d 0x01 0x2a) that precedes the size.
        for (let i = 20; i < 40 && i + 7 < buf.length; i++) {
          if (buf[i] === 0x9d && buf[i + 1] === 0x01 && buf[i + 2] === 0x2a) {
            const width = buf.readUInt16LE(i + 3) & 0x3fff
            const height = buf.readUInt16LE(i + 5) & 0x3fff
            return width > 0 && height > 0 ? { width, height } : null
          }
        }
        return null
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Best-effort PDF page count by scanning the object structure for `/Type /Page`
 * (excluding `/Pages`). Linearized/object-stream PDFs can under-report, so a
 * null result (or 0) is treated as "unknown" and is NOT a rejection — the byte
 * cap is the hard guard; this is a defense-in-depth check for flat PDFs.
 */
export function estimatePdfPageCount(buf: Buffer): number | null {
  if (buf.length < 8 || ascii(buf, 0, 5) !== '%PDF-') return null
  const text = buf.toString('latin1')
  let count = 0
  const re = /\/Type\s*\/Page(?![s\/])/g
  while (re.exec(text) !== null) count++
  return count > 0 ? count : null
}

export interface ValidatedMedia {
  kind: MediaKind
  /** Authoritative MIME from the SNIFFED bytes (never the declared hint). */
  mime: string
  /** Validated safe extension for the sniffed kind. */
  extension: string
  width: number | null
  height: number | null
  pages: number | null
}

/** A file whose real format is not one we can process. Retry can never help. */
export class UnsupportedMediaError extends Error {
  override name = 'UnsupportedMediaError'
  constructor(message: string, readonly userReply: string) {
    super(message)
  }
}

/** A file that exceeds a byte / pixel / page limit. Retry can never help. */
export class OversizeMediaError extends Error {
  override name = 'OversizeMediaError'
  constructor(message: string, readonly userReply: string) {
    super(message)
  }
}

/**
 * Validate downloaded bytes: sniff the real type, reject unsupported/mismatched
 * content, and enforce size, pixel and PDF-page limits. Declared MIME/filename
 * are ignored except as a hint for the reply. Throws UnsupportedMediaError or
 * OversizeMediaError (both permanent) on rejection; returns the authoritative
 * validated descriptor on success.
 */
export function validateInvoiceMedia(args: {
  buffer: Buffer
  declaredMime?: string | null
  declaredFilename?: string | null
}): ValidatedMedia {
  const { buffer } = args
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_FILE_BYTES) {
    throw new UnsupportedMediaError('MEDIA_TOO_SMALL', GENERIC_UNSUPPORTED_REPLY)
  }
  const kind = sniffMediaKind(buffer)
  if (kind === 'heif') {
    throw new UnsupportedMediaError(
      'MEDIA_UNSUPPORTED_HEIF',
      "I can't read HEIC/HEIF photos. Please resend the invoice as a PDF, JPG or PNG screenshot.",
    )
  }
  const accepted = ACCEPTED[kind]
  if (!accepted) {
    throw new UnsupportedMediaError(`MEDIA_UNSUPPORTED_${kind.toUpperCase()}`, GENERIC_UNSUPPORTED_REPLY)
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new OversizeMediaError(
      'MEDIA_TOO_LARGE_BYTES',
      `That file is too large for me to process (over ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB). Please resend a smaller PDF, JPG or PNG.`,
    )
  }

  let width: number | null = null
  let height: number | null = null
  let pages: number | null = null
  if (kind === 'pdf') {
    pages = estimatePdfPageCount(buffer)
    if (pages !== null && pages > MAX_PDF_PAGES) {
      throw new OversizeMediaError(
        'MEDIA_TOO_MANY_PAGES',
        `That PDF has more than ${MAX_PDF_PAGES} pages. Please send only the invoice page(s).`,
      )
    }
  } else {
    const dims = readImageDimensions(kind, buffer)
    if (dims) {
      width = dims.width
      height = dims.height
      if (width * height > MAX_IMAGE_PIXELS) {
        throw new OversizeMediaError(
          'MEDIA_TOO_MANY_PIXELS',
          'That image is too large (too many pixels). Please resend a lower-resolution photo or a PDF.',
        )
      }
    }
  }
  return { kind, mime: accepted.mime, extension: accepted.ext, width, height, pages }
}

/** A format/size rejection that no retry can fix — settle the intake as final. */
export function isPermanentMediaFormatFailure(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'UnsupportedMediaError' || error.name === 'OversizeMediaError')
}
