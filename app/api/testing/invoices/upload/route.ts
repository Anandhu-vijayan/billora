
import { NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'
import { getSupabaseAdmin, bucketFor } from '@/lib/supabase/server'
import {
  encryptFile,
  resolveFileKeyConfig,
} from '@/lib/encryption/files'
import {
  validateInvoiceMedia,
  MAX_FILE_BYTES,
} from '@/lib/media/file-type'
import { recordMediaIntake } from '@/lib/whatsapp/intake'
import { safeTokenEqual } from '@/lib/whatsapp/verify'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 1024 * 1024

function fail(status: number, code: string) {
  return NextResponse.json(
    { ok: false, error: { code } },
    {
      status,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}

function authorized(req: Request): boolean {
  if (process.env.BILLORA_TESTING_ENABLED !== 'true') return false

  const expected = process.env.BILLORA_TEST_TOKEN ?? ''
  const supplied = req.headers.get('x-billora-test-token') ?? ''

  if (expected.length < 32) return false
  return safeTokenEqual(supplied, expected)
}

export async function POST(req: Request): Promise<Response> {
  if (process.env.BILLORA_TESTING_ENABLED !== 'true') {
    return fail(404, 'NOT_FOUND')
  }

  if (!authorized(req)) {
    return fail(401, 'TEST_UNAUTHORIZED')
  }

  const workspaceId = process.env.BILLORA_TEST_WORKSPACE_ID ?? ''
  const clientId = process.env.BILLORA_TEST_CLIENT_ID?.trim() || null

  if (!UUID_RE.test(workspaceId) || (clientId && !UUID_RE.test(clientId))) {
    return fail(503, 'TEST_WORKSPACE_CONFIGURATION_INVALID')
  }

  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (contentLength > MAX_REQUEST_BYTES) {
    return fail(413, 'REQUEST_TOO_LARGE')
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return fail(400, 'INVALID_MULTIPART_FORM')
  }

  const file = form.get('file')
  const batchId = String(form.get('batchId') ?? '')

  if (!(file instanceof File)) {
    return fail(400, 'FILE_REQUIRED')
  }

  if (!UUID_RE.test(batchId)) {
    return fail(400, 'INVALID_BATCH_ID')
  }

  if (file.size < 32 || file.size > MAX_FILE_BYTES) {
    return fail(413, 'FILE_SIZE_INVALID')
  }

  const db = getSupabaseAdmin()

  // Never trust workspace/client identifiers from the request.
  const { data: workspace, error: workspaceError } = await db
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .maybeSingle()

  if (workspaceError || !workspace) {
    return fail(503, 'TEST_WORKSPACE_NOT_FOUND')
  }

  if (clientId) {
    const { data: client, error: clientError } = await db
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (clientError || !client) {
      return fail(503, 'TEST_CLIENT_NOT_FOUND')
    }
  }

  let plain: Buffer | null = null
  let encrypted: Buffer | null = null
  let objectPath: string | null = null
  let uploaded = false

  try {
    plain = Buffer.from(await file.arrayBuffer())

    if (plain.length !== file.size || plain.length > MAX_FILE_BYTES) {
      return fail(413, 'FILE_SIZE_INVALID')
    }

    const validated = validateInvoiceMedia({
      buffer: plain,
      declaredMime: file.type,
      declaredFilename: file.name,
    })

    const sha256Hex = createHash('sha256').update(plain).digest('hex')
    const { masterKeyHex } = resolveFileKeyConfig()

    // Random per-upload object key: no caller-controlled storage paths.
    objectPath = `http-test/${batchId}/${randomUUID()}.${validated.extension}`

    const enc = encryptFile(plain, masterKeyHex, {
      context: objectPath,
    })
    encrypted = enc.container

    const bucket = bucketFor('invoices')
    const { error: uploadError } = await db.storage
      .from(bucket)
      .upload(objectPath, encrypted, {
        contentType: 'application/octet-stream',
        upsert: false,
        cacheControl: 'private, max-age=0',
      })

    if (uploadError) {
      throw new Error(`TEST_STORAGE_UPLOAD_FAILED: ${uploadError.message}`)
    }
    uploaded = true

    const recorded = await recordMediaIntake(db, {
      workspaceId,
      clientId,
      objectPath,
      originalFileName: file.name.slice(0, 240),
      contentType: validated.mime,
      fileSha256Hex: sha256Hex,
      keyVersion: enc.keyVersion,
      sizeBytes: enc.sizeBytes,
    })

    return NextResponse.json(
      {
        ok: true,
        batchId,
        uploadId: recorded.invoiceId,
        invoiceId: recorded.invoiceId,
        jobId: recorded.jobId,
        invoicePreexisting: recorded.invoicePreexisting,
        jobPreexisting: recorded.jobPreexisting,
        file: {
          name: file.name.slice(0, 240),
          sizeBytes: enc.sizeBytes,
          contentType: validated.mime,
        },
      },
      {
        status: 202,
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  } catch (error) {
    // If the invoice/job write failed after storage upload, remove the orphan.
    if (uploaded && objectPath) {
      try {
        await db.storage.from(bucketFor('invoices')).remove([objectPath])
      } catch {
        // Cleanup is best-effort; do not expose storage details to the caller.
      }
    }

    const message = error instanceof Error ? error.message : ''

    if (message.startsWith('MEDIA_') || message.includes('UnsupportedMediaError')) {
      return fail(415, 'UNSUPPORTED_INVOICE_FILE')
    }

    console.error('[TestUpload] staging upload failed', {
      code: message.split(':')[0] || 'TEST_UPLOAD_FAILED',
    })

    return fail(500, 'TEST_UPLOAD_FAILED')
  } finally {
    plain?.fill(0)
    encrypted?.fill(0)
  }
}
