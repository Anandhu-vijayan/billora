// lib/jobs/handlers/build-register.ts — register_generation job handler.
//
// Builds one batch's GSTR-2B purchase register from its APPROVED extracted
// rows, stores the workbook privately, and records a handoff so the register is
// delivered to the owner's chat as an Excel document on their next inbound reply
// (best-effort). It never claims delivery it did not achieve (rule 6) and a
// failed send never fails the job (rule 5).
//
// Invariants:
//   * Tenant isolation: every read is scoped by the job's workspace_id; the
//     batch itself is verified to belong to that workspace before any gather.
//   * Determinism: the workbook object key is an HMAC of the batch id, so a
//     re-run overwrites the same slot instead of piling up files.
//   * Freshness: prior workbooks for the batch are marked stale and a monotonically
//     increasing version is recorded, so an old object can never look current.
//   * Review accounting: needs_review/failed invoices are NOT silently dropped —
//     they are counted and logged, and only approved rows enter the register.
import type { SupabaseClient } from '@supabase/supabase-js'
import { bucketFor } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { PermanentJobError } from '@/lib/jobs/queue'
import type { JobContext } from '@/lib/jobs/worker'
import { resolveFileKeyConfig, deriveWorkbookKey, encryptFile } from '@/lib/encryption/files'
import { decryptExtractedPayload } from '@/lib/encryption'
import {
  buildRegisterWorkbook,
  validateRegisterWorkbook,
  expectedTaxBreakdownRowCount,
  type RegisterInvoiceInput,
  type RegisterSliceCell,
  type TallyImportRowInput,
} from '@/lib/excel/generator'
import { resolveLedgerName, resolveSliceLedgerName, tallyDefaultLedgerName, type TallyLedgerMapping } from '@/lib/tally/ledger-mapping'
import { deriveSlicesFromInvoiceHeads, isMixedRate, normalizeSlices, validateTaxSlices, type InvoiceTaxSlice } from '@/lib/ocr/tax-slices'
import { updateSessionDeliveryState } from '@/lib/whatsapp/sessions'
// Opt-in proactive delivery (§P1-6): when the owner consented AND the feature flag +
// separate key are set AND the send is inside Meta's 24h window, push the workbook
// straight away; otherwise fall through to the next-inbound handoff. The wa_id is
// opened in memory only and never logged.
import { canProactivelyPush } from '@/lib/whatsapp/proactive'
import { loadProactiveIdentity, openWaId } from '@/lib/whatsapp/proactive-store'
import { deliverWorkbookToWhatsApp } from '@/lib/exports/deliver'
import type { LedgerRow } from '@/lib/ocr/ledger'

type Db = SupabaseClient

const SPREADSHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
// A generated workbook is protected AT REST and served only through the
// authenticated /api/exports/[id]/download route (workspace membership is
// re-checked there). This window is when a ready register stays downloadable
// before it is treated as lapsed; the object itself is never handed out raw.
const WORKBOOK_LINK_TTL_SECONDS = 7 * 24 * 3600

/** PostgREST renders bytea as a `\x`-prefixed hex string (same as intake). */
function byteaToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/i, ''), 'hex')
  throw new Error('BYTEA_DECODE_ERROR: unexpected encrypted_payload encoding')
}

/**
 * Retire this batch's live (ready/sent) workbooks by marking them expired, so a
 * register that no longer reflects the batch's current membership can never be
 * served. The authenticated download route returns 410 for an expired row. Used
 * when a rebuild finds nothing to render — e.g. a reviewer re-dated the batch's
 * only invoice into a different accounting month, stranding a mis-dated workbook.
 */
async function retireLiveWorkbooks(
  db: Db, workspaceId: string, batchId: string, assertLease: () => Promise<void>,
): Promise<void> {
  await assertLease()
  const { error } = await db.from('generated_workbooks')
    .update({ status: 'expired' })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).in('status', ['ready', 'sent'])
  // A failed retire must requeue (transient throw) rather than leave a stale,
  // still-downloadable register behind.
  if (error) throw new Error(`WORKBOOK_RETIRE_ERROR: ${error.message}`)
}

