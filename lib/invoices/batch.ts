// lib/invoices/batch.ts — shared invoice -> (client, month) batch + register scheduling.
//
// This is the SINGLE place that folds an extracted or human-confirmed invoice into
// its real accounting period and makes sure a register workbook is scheduled for
// that period. It is used by BOTH the extraction job (auto path) and the human
// review path, so the two can never diverge on how a batch is resolved or how a
// register job is deduped — the exact requirement "the invoice's batch association
// and the job/readiness logic must agree."
//
// Safety rules it enforces:
//   * The period is derived ONLY from a reliably parsed invoice date. A missing or
//     ambiguous date NEVER falls back to the upload/received month — the invoice
//     stays unbatched and visible in review instead of being filed in a guessed month.
//   * Batches are scoped to the invoice's OWN client + workspace, so an organization
//     can never mix two clients in one workbook.
//   * Register scheduling is coalesced, not lossy: at most one queued follow-up
//     exists per batch. A new invoice may enqueue that follow-up WHILE a register
//     is processing, so a build that started from an earlier membership snapshot
//     cannot suppress the rebuild for a late-finishing extraction. The DB claim
//     function prevents the follow-up from running until the current build settles.
//
// Type-only external imports keep this module in-process testable (the test
// harness transpiles a single file and cannot resolve runtime `@/` imports).
import type { SupabaseClient } from '@supabase/supabase-js'

type Db = SupabaseClient

/** A minimal shape: anything carrying a canonical `YYYY-MM-DD` invoice date. */
export interface DateBearingRow {
  invoice_date?: string | null
}

/** The invoice fields this module needs to resolve a batch (subset of InvoiceRow). */
export interface BatchInvoiceRef {
  client_id?: string | null
  batch_id?: string | null
}

/** First/last calendar day of the month containing `dateIso` (YYYY-MM-DD). */
export function monthBounds(dateIso: string): { start: string; end: string } {
  const [y, m] = dateIso.split('-').map(Number)
  const year = y ?? 1970
  const month = m ?? 1
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { start, end }
}

/**
 * Schedule the batch's register workbook job. At most one QUEUED job is allowed
 * per batch. If a register is already PROCESSING, we still insert one queued
 * follow-up: an invoice extraction can join the batch after the current build
 * took its membership snapshot, and suppressing that enqueue would permanently
 * omit the late invoice. The claim RPC serializes register jobs per batch, so
 * this follow-up cannot run until the current build settles. A concurrent 23505
 * means another caller already created the queued follow-up and is a safe no-op.
 */
export async function enqueueRegisterGeneration(
  db: Db,
  workspaceId: string,
  batchId: string,
  assertLease?: () => Promise<void>,
): Promise<void> {
  await assertLease?.()
  // Only a queued job occupies the coalescing slot. A processing job is NOT a
  // reason to skip this insert: it may be building from a snapshot taken before
  // this invoice joined the batch. The queued-only unique index permits exactly
  // one follow-up while the claim RPC prevents overlapping builds.
  const { data: queued } = await db
    .from('processing_jobs').select('id')
    .eq('workspace_id', workspaceId).eq('batch_id', batchId)
    .eq('job_type', 'register_generation').eq('status', 'queued')
    .limit(1)
  if ((queued ?? []).length > 0) return
  await assertLease?.()
  // A generous attempt budget: readiness requeues are expected while siblings
  // are still extracting, and must not exhaust into a settled-failed register.
  const { error } = await db.from('processing_jobs').insert({
    workspace_id: workspaceId, batch_id: batchId, invoice_id: null,
    job_type: 'register_generation', status: 'queued', max_attempts: 12,
  })
  // 23505 = another worker just scheduled the same batch: exactly what we want.
  if (error && error.code !== '23505') throw new Error(`REGISTER_ENQUEUE_ERROR: ${error.message}`)
}

/**
 * Fold one invoice into its real (client, month) batch and make sure a register
 * job is scheduled for it. Runs for BOTH approved and needs_review invoices —
 * what gates batching is a reliably parsed invoice date, not the review outcome.
 * When the date is missing/ambiguous the invoice is left OUT of any guessed month
 * (it stays unbatched and visible in review). Returns the batch id it landed in,
 * or null when the invoice could not be reliably dated (nothing was scheduled).
 *
 * `invoice` may be supplied by the caller (already loaded) to avoid a re-read;
 * when omitted the row is read tenant-scoped here. `jobId` (the extraction job)
 * is optional: when present its batch_id is stamped so build_register's
 * readiness scan counts it as part of the batch.
 */
