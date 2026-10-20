// lib/whatsapp/finalize.ts — "Done" session finalization.
//
// Done is not just an acknowledgment: it re-affirms that every eligible
// (workspace, client, month) batch has a register job scheduled, then reports a
// TRUTHFUL result based on what actually exists in the database at this moment.
// It NEVER claims a workbook is ready unless a generated_workbooks row exists —
// and that row is inserted by build_register only AFTER an encrypted upload
// succeeded, so a ready row is proof the stored file is available.
//
// Tenant isolation: every read/write is scoped by workspace_id. Delivery stays
// best-effort (rule 5): a send failure never rewinds processing state. This
// module is deliberately dependency-light (only an erased SupabaseClient type)
// so the pure message composer is unit-testable in-process.
import type { SupabaseClient } from '@supabase/supabase-js'

type Db = SupabaseClient

export interface FinalizeCounts {
  /** invoice_extraction jobs still queued/processing for this workspace. */
  outstanding: number
  /** register_generation jobs still queued/processing for this workspace. */
  compiling: number
  /** needs_review invoices that WERE assigned a reliable (client, month) batch. */
  needsReview: number
  /** needs_review invoices never batched because their date was missing/ambiguous. */
  missingDate: number
  /** Verified-ready workbooks (a row exists => the encrypted file was stored). */
  readyWorkbooks: number
  /** Ids of the verified-ready workbooks (newest first as returned). */
  readyWorkbookIds: string[]
}

/**
 * Pure: turn finalize counts into a truthful WhatsApp body. A download link is
 * appended ONLY when the caller verified a ready workbook exists; while any
 * extraction or register job is still running the message says "still working"
 * and never promises a finished Excel.
 *
 * needsReview and missingDate are DISJOINT (a needs_review invoice either did
 * or did not get a reliable-date batch), so each is reported with its own count
 * and never summed into the other — the reader sees exactly how many need a data
 * correction versus how many have no date to file them under.
 */
const attentionNote = (c: FinalizeCounts): string => {
  const parts: string[] = []
  if (c.needsReview > 0) parts.push(`${c.needsReview} invoice(s) need review`)
  if (c.missingDate > 0) parts.push(`${c.missingDate} have no clear invoice date`)
  return parts.length === 0 ? '' : ` ${parts.join(' and ')}.`
}

export function composeDoneMessage(
  c: FinalizeCounts,
  opts?: { link?: string | null },
): string {
  const attention = c.needsReview + c.missingDate
  if (c.outstanding > 0 || c.compiling > 0) {
    const parts = [
      c.outstanding > 0 ? `${c.outstanding} invoice(s) still processing` : null,
      c.compiling > 0 ? 'a register still compiling' : null,
    ].filter(Boolean).join(', ')
    return `Still working — ${parts}. I'll send your Excel register here as soon as it's ready.${attentionNote(c)}`
  }
  if (c.readyWorkbooks > 0) {
    const link = opts?.link ? ` Secure download (sign in required): ${opts.link}` : ''
    const n = c.readyWorkbooks
    return `Done — your register is ready (${n} workbook${n === 1 ? '' : 's'}).${link}${attentionNote(c)}`
  }
  if (attention > 0) {
    return `Done — but nothing is ready to export yet: ${attentionNote(c).trim()}. I won't guess a month, so they're held for you to correct.`
  }
  return 'Done — I have no invoices to compile for this session yet. Send invoice PDFs or photos anytime.'
}

/**
 * Pure: turn finalize counts into a truthful "Review" body. Unlike the old
 * review reply (which only counted rows), this states what is pending, why, and
 * how to finish it — and hands the download link IMMEDIATELY when a verified
 * ready workbook exists, instead of relying on some later inbound message to
 * deliver it. needsReview/missingDate are disjoint, so each is named with its
 * own count and never summed into the other.
 */
