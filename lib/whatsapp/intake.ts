// lib/whatsapp/intake.ts — durable webhook intake ledger + invoice/job lifecycle.
// webhook_events is the idempotency + recovery ledger:
//   received  = row inserted, work not yet durably accepted
//   accepted  = onboarding state + (media: invoice + job rows) persisted
//   failed    = attempt failed before durable acceptance; Meta retry reprocesses.
// Only `accepted` suppresses reprocessing. Retries are idempotent.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntakeStatus } from '@/lib/statuses'

export type { IntakeStatus } from '@/lib/statuses'

export interface IntakeRow {
  id: string
  provider_message_id: string
  status: IntakeStatus
  attempts: number
  processed_at: string | null
}

type Db = SupabaseClient

interface EventRow {
  insert: (row: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>
  select: (cols: string) => unknown
  update: (patch: Record<string, unknown>) => unknown
}

function eventsTable(db: Db) {
  return db.from('webhook_events') as unknown as EventRow
}

/** Insert-or-read the intake row. Returns the row + whether this delivery created it. */
export async function claimIntakeRow(
  db: Db,
  providerMessageId: string,
): Promise<{ row: IntakeRow; created: boolean }> {
  const table = eventsTable(db)
  const inserted = await table.insert({ provider_message_id: providerMessageId, status: 'received' })
  if (!inserted.error) {
    const read = (await (table.select('id,provider_message_id,status,attempts,processed_at') as {
      eq: (c: string, v: string) => {
        maybeSingle: () => Promise<{ data: IntakeRow | null; error: { message: string } | null }>
      }
    })
      .eq('provider_message_id', providerMessageId)
      .maybeSingle())
    if (read.error || !read.data) throw new Error(`INTAKE_READ_ERROR: ${read.error?.message ?? 'missing row'}`)
    return { row: read.data, created: true }
  }
  if (inserted.error.code !== '23505') throw new Error(`INTAKE_INSERT_ERROR: ${inserted.error.message}`)
  // Duplicate key: read the existing row to decide replay vs retry.
  const existing = (await (table.select('id,provider_message_id,status,attempts,processed_at') as {
    eq: (c: string, v: string) => {
      maybeSingle: () => Promise<{ data: IntakeRow | null; error: { message: string } | null }>
    }
  })
    .eq('provider_message_id', providerMessageId)
    .maybeSingle())
  if (existing.error || !existing.data) throw new Error(`INTAKE_READ_ERROR: ${existing.error?.message ?? 'missing row'}`)
  return { row: existing.data, created: false }
}

/** True only when a previous delivery durably accepted this message. */
export function isDurablyAccepted(row: IntakeRow): boolean {
  return row.status === 'accepted' && row.processed_at !== null
}

/**
 * Durably accept the event. `errorCode` accepts a permanent failure as final
 * (recorded for audit) so Meta redelivery is suppressed without a retry loop.
 */
export async function markIntakeAccepted(db: Db, providerMessageId: string, errorCode?: string): Promise<void> {
  const { error } = (await (eventsTable(db).update({
    status: 'accepted',
    processed_at: new Date().toISOString(),
    last_error_code: errorCode ? errorCode.slice(0, 120) : null,
  }) as {
    eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>
  }).eq('provider_message_id', providerMessageId))
  if (error) throw new Error(`INTAKE_ACCEPT_ERROR: ${error.message}`)
}

export async function markIntakeFailed(db: Db, providerMessageId: string, code: string): Promise<void> {
  const current = await claimIntakeRow(db, providerMessageId).catch(() => null)
  const attempts = (current?.row.attempts ?? 0) + 1
  const { error } = (await (eventsTable(db).update({
    status: 'failed',
    attempts,
    last_error_code: code.slice(0, 120),
  }) as {
    eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>
  }).eq('provider_message_id', providerMessageId))
  if (error) throw new Error(`INTAKE_FAIL_ERROR: ${error.message}`)
}

/**
 * Media lifecycle: invoice (received) + processing job (queued) in one
 * recoverable unit. STRICTLY IDEMPOTENT (Phase 3): a webhook redelivery that
 * arrives between the insert and the intake accept must not create a second
 * invoice row or a second job. Uniqueness is enforced in the database
 * (invoices.file_object_path, one job per invoice_id+job_type); on a 23505 we
 * read back the existing rows and reuse them.
 *
 * Never upsert here: overwriting an invoice that already progressed would
 * rewind its status, which the queue interprets as work to redo.
 */
export async function recordMediaIntake(
  db: Db,
  args: {
    workspaceId: string
    clientId: string | null
    objectPath: string
    originalFileName: string | null
    contentType: string
    fileSha256Hex?: string | null
    keyVersion?: string | null
    sizeBytes?: number | null
  },
): Promise<{ invoiceId: string; jobId: string; invoicePreexisting: boolean; jobPreexisting: boolean }> {
  const invoicePayload = {
    workspace_id: args.workspaceId,
    client_id: args.clientId,
    file_object_path: args.objectPath,
    original_file_name: args.originalFileName,
    content_type: args.contentType,
    file_sha256: args.fileSha256Hex ? `\\x${args.fileSha256Hex}` : null,
    file_encryption_key_version: args.keyVersion ?? null,
    size_bytes: args.sizeBytes ?? null,
    status: 'received',
  }
  const invoice = (await db.from('invoices').insert(invoicePayload).select('id').single() as unknown as {
    data: { id: string } | null
    error: { code?: string; message: string } | null
  })
  let invoiceId: string
  let invoicePreexisting = false
  if (!invoice.error && invoice.data) {
    invoiceId = invoice.data.id
  } else if (invoice.error?.code === '23505') {
    const existing = (await db.from('invoices').select('id')
      .eq('file_object_path', args.objectPath).limit(1).maybeSingle() as unknown as {
      data: { id: string } | null; error: { message: string } | null
    })
    if (existing.error || !existing.data) {
      throw new Error(`INVOICE_READ_ERROR: ${existing.error?.message ?? 'missing row after conflict'}`)
    }
    invoiceId = existing.data.id
    invoicePreexisting = true
  } else {
    throw new Error(`INVOICE_RECORD_ERROR: ${invoice.error?.message ?? 'missing id'}`)
  }

  const jobPayload = {
    workspace_id: args.workspaceId,
    invoice_id: invoiceId,
    job_type: 'invoice_extraction',
    status: 'queued',
  }
  const job = (await db.from('processing_jobs').insert(jobPayload).select('id').single() as unknown as {
    data: { id: string } | null
    error: { code?: string; message: string } | null
  })
  let jobId: string
  let jobPreexisting = false
  if (!job.error && job.data) {
    jobId = job.data.id
  } else if (job.error?.code === '23505') {
    const existing = (await db.from('processing_jobs').select('id')
      .eq('invoice_id', invoiceId).eq('job_type', 'invoice_extraction').limit(1).maybeSingle() as unknown as {
      data: { id: string } | null; error: { message: string } | null
    })
    if (existing.error || !existing.data) {
      throw new Error(`JOB_READ_ERROR: ${existing.error?.message ?? 'missing row after conflict'}`)
    }
    jobId = existing.data.id
    jobPreexisting = true
  } else {
    throw new Error(`JOB_RECORD_ERROR: ${job.error?.message ?? 'missing id'}`)
  }
  return { invoiceId, jobId, invoicePreexisting, jobPreexisting }
}

/**
 * Abuse / provider-quota guard: has this workspace already filed `limit` NEW
 * invoices in the current UTC day? Enforced at intake, BEFORE any extraction
 * job is created, because the job is what actually spends (gated) Gemini quota
 * and OCR/storage. `limit <= 0` disables the guard. A webhook redelivery of
 * THIS objectPath is excluded from the count, so a Meta retry of a file that
 * already took its slot is never falsely rejected (recordMediaIntake dedups it
 * downstream anyway). Throws on a count failure — a silent pass would defeat
 * the whole point of the guard.
 */
export async function isDailyIntakeLimitReached(
  db: Db,
  args: { workspaceId: string; limit: number; objectPath: string },
): Promise<boolean> {
  if (!Number.isFinite(args.limit) || args.limit <= 0) return false
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  const { count, error } = await db
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', args.workspaceId)
    .gte('received_at', dayStart.toISOString())
    .neq('file_object_path', args.objectPath)
  if (error) throw new Error(`INTAKE_LIMIT_COUNT_ERROR: ${error.message}`)
  return (count ?? 0) >= args.limit
}

// ---- Pending uploads ("receive first, ask later") -------------------------
// Media that arrives before the sender has a workspace — or before an
// organization client is explicitly confirmed — is stored privately and held
// here. Assignment binds workspace/client at confirmation time and creates the
// invoice + job rows. Nothing is ever silently reassigned (client safety rule).

/**
 * Hold a securely stored upload until workspace/client assignment resolves.
 * Upserts on object_path (deterministic per provider media id): a webhook
 * redelivery refreshes the hold instead of erroring, and NEVER resets the
 * status of an already-assigned file (status is not in the payload).
 */
export async function recordPendingUpload(
  db: Db,
  args: {
    senderHmac: string
    objectPath: string
    originalFileName: string | null
    contentType: string
    fileSha256Hex: string | null
    sizeBytes: number
    providerMediaId: string | null
    keyVersion?: string | null
  },
): Promise<string> {
  const row = (await db.from('pending_uploads').upsert({
    sender_hmac: args.senderHmac,
    object_path: args.objectPath,
    original_file_name: args.originalFileName,
    content_type: args.contentType,
    file_sha256: args.fileSha256Hex ? `\\x${args.fileSha256Hex}` : null,
    size_bytes: args.sizeBytes,
    file_encryption_key_version: args.keyVersion ?? null,
    provider_media_id: args.providerMediaId,
  }, { onConflict: 'object_path' }).select('id').single() as unknown as { data: { id: string } | null; error: { message: string } | null })
  if (row.error || !row.data) throw new Error(`PENDING_UPLOAD_RECORD_ERROR: ${row.error?.message ?? 'missing id'}`)
  return row.data.id
}

/** Number of held files still waiting for assignment (drives confirm prompts). */
export async function countWaitingUploads(db: Db, senderHmac: string): Promise<number> {
  const { count, error } = await db
    .from('pending_uploads')
    .select('id', { count: 'exact', head: true })
    .eq('sender_hmac', senderHmac)
    .eq('status', 'waiting_assignment')
  if (error) throw new Error(`PENDING_UPLOAD_COUNT_ERROR: ${error.message}`)
  return count ?? 0
}

/**
 * Assign every held file for this sender to (workspace, client) — called only
 * after explicit resolution (individual selection or confirmed client).
 * Each row: invoice + job created first, then the hold is marked assigned.
 */
export async function assignPendingUploads(
  db: Db,
  senderHmac: string,
  args: { workspaceId: string; clientId: string | null },
): Promise<number> {
  const { data: rows, error } = await db
    .from('pending_uploads')
    .select('id,object_path,original_file_name,content_type,file_sha256,size_bytes,file_encryption_key_version')
    .eq('sender_hmac', senderHmac)
    .eq('status', 'waiting_assignment')
    .order('created_at')
  if (error) throw new Error(`PENDING_UPLOAD_LIST_ERROR: ${error.message}`)
  let assigned = 0
  for (const row of (rows ?? []) as Array<{
    id: string; object_path: string; original_file_name: string | null;
    content_type: string; file_sha256: string | null;
    size_bytes: number | null; file_encryption_key_version: string | null
  }>) {
    const shaHex = typeof row.file_sha256 === 'string'
      ? row.file_sha256.replace(/^\\x/i, '')
      : null
    const { invoiceId } = await recordMediaIntake(db, {
      workspaceId: args.workspaceId,
      clientId: args.clientId,
      objectPath: row.object_path,
      originalFileName: row.original_file_name,
      contentType: row.content_type,
      fileSha256Hex: shaHex,
      keyVersion: row.file_encryption_key_version,
      sizeBytes: row.size_bytes,
    })
    const { error: updateError } = await db
      .from('pending_uploads')
      .update({ status: 'assigned', assigned_invoice_id: invoiceId, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'waiting_assignment')
    if (updateError) throw new Error(`PENDING_UPLOAD_ASSIGN_ERROR: ${updateError.message}`)
    assigned += 1
  }
  return assigned
}
