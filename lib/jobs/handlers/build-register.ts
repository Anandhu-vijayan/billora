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
import { createHash } from 'node:crypto'
import { bucketFor } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { PermanentJobError } from '@/lib/jobs/queue'
import type { JobContext } from '@/lib/jobs/worker'
import { resolveFileKeyConfig, deriveWorkbookKey, encryptFile } from '@/lib/encryption/files'
import { decryptExtractedPayload } from '@/lib/encryption'
import {
  buildCategoryWorkbook,
  validateCategoryWorkbook,
  registerSheetNameForCategory,
  normalizeRegisterCategory,
  REGISTER_CATEGORY_ORDER,
  expectedTaxBreakdownRowCount,
  type RegisterInvoiceInput,
  type RegisterSliceCell,
  type TallyImportRowInput,
} from '@/lib/excel/generator'
import { resolveLedgerName, resolveSliceLedgerName, tallyDefaultLedgerName, type TallyLedgerMapping } from '@/lib/tally/ledger-mapping'
import { deriveSlicesFromInvoiceHeads, isMixedRate, normalizeSlices, validateTaxSlices, type InvoiceTaxSlice } from '@/lib/ocr/tax-slices'
// §delivery-decoupling: build-register now records a DURABLE outbox row per
// workbook and never touches whatsapp_sessions.pending_reply_body (the old single
// slot whose lost-update race dropped a concurrent month's register). The actual
// send lives in the delivery consumer (lib/jobs/handlers/deliver-register.ts), so
// a register's generation is fully independent of its delivery outcome.
import { categoryFileToken } from '@/lib/exports/naming'
import { enqueueWorkbookDelivery } from '@/lib/whatsapp/delivery-outbox'
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
  await markRetiredAt(db, workspaceId, batchId)
}

/**
 * §6 fail-soft: stamp `retired_at` on the batch's now-expired workbooks so the
 * version chain / delivery isolation is auditable. Kept SEPARATE and best-effort:
 * until the additive `retired_at` column exists this update fails SOFT (logged) —
 * the status-only retire above has ALREADY made the register un-servable, so a
 * stale workbook is never downloadable whether or not the migration is applied.
 */
