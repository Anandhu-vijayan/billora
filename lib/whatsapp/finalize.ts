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
import { monthLabel, workbookFileName } from '../exports/naming'
import { wakeWorker } from '../jobs/wake'

type Db = SupabaseClient

/** One ready month in the bulk summary (§P1-5): its label, file name, invoice count. */
export interface ReadyMonth {
  workbookId: string
  /** 'Oct 2026' or null when the batch carries no resolvable period. */
  monthLabel: string | null
  fileName: string
  invoiceCount: number
  /** The batch's raw period_start ISO date; null when unresolvable. Delivery scope keys on this. */
  periodStart?: string | null
}

/**
 * Delivery scope (§wrong-month fix): the client the finalize reply is served to.
 * `undefined` = legacy unscoped (workspace-wide) read; `null` = individual (only
 * batches with no client); a UUID = only that client's batches. Without it, a
 * Done tap in an org workspace could attach ANOTHER client's — or an older
 * month's — still-'ready' workbook, which is exactly the wrong-month leak.
 */
export interface DeliveryScope {
  clientId?: string | null
}

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
  /** Per-month breakdown of the ready registers (§P1-5); optional for legacy callers. */
  readyMonths?: ReadyMonth[]
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

/**
 * Pure (§P1-5): a per-month breakdown for a MULTI-month bulk delivery. Returns ''
 * for fewer than two ready months so the single-register wording (and its tests)
 * is untouched. Each line names the month, the exact downloadable file, and how
 * many filed invoices it holds — so an accountant sees what they are getting.
 */
export function renderMonthBreakdown(months: ReadyMonth[] | undefined): string {
  if (!months || months.length < 2) return ''
  const lines = months.map((m) => {
    const label = m.monthLabel ?? 'Undated'
    const count = m.invoiceCount > 0 ? ` — ${m.invoiceCount} invoice(s)` : ''
    return `• ${label}: ${m.fileName}${count}`
  })
  return `\n${lines.join('\n')}\n`
}

