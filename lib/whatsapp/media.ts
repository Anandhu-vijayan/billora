// lib/whatsapp/media.ts — WhatsApp media download pipeline (image/document/pdf).
import { logger } from '@/lib/logger'
import { MAX_FILE_BYTES, OversizeMediaError } from '@/lib/media/file-type'

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'
const FETCH_TIMEOUT_MS = 15_000
// Media upload carries a whole file body, so it gets a longer budget than a
// metadata/download GET. A timeout here is transient (retryable) by contract.
const UPLOAD_TIMEOUT_MS = 30_000

/** MIME → safe file extension for invoice media (images + pdf). */
export function extensionForMime(mime: string | undefined): string {
  const m = (mime || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('png')) return 'png'
  if (m.includes('webp')) return 'webp'
  if (m.includes('pdf')) return 'pdf'
  return 'bin'
}

export function contentTypeForMime(mime: string | undefined, fallbackExt: string): string {
  if (mime) return mime
  if (fallbackExt === 'jpg') return 'image/jpeg'
  if (fallbackExt === 'png') return 'image/png'
  if (fallbackExt === 'webp') return 'image/webp'
  if (fallbackExt === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

async function fetchWithTimeout(url: string, token: string): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(t)
  }
}

// Graph API codes where retrying is futile — the credential itself is broken
// (same families as send.ts): an expired token never becomes valid again.
const PERMANENT_GRAPH_CODES = new Set([102, 190, 200, 210, 463, 464, 2068])

export function isPermanentMediaFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'MediaPermanentError'
}

/** Media will never download for this delivery: expired/blocked credential. */
export class MediaPermanentError extends Error {
  override name = 'MediaPermanentError'
}

export interface DownloadedMedia {
  buffer: Buffer
  mimeType: string
  extension: string
  contentType: string
  size: number
}

/**
 * Step 1: media ID → Meta Graph API → temporary download URL.
 * Step 2: download URL → raw binary buffer.
 * Throws on any failure; caller must catch and still return 200 to Meta.
 */
export async function downloadWhatsAppMedia(args: {
  mediaId: string
  accessToken: string
  declaredMime?: string
}): Promise<DownloadedMedia> {
  const { mediaId, accessToken, declaredMime } = args
  if (!mediaId) throw new Error('MEDIA_FAULT: missing media id')
  if (!accessToken) throw new Error('MEDIA_FAULT: WHATSAPP_ACCESS_TOKEN is not configured')

  // Step 1 — resolve the temporary download URL (verification: `url` string, not an error object).
  const metaRes = await fetchWithTimeout(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, accessToken)
  const meta = (await metaRes.json().catch(() => null)) as {
    url?: string
    mime_type?: string
    file_size?: number
    error?: { message?: string; code?: number }
  } | null
  if (!metaRes.ok || !meta?.url) {
    // Surface Meta's message + numeric code (never the token or signed URL).
    // Credential-blocked codes throw MediaPermanentError: retrying cannot help,
    // so callers must NOT return 503 (that would loop Meta redeliveries).
    const detail = `${meta?.error?.message || `Graph API ${metaRes.status} with no url`}`
      + (meta?.error?.code !== undefined ? ` (graph code ${meta?.error.code})` : '')
    if (meta?.error?.code !== undefined && PERMANENT_GRAPH_CODES.has(meta.error.code)) {
      throw new MediaPermanentError(`META_MEDIA_UNRECOVERABLE: ${detail}`)
    }
    if (!metaRes.ok && (metaRes.status === 401 || metaRes.status === 403)) {
      throw new MediaPermanentError(`META_MEDIA_UNRECOVERABLE: ${detail} (http ${metaRes.status})`)
    }
    throw new Error(`META_MEDIA_ERROR: ${detail}`)
  }

  // Step 2 — download raw bytes (verification: non-empty buffer).
  // Declared size is a hint, but a body already reported far over our cap is
  // rejected before we spend bandwidth fetching it. Real byte length is capped
  // authoritatively by validateInvoiceMedia after download.
  if (typeof meta.file_size === 'number' && meta.file_size > MAX_FILE_BYTES) {
    throw new OversizeMediaError(
      'MEDIA_DECLARED_TOO_LARGE',
      `That file is too large for me to process (over ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB). Please resend a smaller PDF, JPG or PNG.`,
    )
  }
  const fileRes = await fetchWithTimeout(meta.url, accessToken)
  if (!fileRes.ok) {
    if (fileRes.status === 401 || fileRes.status === 403) {
      throw new MediaPermanentError(`MEDIA_DOWNLOAD_ERROR: HTTP ${fileRes.status} (credential rejected)`)
    }
    throw new Error(`MEDIA_DOWNLOAD_ERROR: HTTP ${fileRes.status}`)
  }
  const bytes = await fileRes.arrayBuffer()
  if (bytes.byteLength === 0) throw new Error('MEDIA_DOWNLOAD_ERROR: empty body')

  const mimeType = meta.mime_type || declaredMime || 'application/octet-stream'
  const extension = extensionForMime(mimeType)
  const headerMime = fileRes.headers.get('content-type')?.split(';')[0]?.trim()
  const contentType = contentTypeForMime(headerMime || mimeType, extension)

  const downloaded: DownloadedMedia = {
    buffer: Buffer.from(bytes),
    mimeType,
    extension,
    contentType,
    size: bytes.byteLength,
  }
  logger.info('[WhatsApp] media downloaded', {
    mimeType: downloaded.mimeType,
    extension,
    size: downloaded.size,
    declaredSize: meta.file_size ?? null,
  })
  return downloaded
}