/** The WhatsApp sender identity that owns a workspace (for reply linkage). */
async function findOwnerSenderHmac(db: Db, workspaceId: string): Promise<string | null> {
  const { data } = await db.from('whatsapp_identities').select('sender_hmac')
    .eq('workspace_id', workspaceId).limit(1)
  return ((data ?? [])[0]?.sender_hmac as string | undefined) ?? null
}

/**
 * Load the workspace's Tally ledger mappings (rate-class -> ledger name). Tenant
 * isolation is the WHERE workspace_id clause — a mapping is never read across a
 * workspace boundary (§4 rule 6/7). A read error (e.g. the table not yet
 * provisioned in this deployment) is treated as "no mappings configured", which
 * makes every line mapping-required rather than inventing a ledger name: the
 * register still ships, but never with a fabricated classification (§4 rule 2).
 * Only the two non-sensitive columns are selected.
 */
async function loadLedgerMappings(db: Db, workspaceId: string): Promise<TallyLedgerMapping[]> {
  const { data, error } = await db
    .from('tally_ledger_mappings')
    .select('rate_class_key,ledger_name')
    .eq('workspace_id', workspaceId)
  if (error) {
    logger.warn('[Register] ledger mappings unavailable; treating all lines as mapping-required', {
      code: error.code ?? null,
    })
    return []
  }
  return (data ?? []) as TallyLedgerMapping[]
}

/** Render one validated slice as a register/breakdown cell payload. */
function toSliceCell(s: InvoiceTaxSlice): RegisterSliceCell {
  return {
    rate_percent: s.rate_percent,
    taxable_value: s.taxable_value,
    cgst_amount: s.cgst_amount,
    sgst_amount: s.sgst_amount,
    igst_amount: s.igst_amount,
    cess_amount: s.cess_amount ?? null,
    treatment: s.treatment ?? null,
    provenance: s.provenance ?? null,
    confidence: s.confidence ?? null,
    validation_status: s.validation_status ?? null,
  }
}

const sumMoney = (...vals: Array<number | null | undefined>): number =>
  vals.reduce<number>((a, v) => a + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0)
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * §multi-rate: resolve ONE import line per invoice from its own totals. This is
 * the historical behaviour and stays the fallback whenever a rate-wise breakdown
 * is absent, single-rate, or does not reconcile to the invoice heads — an
 * invoice-level row that merely carries slices is never expanded on unvalidated
 * evidence.
 */
function invoiceLevelImportLine(
  row: LedgerRow,
  res: ReturnType<typeof resolveLedgerName>,
): TallyImportRowInput {
  return {
    invoice_date: row.invoice_date || null,
    invoice_number: row.invoice_number || null,
    vendor_name: row.vendor_name || null,
    supplier_gstin: row.supplier_gstin || null,
    // §user #4b: with no workspace mapping configured the cell used to render
    // blank, which an accountant reads as a broken register. We now write a
    // conventional `Purchase @ <rate>%` display name (a plain `Purchase` when the
    // rate is unestablished) so the sheet is always populated. This NEVER touches
    // an amount and NEVER overrides a real mapping — a configured ledger name
    // (`res.ledgerName`) always wins; the default only fills the gap.
    ledger_name: res.ledgerName ?? tallyDefaultLedgerName(res.gstRatePercent),
    taxable_value: row.taxable_value,
    gst_rate_percent: res.gstRatePercent,
    cgst_amount: row.cgst_amount,
    sgst_amount: row.sgst_amount,
    igst_amount: row.igst_amount,
    round_off: row.round_off ?? null,
    gross_total: row.total_amount,
  }
}