export function composeReviewMessage(
  c: FinalizeCounts,
  opts?: { link?: string | null },
): string {
  const attention = c.needsReview + c.missingDate
  if (c.readyWorkbooks > 0) {
    const link = opts?.link ? opts.link : 'your signed-in workspace'
    const parts: string[] = []
    if (c.needsReview > 0) parts.push(`${c.needsReview} invoice(s) still need review`)
    if (c.missingDate > 0) parts.push(`${c.missingDate} have no clear date`)
    const note = parts.length > 0 ? ` ${parts.join(' and ')} and are NOT in it yet.` : ''
    return `Your register is ready — download (sign in required): ${link}.${note}`
  }
  if (c.outstanding > 0) {
    return `Still processing ${c.outstanding} invoice(s). I'll tell you here once they're resolved.${attention > 0 ? ` ${attention} already need your review.` : ''}`
  }
  if (attention > 0) {
    return `${attention} invoice(s) need review before a register can be built${c.missingDate > 0 ? ` — ${c.missingDate} have no clear invoice date` : ''}. Correct and confirm each one (an invoice is only filed under the month on its own date, never a guessed one); once confirmed, its workbook is generated automatically.`
  }
  return 'Nothing needs your attention right now — keep sending invoices. Send Done to finalize a batch.'
}

/**
 * Outcome of a WhatsApp-native review confirmation. `ok:false` means the action
 * could not run (a fault / wrong tenant / already processed); `ok:true` carries
 * the re-evaluated review result from the shared engine.
 */
export interface ConfirmOutcome {
  ok: boolean
  review?: 'approved' | 'needs_review'
  reasons?: string[]
  invoiceNumber?: string | null
  vendorName?: string | null
  batchId?: string | null
  error?: 'NO_WORKSPACE' | 'NOT_FOUND' | 'NOT_PENDING' | 'FAULT'
}

// Map internal reason codes to a plain-English clause so the reviewer sees WHY
// an invoice is still held, never a raw code. Unknown codes are omitted rather
// than dumped verbatim.
const HUMAN_REASON: Record<string, string> = {
  'review-confirmation-required': 'the invoice number was not confirmed',
  'gstin-invalid': 'the GSTIN looks invalid',
  'gstin-missing': 'the GSTIN is missing',
  'total-mismatch': 'the amounts do not add up to the printed total',
  'taxable-base-missing': 'the taxable value is missing',
  'total-missing': 'the grand total is missing',
  'vendor-name-missing': 'the vendor name is missing',
  'invoice-number-missing': 'the invoice number is missing',
  'non-finite-amount': 'an amount is unreadable',
  'date-missing': 'there is no clear invoice date',
  'low-confidence': 'a field is still low-confidence',
}

function humanizeReasons(reasons: string[]): string {
  const seen = new Set<string>()
  for (const r of reasons) {
    const label = HUMAN_REASON[r.split(':')[0] ?? '']
    if (label) seen.add(label)
  }
  return [...seen].join('; ')
}

/**
 * Pure: turn a confirmation outcome into a truthful WhatsApp reply. An approval
 * promises the register only as a later, automatic delivery (never a link here,
 * since no workbook exists yet); a still-held invoice states the human reason.
 */
export function composeConfirmResultMessage(res: ConfirmOutcome): string {
  if (!res.ok) {
    if (res.error === 'NOT_FOUND') return "I couldn't find that invoice to confirm \u2014 send Review to see the current list."
    if (res.error === 'NOT_PENDING') return `#${res.invoiceNumber ?? 'That invoice'} is already processed \u2014 no confirmation needed. Send Review for the current list.`
    return 'Something went wrong confirming that invoice. Please try again, or send Review.'
  }
  const who = res.invoiceNumber
    ? `#${res.invoiceNumber}${res.vendorName ? ` (${res.vendorName})` : ''}`
    : 'That invoice'
  if (res.review === 'approved') {
    return `Confirmed ${who} \u2014 it's approved and filed under its own invoice month. Your Excel register will be sent here automatically once it's ready.`
  }
  const why = res.reasons && res.reasons.length > 0 ? humanizeReasons(res.reasons) : 'some required details are still incomplete'
  return `I recorded your confirmation for ${who}, but it still needs attention \u2014 ${why}. It stays flagged until that's corrected. Send Review anytime.`
}