/**
 * Upload a small file (the decrypted register) to the WhatsApp Media API and
 * return its media id, so it can be sent back to the OWNER as a document. This
 * is the delivery counterpart to downloadWhatsAppMedia: the workbook is
 * encrypted at rest, so it can only ever be handed to an authenticated
 * recipient — here, the workspace owner's own chat. Never logs the bytes, the
 * mime-specific contents, or the resulting media id.
 *
 * Credential-level rejections throw MediaPermanentError (retry is futile); any
 * other failure throws a plain Error the caller treats as transient.
 */
export async function uploadWhatsAppMedia(args: {
  buffer: Buffer
  mimeType: string
  filename?: string
}): Promise<string> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || ''
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
  if (!token || !phoneNumberId) {
    throw new MediaPermanentError('META_UPLOAD_CONFIG_MISSING: WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID unset')
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', args.mimeType)
    // Copy into a plain ArrayBuffer: Blob's part type is ArrayBufferView<ArrayBuffer>
    // and a Node Buffer is ArrayBufferLike, which TS rejects.
    const ab = new ArrayBuffer(args.buffer.byteLength)
    new Uint8Array(ab).set(args.buffer)
    form.append('file', new Blob([ab], { type: args.mimeType }), args.filename ?? 'file')
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: ctrl.signal,
    })
    const body = (await res.json().catch(() => null)) as
      { id?: string; error?: { message?: string; code?: number } } | null
    if (!res.ok || !body?.id) {
      const detail = `${body?.error?.message || `Graph API ${res.status} with no media id`}`
        + (body?.error?.code !== undefined ? ` (graph code ${body.error.code})` : '')
      if (body?.error?.code !== undefined && PERMANENT_GRAPH_CODES.has(body.error.code)) {
        throw new MediaPermanentError(`META_UPLOAD_UNRECOVERABLE: ${detail}`)
      }
      if (res.status === 401 || res.status === 403) {
        throw new MediaPermanentError(`META_UPLOAD_UNRECOVERABLE: ${detail} (http ${res.status})`)
      }
      throw new Error(`META_UPLOAD_ERROR: ${detail}`)
    }
    logger.info('[WhatsApp] media uploaded for delivery', { size: args.buffer.byteLength })
    return body.id
  } finally {
    clearTimeout(t)
  }
}