/**
 * §multi-rate: expand a VALIDATED mixed-rate breakdown into one 12-column import
 * line per rate slice, each mapped to its own per-slice ledger. The invoice-level
 * round-off rides ONLY on the last line (never duplicated), and each line's gross
 * is its own taxable+tax (the last adds the round-off), so the expanded lines sum
 * back to the invoice total exactly — no double-counted grand total.
 */
function sliceImportLines(
  row: LedgerRow,
  slices: readonly InvoiceTaxSlice[],
  mappings: readonly TallyLedgerMapping[],
): { lines: TallyImportRowInput[]; mapped: number; mappingRequired: number; unresolvedRate: number } {
  let mapped = 0
  let mappingRequired = 0
  let unresolvedRate = 0
  const roundOff = typeof row.round_off === 'number' && Number.isFinite(row.round_off) ? row.round_off : null
  const lines = slices.map((s, i) => {
    const res = resolveSliceLedgerName(s, mappings)
    if (res.status === 'mapped') mapped += 1
    else if (res.status === 'mapping-required') mappingRequired += 1
    else unresolvedRate += 1
    const tax = sumMoney(s.cgst_amount, s.sgst_amount, s.igst_amount)
    const isLast = i === slices.length - 1
    const gross = round2(sumMoney(s.taxable_value, tax) + (isLast ? roundOff ?? 0 : 0))
    return {
      invoice_date: row.invoice_date || null,
      invoice_number: row.invoice_number || null,
      vendor_name: row.vendor_name || null,
      supplier_gstin: row.supplier_gstin || null,
      ledger_name: res.ledgerName ?? tallyDefaultLedgerName(res.gstRatePercent),
      taxable_value: s.taxable_value,
      gst_rate_percent: s.rate_percent,
      cgst_amount: s.cgst_amount,
      sgst_amount: s.sgst_amount,
      igst_amount: s.igst_amount,
      // Round-off is an invoice-level figure: it appears once, on the LAST slice
      // line, so the Tally importer sees the invoice's true gross without ever
      // counting the rounding adjustment twice.
      round_off: isLast ? roundOff : null,
      gross_total: gross,
    }
  })
  return { lines, mapped, mappingRequired, unresolvedRate }
}