async function countJobs(db: Db, workspaceId: string, jobType: string, statuses: string[]): Promise<number> {
  const { count, error } = await db
    .from('processing_jobs').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).eq('job_type', jobType).in('status', statuses)
  if (error) throw new Error(`FINALIZE_JOB_COUNT_ERROR: ${error.message}`)
  return count ?? 0
}

/**
 * Re-affirm that every batch holding this workspace's invoices has a live
 * register job. Idempotent: terminal (completed/failed) register rows are freed
 * so a rebuilt batch re-queues, while a job already queued/processing is left
 * alone (the partial unique index would reject a duplicate anyway). Called on
 * Done so a batch whose earlier register ran before a sibling settled is rebuilt.
 */
export async function ensureBatchRegisters(db: Db, workspaceId: string): Promise<number> {
  const { data: rows, error } = await db
    .from('invoices').select('batch_id')
    .eq('workspace_id', workspaceId).not('batch_id', 'is', null)
  if (error) throw new Error(`FINALIZE_BATCH_LIST_ERROR: ${error.message}`)
  const batchIds = [...new Set((rows ?? []).map((r) => (r as { batch_id: string }).batch_id))]
  let scheduled = 0
  for (const batchId of batchIds) {
    await db.from('processing_jobs').delete()
      .eq('workspace_id', workspaceId).eq('batch_id', batchId)
      .eq('job_type', 'register_generation').in('status', ['completed', 'failed'])
    const { data: live } = await db
      .from('processing_jobs').select('id')
      .eq('workspace_id', workspaceId).eq('batch_id', batchId)
      .eq('job_type', 'register_generation').in('status', ['queued', 'processing'])
      .limit(1)
    if ((live ?? []).length > 0) continue
    const { error: insErr } = await db.from('processing_jobs').insert({
      workspace_id: workspaceId, batch_id: batchId, invoice_id: null,
      job_type: 'register_generation', status: 'queued', max_attempts: 12,
    })
    // 23505 = a live register job already exists for this batch: exactly what we want.
    if (insErr && insErr.code !== '23505') throw new Error(`FINALIZE_ENQUEUE_ERROR: ${insErr.message}`)
    scheduled += 1
  }
  return scheduled
}

/** Read the current, truthful finalize state for a workspace. */
export async function collectFinalizeState(db: Db, workspaceId: string): Promise<FinalizeCounts> {
  const outstanding = await countJobs(db, workspaceId, 'invoice_extraction', ['queued', 'processing'])
  const compiling = await countJobs(db, workspaceId, 'register_generation', ['queued', 'processing'])

  const { count: needsReview, error: nrErr } = await db
    .from('invoices').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).eq('status', 'needs_review').not('batch_id', 'is', null)
  if (nrErr) throw new Error(`FINALIZE_REVIEW_COUNT_ERROR: ${nrErr.message}`)
  const { count: missingDate, error: mdErr } = await db
    .from('invoices').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).eq('status', 'needs_review').is('batch_id', null)
  if (mdErr) throw new Error(`FINALIZE_MISSINGDATE_COUNT_ERROR: ${mdErr.message}`)

  // A workbook is "ready" only when its DB row exists with a stored object path
  // (that row is inserted solely after a successful encrypted upload) and it has
  // not lapsed. The download route re-checks expiry + membership regardless.
  const { data: readyRows, error: readyErr } = await db
    .from('generated_workbooks').select('id,file_object_path,expires_at')
    .eq('workspace_id', workspaceId).eq('status', 'ready').not('file_object_path', 'is', null)
    .order('created_at', { ascending: false })
  if (readyErr) throw new Error(`FINALIZE_READY_ERROR: ${readyErr.message}`)
  const now = Date.now()
  const usable = (readyRows ?? [] as Array<{ id: string; file_object_path: string | null; expires_at: string | null }>)
    .filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now)

  return {
    outstanding,
    compiling,
    needsReview: needsReview ?? 0,
    missingDate: missingDate ?? 0,
    readyWorkbooks: usable.length,
    readyWorkbookIds: usable.map((r) => r.id),
  }
}