export async function resolveInvoiceBatch(
  db: Db,
  args: {
    workspaceId: string
    invoiceId: string
    jobId?: string
    row?: DateBearingRow
    invoice?: BatchInvoiceRef
    assertLease?: () => Promise<void>
    /**
     * §bulk-approve: when false the invoice is still resolved + linked into its
     * (client, month) batch, but NO register job is scheduled here. The caller
     * (approveAllPending) coalesces a single enqueue once every row has committed,
     * so a rebuild never observes a half-approved batch and ships a partial
     * workbook. Defaults to true — single approvals and extraction are unchanged.
     * A cross-month DATE MOVE below still rebuilds both periods immediately:
     * retiring the abandoned month is a correctness requirement, not a nicety, and
     * such a move inside a bulk approve is exceptional (the coalesced enqueue for
     * the destination batch is a deduped no-op against it).
     */
    scheduleRegister?: boolean
  },
): Promise<string | null> {
  const { workspaceId, invoiceId } = args
  const schedule = args.scheduleRegister !== false
  let invoice = args.invoice
  if (!invoice) {
    const { data } = await db.from('invoices')
      .select('id,workspace_id,client_id,batch_id')
      .eq('workspace_id', workspaceId).eq('id', invoiceId).maybeSingle()
    invoice = (data ?? undefined) as BatchInvoiceRef | undefined
  }
  if (!invoice) return null

  let batchId: string
  // Resolve the period ONLY from a reliably parsed invoice date; never fall back
  // to the upload month — a guessed period silently files the invoice wrong.
  const iso = args.row && typeof args.row.invoice_date === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(args.row.invoice_date)
    ? args.row.invoice_date
    : null
  if (invoice.batch_id) {
    batchId = invoice.batch_id
    // A reviewer may correct the date into a DIFFERENT month AFTER the invoice was
    // already batched. Detect that and re-file it into the correct period, then
    // rebuild BOTH registers (the destination gains the row, the abandoned month
    // must drop it) so an invoice never sits in the wrong accounting period.
    if (iso) {
      const { start, end } = monthBounds(iso)
      const { data: cur } = await db.from('invoice_batches')
        .select('period_start,period_end').eq('workspace_id', workspaceId).eq('id', batchId).maybeSingle()
      const curRow = cur as { period_start?: string | null; period_end?: string | null } | null
      const curStart = curRow?.period_start ? String(curRow.period_start).slice(0, 10) : ''
      const curEnd = curRow?.period_end ? String(curRow.period_end).slice(0, 10) : ''
      if (curRow && (curStart !== start || curEnd !== end)) {
        const oldBatchId = batchId
        await args.assertLease?.()
        const { data: moved, error: moveErr } = await db.rpc('ensure_invoice_batch', {
          p_workspace: workspaceId, p_client: invoice.client_id ?? null, p_start: start, p_end: end,
        })
        if (moveErr || !moved) throw new Error(`BATCH_ENSURE_ERROR: ${moveErr?.message ?? 'no batch id'}`)
        batchId = String(moved)
        await args.assertLease?.()
        // §register-scope: keep the cross-batch scope key in lock-step with the
        // batch link — both are derived from the SAME reliably-parsed date, so an
        // invoice can never sit in a batch whose period disagrees with its month.
        const { error: relinkErr } = await db.from('invoices').update({ batch_id: batchId, invoice_month: iso.slice(0, 7) })
          .eq('workspace_id', workspaceId).eq('id', invoiceId)
        if (relinkErr) throw new Error(`BATCH_LINK_ERROR: ${relinkErr.message}`)
        // Rebuild the destination period AND the abandoned one — both changed.
        await enqueueRegisterGeneration(db, workspaceId, batchId, args.assertLease)
        await enqueueRegisterGeneration(db, workspaceId, oldBatchId, args.assertLease)
        return batchId
      }
    }
  } else {
    if (!iso) return null
    const { start, end } = monthBounds(iso)
    await args.assertLease?.()
    const { data: batch, error: batchError } = await db.rpc('ensure_invoice_batch', {
      p_workspace: workspaceId, p_client: invoice.client_id ?? null, p_start: start, p_end: end,
    })
    if (batchError || !batch) throw new Error(`BATCH_ENSURE_ERROR: ${batchError?.message ?? 'no batch id'}`)
    batchId = String(batch)
    await args.assertLease?.()
    // §register-scope: stamp the canonical accounting month alongside the batch link
    // (both from `iso`, so the cross-batch scope gather always agrees with the batch).
    const { error: linkErr } = await db.from('invoices').update({ batch_id: batchId, invoice_month: iso.slice(0, 7) })
      .eq('workspace_id', workspaceId).eq('id', invoiceId)
    if (linkErr) throw new Error(`BATCH_LINK_ERROR: ${linkErr.message}`)
  }

  // Make the invoice's batch association and the job agree: stamp the extraction
  // job's batch_id so build_register's readiness scan counts this job as part of
  // the batch (previously extraction jobs kept a NULL batch_id, so the gate always
  // saw zero outstanding work and could build a premature workbook).
  if (args.jobId) {
    await args.assertLease?.()
    await db.from('processing_jobs').update({ batch_id: batchId })
      .eq('workspace_id', workspaceId).eq('id', args.jobId).is('batch_id', null)
  }

  // Ensure the batch has a (deduped) register job scheduled. Readiness is
  // re-checked in build_register, so unconditional scheduling here is safe.
  // Suppressed only for the coalesced bulk-approve caller (see scheduleRegister).
  if (schedule) {
    await enqueueRegisterGeneration(db, workspaceId, batchId, args.assertLease)
  }
  return batchId
}