async function markRetiredAt(db: Db, workspaceId: string, batchId: string): Promise<void> {
  try {
    const { error } = await db.from('generated_workbooks')
      .update({ retired_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId).eq('batch_id', batchId)
      .eq('status', 'expired').is('retired_at', null)
    if (error) {
      logger.warn('[Register] retired_at stamp skipped (migration not applied?)', {
        batchId, code: error.code ?? 'unknown',
      })
    }
  } catch {
    // provenance must never block a retire that already made the register stale.
  }
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
    .from('extracted_records').select('invoice_id,encrypted_payload,review_status,updated_at')
    .eq('workspace_id', workspaceId).eq('review_status', 'approved').in('invoice_id', invoiceIds)
  if (recErr) throw new Error(`RECORDS_READ_ERROR: ${recErr.message}`)

  // §6 capture the EXACT approved source fingerprint BEFORE the (potentially slow)
  // build so publish can prove nothing a reviewer changed mid-build ships as
  // current. `membershipHash` is a one-way SHA-256 of the SORTED approved invoice-id
  // set (never the ids -> no new PII); `sourceRevision` additionally folds each
  // record's updated_at, so an approval/rejection/correction/re-date is detected.
  // Both are computed over already-fetched rows (no extra round-trip) using ONLY
  // base-schema columns, so the concurrency re-check works even before the additive
  // metadata migration is applied.
  const recList = (records ?? []) as Array<{ invoice_id: string; updated_at?: string | null }>
  const membershipHashHex = createHash('sha256')
    .update(recList.map((r) => r.invoice_id).sort().join('\n')).digest('hex')
  const sourceRevision = createHash('sha256')
    .update(recList.map((r) => `${r.invoice_id}\u0000${r.updated_at ?? ''}`).sort().join('\n')).digest('hex')

  const rows: Array<LedgerRow & { _classification?: { accountingCategory?: unknown; itcEligibility?: unknown } }> = []
  for (const rec of (records ?? []) as Array<{ invoice_id: string; encrypted_payload: unknown }>) {
    try {
      const plain = decryptExtractedPayload(byteaToBuffer(rec.encrypted_payload), masterKeyHex)
      rows.push(JSON.parse(plain) as LedgerRow & { _classification?: { accountingCategory?: unknown; itcEligibility?: unknown } })
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
      // §Part-2b: register the invoice on its classified accounting-category sheet.
      // The category lives ONLY on the encrypted `_classification` sibling (added
      // in Part 2a), never as a DB column; a legacy row without it — or any
      // non-string — falls through to the generator's 'purchase' default so the
      // historical single-sheet register is byte-for-byte preserved. This chooses a
      // SHEET only; it never alters an amount, mapping, or the aggregate import.
      accountingCategory: typeof row._classification?.accountingCategory === 'string'
        ? row._classification.accountingCategory
        : null,
      // §3.3 ITC eligibility is DESCRIPTIVE on the register: it never filtered this row
      // out (an approved record always renders regardless of ITC, per §5); it only tells
      // the accountant the credit position. Rides the same encrypted `_classification`
      // sibling; a legacy row without it renders blank (never a fabricated value).
      itcEligibility: typeof row._classification?.itcEligibility === 'string'
        ? row._classification.itcEligibility
        : null,
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
  // §separate-files-per-category: a monthly register is emitted as ONE FILE PER
  // accounting category. Bucket the fully-resolved invoices by the SAME category
  // normalization the renderer uses (a batch is already one (client, calendar
  // month), so each bucket is that month's CUMULATIVE set for the category), in a
  // deterministic order. The queue's one-live-register-job-per-batch invariant is
  // the scope lock, so two generations of the same month never overlap.
  const byCategory = new Map<string, RegisterInvoiceInput[]>()
  for (const inv of invoices) {
    const cat = normalizeRegisterCategory(inv.accountingCategory)
    const bucket = byCategory.get(cat)
    if (bucket) bucket.push(inv); else byCategory.set(cat, [inv])
  }
  const presentCategories = REGISTER_CATEGORY_ORDER.filter((c) => byCategory.has(c))
  const bucketedCount = presentCategories.reduce((n, c) => n + (byCategory.get(c)?.length ?? 0), 0)
  if (bucketedCount !== invoices.length) {
    // Fail CLOSED before touching storage: a normalization drift that let any
    // invoice fall outside the buckets must never silently drop it from a register.
    throw new Error(`REGISTER_BUCKET_ERROR: ${invoices.length - bucketedCount} invoice(s) fell outside the category buckets`)
  }
  const exportsBucket = bucketFor('exports')
  logger.info('[Register] ledger mapping resolved', {
    batchId, jobId: job.id, mapped, mappingRequired, unresolvedRate,
    categories: presentCategories.length,
  })

  // PHASE 1 — build + validate + encrypt + upload EVERY category file before any
  // row changes. All the fallible work happens here, so a failure leaves the
  // current live register fully intact (a failed generation never discards or
  // retires the last valid workbook). No row data is ever logged.
  type PendingPublish = {
    category: string; sheetName: string; rowCount: number;
    exportPath: string; sizeBytes: number; keyVersion: string; checksumHex: string;
  }
  const pending: PendingPublish[] = []
  for (const category of presentCategories) {
    const bucket = byCategory.get(category) ?? []
    const sheetName = registerSheetNameForCategory(category)
    const catImportCount = bucket.reduce((n, inv) => n + inv.importRows.length, 0)
    const buffer = await buildCategoryWorkbook(category, bucket)
    await assertLease()
    await validateCategoryWorkbook(buffer, {
      registerSheetName: sheetName,
      invoiceCount: bucket.length,
      taxBreakdownRowCount: expectedTaxBreakdownRowCount(bucket),
      importRowCount: catImportCount,
    })
    const checksumHex = createHash('sha256').update(buffer).digest('hex')
    const exportPath = deriveWorkbookKey(batchId, pathKeyHex, categoryFileToken(sheetName))
    const enc = encryptFile(buffer, masterKeyHex, { context: exportPath })
    await assertLease()
    const { error: upErr } = await db.storage.from(exportsBucket)
      .upload(exportPath, enc.container, {
        contentType: 'application/octet-stream', upsert: true,
        metadata: { original_mime: SPREADSHEET_MIME, original_extension: 'xlsx' },
      })
    if (upErr) throw new Error(`WORKBOOK_UPLOAD_ERROR: ${upErr.message}`)
    pending.push({ category, sheetName, rowCount: bucket.length, exportPath, sizeBytes: enc.sizeBytes, keyVersion: enc.keyVersion, checksumHex })
  }
  logger.info('[Register] category workbooks built & stored', {
    batchId, jobId: job.id, files: pending.length, rowCount: rows.length,
  })

  // PHASE 2 — concurrency re-check: refuse to publish if the approved source set
  // moved while we were building (a reviewer approved/rejected/corrected/re-dated a
  // row mid-build). Uses base-schema columns only, so it is active regardless of the
  // additive metadata migration. A mismatch is a NORMAL throw (the coalesced requeue
  // rebuilds against the CURRENT set) — nothing is published, no stale register is
  // served. A re-check that cannot run degrades SOFT (log + proceed): it never
  // blocks a build that already cleared every integrity gate.
  await assertLease()
  {
    const { data: curRecs, error: curErr } = await db
      .from('extracted_records').select('invoice_id,updated_at')
      .eq('workspace_id', workspaceId).eq('review_status', 'approved').in('invoice_id', invoiceIds)
    if (curErr) {
      logger.warn('[Register] source-revision re-check unavailable; publishing last known-good build', {
        batchId, jobId: job.id, code: curErr.code ?? 'unknown',
      })
    } else {
      const cur = (curRecs ?? []) as Array<{ invoice_id: string; updated_at?: string | null }>
      const curRevision = createHash('sha256')
        .update(cur.map((r) => `${r.invoice_id}\u0000${r.updated_at ?? ''}`).sort().join('\n')).digest('hex')
      if (curRevision !== sourceRevision) {
        throw new Error('REGISTER_SOURCE_CHANGED: approved set moved during build; rebuilding')
      }
    }
  }

  // PHASE 3 — publish. Every workbook is proven good, so this is the only moment
  // the live register changes. Insert one ready row per category at a fresh
  // monotonic version FIRST, THEN retire the batch's prior versions — so there is
  // never an instant with no live register, history is never deleted (retire =
  // status 'expired'), and the highest version always wins for every reader.
  await assertLease()
  const { data: prior } = await db.from('generated_workbooks').select('version')
    .eq('workspace_id', workspaceId).eq('batch_id', batchId).order('version', { ascending: false }).limit(1)
  const newVersion = (((prior ?? [])[0]?.version as number | undefined) ?? 0) + 1
  const expiresAt = new Date(Date.now() + WORKBOOK_LINK_TTL_SECONDS * 1000).toISOString()

  const published: Array<{ workbookId: string; category: string; rowCount: number }> = []
  for (const p of pending) {
    await assertLease()
    const { data: inserted, error: gwErr } = await db.from('generated_workbooks').insert({
      workspace_id: workspaceId, batch_id: batchId, file_object_path: p.exportPath,
      accounting_category: p.category,
      file_encryption_key_version: p.keyVersion, size_bytes: p.sizeBytes,
      status: 'ready', version: newVersion, generated_at: new Date().toISOString(), expires_at: expiresAt,
    }).select('id').single()
    if (gwErr || !inserted) throw new Error(`WORKBOOK_ROW_ERROR: ${gwErr?.message ?? 'no id'}`)
    const workbookId = (inserted as { id: string }).id
    published.push({ workbookId, category: p.category, rowCount: p.rowCount })
    logger.info('[Register] workbook ready', { workbookId, batchId, jobId: job.id, category: p.category, rowCount: p.rowCount })
    // §6 provenance metadata: a SEPARATE best-effort write so a register ALWAYS
    // publishes even before the additive metadata migration is applied (then it
    // fails SOFT, logged). The revision equals the re-check value proven above.
    try {
      const { error: metaErr } = await db.from('generated_workbooks').update({
        source_dataset_revision: sourceRevision,
        source_row_count: p.rowCount,
        source_membership_hash: `\\x${membershipHashHex}`,
        workbook_checksum: `\\x${p.checksumHex}`,
      }).eq('workspace_id', workspaceId).eq('id', workbookId)
      if (metaErr) {
        logger.warn('[Register] workbook metadata columns skipped (migration not applied?); provenance inactive', {
          workbookId, jobId: job.id, code: metaErr.code ?? 'unknown',
        })
      }
    } catch {
      // provenance is descriptive; it must never fail a completed register.
    }
  }

  // NOW supersede the prior versions (never the rows just written).
  await assertLease()
  await db.from('generated_workbooks')
    .update({ status: 'expired' })
    .eq('workspace_id', workspaceId).eq('batch_id', batchId)
    .lt('version', newVersion).in('status', ['ready', 'sent'])
  await markRetiredAt(db, workspaceId, batchId)

  // PHASE 4 — durable delivery. Record ONE independent outbox row per published
  // workbook; the delivery consumer owns the send. Generation success NEVER
  // depends on send success and the racy single-slot pending_reply_body RMW is gone.
  await enqueueRegisterDeliveries(db, workspaceId, batchId, published, job.id, assertLease)
}

/**
 * §durable delivery: record one independent, retryable outbox row per published
 * workbook so the owner is owed each file, then let the delivery consumer
 * (lib/jobs/handlers/deliver-register.ts) own the send. This is the fix for the
 * lost-notification race: the old code wrote every handoff into the SINGLE
 * `whatsapp_sessions.pending_reply_body` slot via an unguarded read-modify-write,
 * so two concurrent per-batch builds clobbered each other's token and one month's
 * file silently vanished. One durable row per (workbook, recipient) can never
 * overwrite another's. Enqueue is best-effort and NEVER fails generation (a
 * failure leaves the workbook 'ready' and the legacy backfill / Done-Review
 * ready-sweep still delivers it), and the recipient is stored only as its HMAC —
 * never logged as a phone number.
 */
async function enqueueRegisterDeliveries(
  db: Db,
  workspaceId: string,
  batchId: string,
  published: ReadonlyArray<{ workbookId: string; category: string; rowCount: number }>,
  jobId: string,
  assertLease: () => Promise<void>,
): Promise<void> {
  try {
    const senderHmac = await findOwnerSenderHmac(db, workspaceId)
    if (!senderHmac) {
      logger.info('[Register] no linked WhatsApp sender; workbooks ready for later delivery', {
        batchId, jobId, count: published.length,
      })
      return
    }
    for (const { workbookId, category, rowCount } of published) {
      await assertLease()
      const queued = await enqueueWorkbookDelivery(db, { workspaceId, workbookId, recipientSenderHmac: senderHmac })
      logger.info(queued
        ? '[Register] durable delivery queued'
        : '[Register] delivery enqueue deferred (outbox unavailable?)', {
          workbookId, batchId, jobId, category, rowCount,
        })
    }
  } catch (e) {
    // Delivery is orthogonal to generation; swallow so the job still completes.
    logger.warn('[Register] SEND_DEFERRED: delivery enqueue failed', {
      jobId, batchId, error: e instanceof Error ? e.message : String(e),
    })
  }
}