export async function buildRegister(ctx: JobContext): Promise<void> {
  const { db, job, assertLease } = ctx
  const workspaceId = job.workspace_id
  if (!job.batch_id) throw new PermanentJobError('REGISTER_MISSING_BATCH')
  const batchId = job.batch_id

  // Tenant check first: the batch must belong to this job's workspace.
  const { data: batchRow, error: batchErr } = await db
    .from('invoice_batches').select('id,workspace_id,status')
    .eq('workspace_id', workspaceId).eq('id', batchId).maybeSingle()
  if (batchErr) throw new Error(`BATCH_READ_ERROR: ${batchErr.message}`)
  if (!batchRow) throw new PermanentJobError('REGISTER_BATCH_NOT_FOUND')

  // Batch readiness gate. Extraction schedules this job unconditionally (so no
  // batch is ever left unscheduled by a finish-together race); this is the
  // safety valve that stops a PREMATURE workbook: build only once no extraction
  // job for the batch is still queued/processing. A normal (non-permanent)
  // throw requeues with backoff, so the register rebuilds itself once the last
  // sibling settles — the enqueue gives this job a generous max_attempts so
  // these expected requeues never exhaust into a permanent failure.
  //
  // NEVER assume processing_jobs.batch_id is populated: an extraction job created
  // before its invoice was ever finalized carries a NULL batch_id, so a
  // batch_id-only scan would miss it and build a premature workbook. We count
  // outstanding extraction two ways and take the larger — jobs stamped into this
  // batch, and jobs whose target invoice already belongs to this batch.
  const { data: invoiceRows, error: invErr } = await db
    .from('invoices').select('id')
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).neq('status', 'deleted')
  if (invErr) throw new Error(`BATCH_INVOICES_ERROR: ${invErr.message}`)
  const invoiceIds = (invoiceRows ?? []).map((r) => (r as { id: string }).id)

  const { count: outstandingByBatch, error: outErr } = await db
    .from('processing_jobs').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId)
    .eq('job_type', 'invoice_extraction').in('status', ['queued', 'processing'])
  if (outErr) throw new Error(`BATCH_READINESS_ERROR: ${outErr.message}`)
  let outstanding = outstandingByBatch ?? 0
  if (invoiceIds.length > 0) {
    const { count: outstandingByInvoice, error: outErr2 } = await db
      .from('processing_jobs').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).in('invoice_id', invoiceIds)
      .eq('job_type', 'invoice_extraction').in('status', ['queued', 'processing'])
    if (outErr2) throw new Error(`BATCH_READINESS_ERROR: ${outErr2.message}`)
    outstanding = Math.max(outstanding, outstandingByInvoice ?? 0)
  }
  if (outstanding > 0) throw new Error(`REGISTER_NOT_READY: ${outstanding} extraction job(s) outstanding`)

  // Account for the non-approved invoices so they are never silently dropped.
  const { count: flagged } = await db
    .from('invoices').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).eq('status', 'needs_review')
  if ((flagged ?? 0) > 0) {
    logger.info('[Register] batch has invoices awaiting review', { batchId, jobId: job.id, needsReview: flagged })
  }

  if (invoiceIds.length === 0) {
    // The batch has no live invoices left (its only invoice was re-dated into a
    // different period, or all were deleted). Retire any prior workbook so a
    // mis-dated register is never left downloadable, then complete as a no-op.
    await retireLiveWorkbooks(db, workspaceId, batchId, assertLease)
    return
  }

  const { masterKeyHex, pathKeyHex } = resolveFileKeyConfig()
  const { data: records, error: recErr } = await db
    .from('extracted_records').select('invoice_id,encrypted_payload,review_status')
    .eq('workspace_id', workspaceId).eq('review_status', 'approved').in('invoice_id', invoiceIds)
  if (recErr) throw new Error(`RECORDS_READ_ERROR: ${recErr.message}`)

  const rows: LedgerRow[] = []
  for (const rec of (records ?? []) as Array<{ invoice_id: string; encrypted_payload: unknown }>) {
    try {
      const plain = decryptExtractedPayload(byteaToBuffer(rec.encrypted_payload), masterKeyHex)
      rows.push(JSON.parse(plain) as LedgerRow)
    } catch (e) {
      // A corrupt stored payload is unexpected, but never emit a partial/garbage
      // workbook: skip that one row and record it. The batch still ships cleanly.
      logger.warn('[Register] skipping undecryptable record', {
        invoice: rec.invoice_id.slice(0, 8), error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (rows.length === 0) {
    logger.info('[Register] no approved rows to render; completing as no-op', { batchId, jobId: job.id, needsReview: flagged ?? 0 })
    // Nothing approved to render: retire the prior workbook so a stale register
    // (from before these rows lost approval / moved period) is not still served.
    await retireLiveWorkbooks(db, workspaceId, batchId, assertLease)
    return // a "no approved rows" batch is a successful no-op, not a failure
  }

  logger.info('[Register] workbook generation started', { batchId, jobId: job.id, rowCount: rows.length })
  // Load the workspace's configured Tally ledger mappings (scoped strictly to
  // this workspace_id — one tenant's ledger names can never reach another). A
  // read failure (e.g. the mapping table not yet provisioned) is treated as "no
  // mappings configured yet", which leaves every line explicitly mapping-required
  // rather than fabricating a ledger — the register still generates, blank-safe.
  const mappings = await loadLedgerMappings(db, workspaceId)
  const invoices: RegisterInvoiceInput[] = []
  let mapped = 0
  let mappingRequired = 0
  let unresolvedRate = 0
  for (const row of rows) {
    // §multi-rate: the canonical row already carries a reliable breakdown when
    // the source evidenced one (evaluateLedger attaches validated explicit slices
    // or a single-rate derived slice). Normalise what is on the row; otherwise
    // derive ONLY from a cleanly evidenced single-rate invoice head — never
    // fabricate a breakdown a stored payload does not have.
    const slices = normalizeSlices(row.tax_slices) ?? deriveSlicesFromInvoiceHeads(row) ?? []
    const res = resolveLedgerName(row, mappings)
    const mixed = isMixedRate(slices)
    // A mixed-rate import expansion is allowed ONLY when the breakdown reconciles
    // to the invoice heads under the shared tolerance; anything else keeps the
    // safe invoice-level line (and the review status says so truthfully).
    const breakdownValidated = mixed
      ? validateTaxSlices(slices, {
        taxable_value: row.taxable_value,
        cgst_amount: row.cgst_amount,
        sgst_amount: row.sgst_amount,
        igst_amount: row.igst_amount,
        total_amount: row.total_amount,
      }, BigInt(Math.max(0, Math.trunc(101)))).breakdownValidated
      : false
    const importRows: TallyImportRowInput[] = (mixed && breakdownValidated)
      ? (() => {
        const exp = sliceImportLines(row, slices, mappings)
        mapped += exp.mapped
        mappingRequired += exp.mappingRequired
        unresolvedRate += exp.unresolvedRate
        return exp.lines
      })()
      : (() => {
        if (res.status === 'mapped') mapped += 1
        else if (res.status === 'mapping-required') mappingRequired += 1
        else unresolvedRate += 1
        return [invoiceLevelImportLine(row, res)]
      })()
    invoices.push({
      invoice_date: row.invoice_date || null,
      invoice_number: row.invoice_number || null,
      vendor_name: row.vendor_name || null,
      supplier_gstin: row.supplier_gstin || null,
      place_of_supply: null,
      document_type: row.document_type ?? null,
      total_taxable_value: row.taxable_value,
      total_cgst: row.cgst_amount,
      total_sgst: row.sgst_amount,
      total_igst: row.igst_amount,
      total_cess: null,
      other_charges: null,
      discount: null,
      round_off: row.round_off ?? null,
      grand_total: row.total_amount,
      // Only APPROVED rows ever reach the register; say so truthfully, and mark a
      // mixed-rate bill whose breakdown could not be validated for the accountant.
      review_status: mixed && !breakdownValidated ? 'approved (rate-wise breakdown unvalidated)' : 'approved',
      slices: slices.map(toSliceCell),
      importRows,
    })
  }
  const importRowCount = invoices.reduce((n, inv) => n + inv.importRows.length, 0)
  logger.info('[Register] ledger mapping resolved', {
    batchId, jobId: job.id, mapped, mappingRequired, unresolvedRate,
  })
  const workbook = await buildRegisterWorkbook(invoices)
  // Integrity gate BEFORE anything is persisted: reopen the buffer and prove it
  // is a genuine, openable .xlsx with all three sheets, the exact 12 Tally
  // headers on Purchase Import, EXACTLY one Purchase Register row per invoice,
  // one Tax Breakdown row per slice (>=1 per invoice) and precisely the resolved
  // number of import rows (a stray summary row would import as a phantom voucher
  // and is rejected here). A truncated/partial write or an ExcelJS regression
  // throws (the job requeues) instead of encrypting, storing, and later
  // "delivering" a register the accountant cannot import. No row data is logged.
  await validateRegisterWorkbook(workbook, {
    invoiceCount: invoices.length,
    taxBreakdownRowCount: expectedTaxBreakdownRowCount(invoices),
    importRowCount,
  })
  logger.info('[Register] workbook generated', { batchId, jobId: job.id, rowCount: rows.length, sizeBytes: workbook.length })
  const exportPath = deriveWorkbookKey(batchId, pathKeyHex)
  const exportsBucket = bucketFor('exports')
  // Encrypt the register AT REST: vendor names, GSTINs and amounts are customer
  // data. The envelope container uploads as application/octet-stream; the
  // logical spreadsheetml type + extension are retained as object metadata so
  // the download route can name the file it streams after decrypting in memory.
  const enc = encryptFile(workbook, masterKeyHex, { context: exportPath })
  await assertLease()
  const { error: upErr } = await db.storage.from(exportsBucket)
    .upload(exportPath, enc.container, {
      contentType: 'application/octet-stream', upsert: true,
      metadata: { original_mime: SPREADSHEET_MIME, original_extension: 'xlsx' },
    })
  if (upErr) throw new Error(`WORKBOOK_UPLOAD_ERROR: ${upErr.message}`)
  logger.info('[Register] workbook stored', {
    batchId, jobId: job.id, sizeBytes: enc.sizeBytes, rowCount: rows.length,
  })

  // Freshness: retire prior workbooks for this batch, then insert the new one
  // with a monotonic version. The insert is what makes it the current register.
  await assertLease()
  await db.from('generated_workbooks')
    .update({ status: 'expired' })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).in('status', ['ready', 'sent'])
  const { data: prior } = await db.from('generated_workbooks').select('version')
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).order('version', { ascending: false }).limit(1)
  const version = ((prior ?? [])[0]?.version as number | undefined ?? 0) + 1

  const expiresAt = new Date(Date.now() + WORKBOOK_LINK_TTL_SECONDS * 1000).toISOString()
  await assertLease()
  const { data: inserted, error: gwErr } = await db.from('generated_workbooks').insert({
    workspace_id: workspaceId, batch_id: batchId, file_object_path: exportPath,
    file_encryption_key_version: enc.keyVersion, size_bytes: enc.sizeBytes,
    status: 'ready', version, generated_at: new Date().toISOString(), expires_at: expiresAt,
  }).select('id').single()
  if (gwErr || !inserted) throw new Error(`WORKBOOK_ROW_ERROR: ${gwErr?.message ?? 'no id'}`)
  const workbookId = (inserted as { id: string }).id
  logger.info('[Register] workbook ready', { workbookId, batchId, jobId: job.id, rowCount: rows.length })

  // Delivery is best-effort and NEVER fails the generation job (rule 5).
  await scheduleDelivery(db, workspaceId, workbookId, job.id, rows.length, flagged ?? 0, mappingRequired + unresolvedRate, expiresAt, assertLease)
}

/**
 * Best-effort delivery: hand the register to the owner's NEXT inbound reply.
 * The workbook is encrypted at rest and the web download route needs a signed-in
 * session a WhatsApp-only user does not have, so the reliable channel is to send
 * the decrypted .xlsx back into the owner's chat as a document (see
 * lib/exports/deliver.ts). A spontaneous push is impossible off-webhook — the
 * raw phone number is never stored, only its HMAC — so we record a handoff that
 * the sender's next inbound flush turns into the attached file. The leading
 * [[deliver:<uuid>]] token carries the workbook id for the flush and is stripped
 * before any text fallback, so it is never shown. When a public origin IS
 * configured we also include the authenticated download link as a fallback, but
 * delivery is recorded regardless of it. Storing the handoff is send-only
 * bookkeeping — a failure here cannot fail the generation job (rule 5), and the
 * workbook row persists for a later retry.
 */
async function scheduleDelivery(
  db: Db,
  workspaceId: string,
  workbookId: string,
  jobId: string,
  rowCount: number,
  needsReview: number,
  unmappedCount: number,
  expiresAt: string,
  assertLease: () => Promise<void>,
): Promise<void> {
  try {
    const senderHmac = await findOwnerSenderHmac(db, workspaceId)
    if (!senderHmac) {
      logger.info('[Register] no linked WhatsApp sender; workbook ready for later delivery', { workbookId, jobId })
      return
    }
    const reviewNote = needsReview > 0
      ? ` ${needsReview} invoice(s) need review and are not included. Reply Review or choose Menu > Review.`
      : ''
    // Honest import-readiness: a workbook is only "import-ready" once every line
    // has a configured ledger. Report the outstanding count truthfully (§8) rather
    // than claiming a clean import when lines are still unmapped.
    const mappingNote = unmappedCount > 0
      ? ` ${unmappedCount} line(s) still need a ledger mapping before they import into Tally.`
      : ''
    // §P1-6 OPT-IN PROACTIVE PUSH. Attempted only when the owner explicitly consented,
    // the operator switched the feature on AND configured the separate sealing key,
    // and the send is inside Meta's 24-hour service window. deliverWorkbookToWhatsApp
    // is idempotent (ready→sent), so this is safe even if the lease lapses mid-send.
    // Any non-delivery (ineligible, decrypt failure, transient send) falls through to
    // the reliable next-inbound handoff below — the register is NEVER lost, and the
    // owner's number is never logged on any path.
    try {
      const identity = await loadProactiveIdentity(db, senderHmac)
      const waId = identity && canProactivelyPush({ consent: identity.consent, lastActivityMs: identity.lastActivityMs })
        ? openWaId(identity.sealed)
        : null
      if (waId) {
        const push = await deliverWorkbookToWhatsApp(db, {
          workbookId, to: waId,
          caption: `Your invoice register is ready — ${rowCount} invoice(s).${reviewNote}${mappingNote}`,
        })
        if (push.delivered) {
          await updateSessionDeliveryState(db, senderHmac, { pending_reply_body: null, last_reply_error_code: null })
          logger.info('[Register] proactive delivery pushed', { workbookId, jobId, rowCount })
          return
        }
        logger.info('[Register] proactive push not delivered; using next-inbound handoff', {
          workbookId, jobId, outcome: push.outcome,
        })
      }
    } catch (e) {
      logger.warn('[Register] proactive push unavailable; using next-inbound handoff', {
        jobId, workbookId, error: e instanceof Error ? e.message : String(e),
      })
    }
    const base = (process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '')
    // Document delivery needs no public origin, so we never defer just because
    // the web link can't be built; the link is an EXTRA fallback when configured.
    const linkNote = base
      ? ` Secure download (sign in required): ${base}/api/exports/${workbookId}/download (valid until ${expiresAt}).`
      : ''
    // whatsapp_sessions has ONE pending_reply_body slot. If a register for a
    // DIFFERENT month finished since the owner's last inbound and its handoff is
    // still waiting there, blindly overwriting it would silently drop that Excel
    // file (§user: "another file is missing"). Merge the outstanding deliver
    // tokens so every ready register flushes on the next inbound, this one last.
    const { data: slot } = await db.from('whatsapp_sessions').select('pending_reply_body')
      .eq('sender_hmac', senderHmac).maybeSingle()
    const existing = (slot?.pending_reply_body as string | null | undefined) ?? ''
    const priorIds = [...existing.matchAll(/\[\[deliver:([0-9a-f-]{36})\]\]/gi)]
      .map((m) => m[1]).filter((id) => id !== workbookId)
    const priorTokens = priorIds.map((id) => `[[deliver:${id}]]\n`).join('')
    const multi = priorIds.length > 0
    const body = `${priorTokens}[[deliver:${workbookId}]]\nYour invoice register${multi ? 's are' : ' is'} ready — ${rowCount} invoice(s). I'll send the Excel ${multi ? 'files' : 'file'} here in this chat.${linkNote}${reviewNote}${mappingNote}`
    await assertLease()
    const queued = await updateSessionDeliveryState(db, senderHmac, { pending_reply_body: body, last_reply_error_code: null })
    logger.info(queued
      ? '[Register] delivery queued for next inbound reply'
      : '[Register] delivery deferred: delivery state could not be saved', { workbookId, jobId, rowCount })
  } catch (e) {
    // Delivery is orthogonal to generation; swallow so the job still completes.
    logger.warn('[Register] SEND_DEFERRED: delivery scheduling failed', {
      jobId, workbookId, error: e instanceof Error ? e.message : String(e),
    })
  }
}