export function composeDoneMessage(
  c: FinalizeCounts,
  opts?: { link?: string | null; delivered?: boolean },
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
    const n = c.readyWorkbooks
    const breakdown = renderMonthBreakdown(c.readyMonths)
    const suffix = opts?.delivered
      ? ' I have attached the Excel file(s) here in this chat.'
      : (opts?.link ? ` Secure download (sign in required): ${opts.link}` : '')
    return `Done — your register is ready (${n} workbook${n === 1 ? '' : 's'}).${breakdown}${suffix}${attentionNote(c)}`
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
  opts?: { link?: string | null; delivered?: boolean },
): string {
  const attention = c.needsReview + c.missingDate
  if (c.readyWorkbooks > 0) {
    const parts: string[] = []
    if (c.needsReview > 0) parts.push(`${c.needsReview} invoice(s) still need review`)
    if (c.missingDate > 0) parts.push(`${c.missingDate} have no clear date`)
    const note = parts.length > 0 ? ` ${parts.join(' and ')} and are NOT in it yet.` : ''
    const breakdown = renderMonthBreakdown(c.readyMonths)
    if (opts?.delivered) {
      return `Your register is ready — I have attached the Excel file here in this chat.${breakdown}${note}`
    }
    const link = opts?.link ? opts.link : 'your signed-in workspace'
    return `Your register is ready — download (sign in required): ${link}.${breakdown}${note}`
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
export async function ensureBatchRegisters(db: Db, workspaceId: string, scope?: DeliveryScope): Promise<number> {
  const { data: rows, error } = await db
    .from('invoices').select('batch_id')
    .eq('workspace_id', workspaceId).not('batch_id', 'is', null)
  if (error) throw new Error(`FINALIZE_BATCH_LIST_ERROR: ${error.message}`)
  let batchIds = [...new Set((rows ?? []).map((r) => (r as { batch_id: string }).batch_id))]
  // Scoped Done must never re-arm another client's batch (individuals own only
  // client-less batches; org senders own only their selected client's).
  if (scope?.clientId !== undefined && batchIds.length > 0) {
    batchIds = await filterBatchesByClient(db, workspaceId, batchIds, scope.clientId)
  }
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
  // Newly-scheduled register work deserves an immediate best-effort tick so the
  // rebuilt workbook is ready in seconds, not on the next cron (§P2-9). No-op when
  // nothing was scheduled or the deployment is unconfigured; the cron is the backstop.
  if (scheduled > 0) wakeWorker()
  return scheduled
}

/**
 * Resolve which of these batches belong to the scope's client. Individuals
 * (clientId null) own only client-less batches; org senders own only their
 * selected client's. A read failure narrows to NO batches (fail-closed: wrong-
 * month/tenant delivery is worse than a silent Done).
 */
async function filterBatchesByClient(
  db: Db, workspaceId: string, batchIds: string[], clientId: string | null,
): Promise<string[]> {
  const q = db
    .from('invoice_batches').select('id,client_id')
    .eq('workspace_id', workspaceId).in('id', batchIds)
  const { data, error } = await (clientId === null ? q.is('client_id', null) : q.eq('client_id', clientId))
  // A read failure narrows to NONE (fail-closed). This module is deliberately
  // dependency-light (unit-testable in-process), so no logger import here — the
  // calling route already logs the finalize outcome truthfully.
  if (error) return []
  return (data ?? [] as Array<{ id: string }>).map((b) => b.id)
}

/**
 * Pure (§wrong-month fix): pick the ONE workbook a summary download link should
 * point at. Deterministic ordering — latest accounting period first, then the
 * newest generation, then id — so a stale September register can never win the
 * link position merely because of row order. Returns null when nothing is ready.
 */
export function pickPrimaryWorkbook(months: readonly ReadyMonth[]): ReadyMonth | null {
  let best: ReadyMonth | null = null
  for (const m of months) {
    if (!m || !m.workbookId) continue
    if (!best) { best = m; continue }
    const a = `${m.periodStart ?? ''}|${m.workbookId}`
    const b = `${best.periodStart ?? ''}|${best.workbookId}`
    if (a > b) best = m
  }
  return best
}

/** Read the current, truthful finalize state for a workspace (optionally scoped to one client's batches). */
export async function collectFinalizeState(db: Db, workspaceId: string, scope?: DeliveryScope): Promise<FinalizeCounts> {
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
  // When a client scope is supplied, ONLY that tenant's batches qualify — an
  // older month's still-'ready' workbook from another client is never listed.
  let scopedBatchIds: string[] | null = null
  if (scope?.clientId !== undefined) {
    const { data: invRows, error: invErr } = await db
      .from('invoices').select('batch_id')
      .eq('workspace_id', workspaceId).not('batch_id', 'is', null)
    if (invErr) throw new Error(`FINALIZE_SCOPE_ERROR: ${invErr.message}`)
    const allBatchIds = [...new Set((invRows ?? []).map((r) => (r as { batch_id: string }).batch_id))]
    scopedBatchIds = await filterBatchesByClient(db, workspaceId, allBatchIds, scope.clientId)
    if (scopedBatchIds.length === 0) {
      return {
        outstanding, compiling, needsReview: needsReview ?? 0, missingDate: missingDate ?? 0,
        readyWorkbooks: 0, readyWorkbookIds: [], readyMonths: [],
      }
    }
  }
  const readyQuery = db
    .from('generated_workbooks').select('id,batch_id,file_object_path,expires_at')
    .eq('workspace_id', workspaceId).eq('status', 'ready').not('file_object_path', 'is', null)
    .order('created_at', { ascending: false })
  const { data: readyRows, error: readyErr } = await (scopedBatchIds ? readyQuery.in('batch_id', scopedBatchIds) : readyQuery)
  if (readyErr) throw new Error(`FINALIZE_READY_ERROR: ${readyErr.message}`)
  const now = Date.now()
  const usable = (readyRows ?? [] as Array<{ id: string; batch_id: string | null; file_object_path: string | null; expires_at: string | null }>)
    .filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now)

  // Per-month breakdown (§P1-5): resolve each ready batch's own accounting period
  // and count its filed invoices. These reads are a DISPLAY nicety — a failure
  // here must never regress the truthful ready count, so errors leave the maps
  // empty and each month falls back to a generic name / zero count.
  const batchIds = [...new Set(usable.map((r) => r.batch_id).filter((b): b is string => !!b))]
  const periodByBatch = new Map<string, string | null>()
  const countByBatch = new Map<string, number>()
  if (batchIds.length > 0) {
    const { data: batches } = await db
      .from('invoice_batches').select('id,period_start')
      .eq('workspace_id', workspaceId).in('id', batchIds)
    for (const b of (batches ?? [] as Array<{ id: string; period_start: string | null }>)) {
      periodByBatch.set(b.id, b.period_start ?? null)
    }
    const { data: filed } = await db
      .from('invoices').select('batch_id')
      .eq('workspace_id', workspaceId).eq('status', 'completed').in('batch_id', batchIds)
    for (const v of (filed ?? [] as Array<{ batch_id: string | null }>)) {
      if (v.batch_id) countByBatch.set(v.batch_id, (countByBatch.get(v.batch_id) ?? 0) + 1)
    }
  }
  const readyMonths: ReadyMonth[] = usable.map((r) => {
    const period = r.batch_id ? periodByBatch.get(r.batch_id) ?? null : null
    return {
      workbookId: r.id,
      monthLabel: monthLabel(period),
      fileName: workbookFileName(period),
      invoiceCount: r.batch_id ? countByBatch.get(r.batch_id) ?? 0 : 0,
      periodStart: period,
    }
  })

  return {
    outstanding,
    compiling,
    needsReview: needsReview ?? 0,
    missingDate: missingDate ?? 0,
    readyWorkbooks: usable.length,
    readyWorkbookIds: usable.map((r) => r.id),
    readyMonths,
  }
}
