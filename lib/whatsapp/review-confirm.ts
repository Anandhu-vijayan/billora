// lib/whatsapp/review-confirm.ts — the WhatsApp-native "confirm an invoice" path.
//
// A needs_review invoice that is otherwise complete can be approved directly in
// chat: the Review list shows each pending invoice's EXACT extracted number /
// vendor / total, and tapping a row is the reviewer affirming those displayed
// values. This module reads the pending rows (tenant-scoped), and on confirm
// echoes the shown required fields back as the reviewer's corrections and runs
// the SAME shared review path (applyInvoiceReview) the web/API reviewer uses —
// so approval, batching and register scheduling can never diverge by channel.
//
// Non-negotiables:
//   * Tenant isolation: every read/write is scoped by the sender's OWN workspace
//     (resolved upstream from the verified WhatsApp identity, not the message).
//   * Never fabricate: we only ever echo values the engine already extracted AND
//     displayed to the reviewer; nothing is invented. The deterministic engine
//     still re-validates, so a tap cannot approve a mathematically bad row.
//   * A confirm is meaningful: applyInvoiceReview refuses to honor an approval
//     unless the invoice number was explicitly confirmed (see review.ts).
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptExtractedPayload } from '@/lib/encryption'
import { resolveFileKeyConfig } from '@/lib/encryption/files'
import type { LedgerCandidate, LedgerRow } from '@/lib/ocr/ledger'
import { applyInvoiceReview, applyInvoiceCorrection, parseReviewCorrections } from '@/lib/invoices/review'
import { enqueueRegisterGeneration } from '@/lib/invoices/batch'
import { logger } from '@/lib/logger'
import { summarizeReasons, reasonFixHints } from '@/lib/whatsapp/review-edit'
import { monthLabel } from '@/lib/exports/naming'
import type { ConfirmOutcome } from '@/lib/whatsapp/finalize'

type Db = SupabaseClient

/** PostgREST renders bytea as a `\x`-prefixed hex string (same as intake/register). */
function byteaToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/i, ''), 'hex')
  throw new Error('BYTEA_DECODE_ERROR: unexpected encrypted_payload encoding')
}

/** The canonical stored row shape we surface for confirmation. */
interface StoredRow {
  invoice_date?: string | null
  invoice_number?: string | null
  vendor_name?: string | null
  supplier_gstin?: string | null
  taxable_value?: number | null
  cgst_amount?: number | null
  sgst_amount?: number | null
  igst_amount?: number | null
  total_amount?: number | null
  // Encrypted sibling key carrying the machine reason codes for this row (§P0-3).
  // Absent on pre-P0-3 rows; readers treat that as "no stored reason" and show a
  // generic prompt rather than guessing a cause.
  _reviewReasons?: string[]
  // §Part-2 the encrypted classification sibling (document type + accounting
  // category). Absent on pre-Part-2 rows; shown to the reviewer read-only.
  // §3.3 itcEligibility is absent on pre-ITC rows; readers default it to 'needs_review'.
  _classification?: { documentType?: string; accountingCategory?: string; itcEligibility?: string } | null
}

/** The stored reason codes for a row, defensively read (never throws on shape). */
function storedReasons(row: StoredRow): string[] {
  return Array.isArray(row._reviewReasons)
    ? row._reviewReasons.filter((r): r is string => typeof r === 'string')
    : []
}

export interface PendingReviewItem {
  invoiceId: string
  invoiceNumber: string
  vendorName: string | null
  total: string | null
  /** Plain-English "why flagged" for the list row description (§P0-3). */
  why: string
  /** Accounting month label (e.g. "Oct 2026") from the invoice's OWN batch period, or
   *  null when it is not yet attributable (§P1-7 — the month is shown so a reviewer
   *  paging a long list never approves an invoice into the wrong period). */
  month: string | null
}

/** How many invoices one review page offers. A WhatsApp list caps at 10 rows total,
 *  and a page leaves room for an "Approve all" control row and a "Next" row, so a
 *  full page is 8 item rows + those two controls = 10 (no real row is ever skipped). */
export const REVIEW_PAGE_SIZE = 8

/** Resolve batch_id -> period_start for a set of batches, tenant-scoped, error-tolerant. */
async function batchPeriodMap(
  db: Db, workspaceId: string, batchIds: Array<string | null>,
): Promise<Map<string, string | null>> {
  const ids = batchIds.filter((b): b is string => typeof b === 'string' && b.length > 0)
  const map = new Map<string, string | null>()
  if (ids.length === 0) return map
  const { data } = await db
    .from('invoice_batches').select('id,period_start')
    .eq('workspace_id', workspaceId).in('id', ids)
  for (const b of (data ?? []) as Array<{ id: string; period_start?: string | null }>) {
    map.set(b.id, b.period_start ?? null)
  }
  return map
}

export interface PendingReviewPage {
  items: PendingReviewItem[]
  page: number
  pageSize: number
  total: number
  hasMore: boolean
}

/**
 * ONE page of the needs_review invoices shown in the combined Review & edit list
 * (§user #2). Eligibility is deliberately broad: EVERY pending row is reachable,
 * including an UNBATCHED one whose only problem is a missing/unparseable date, and
 * a NUMBERLESS one — those are exactly the rows a reviewer must open to correct.
 * Rows are offset-paged so a reviewer can walk a list longer than the 10-row
 * WhatsApp cap, and each carries its accounting month when attributable. A number
 * is never REQUIRED to list a row: approval remains gated downstream (confirmInvoice
 * / review.ts will not file a still-incomplete row), so widening this list can never
 * cause a blind approval. `total` is the count of pending invoices so the caller
 * knows whether a further page exists.
 */
export async function listPendingReviewPage(
  db: Db, workspaceId: string, page = 1, pageSize = REVIEW_PAGE_SIZE,
): Promise<PendingReviewPage> {
  const { masterKeyHex } = resolveFileKeyConfig()
  const p = Math.max(1, Math.trunc(page))
  const from = (p - 1) * pageSize
  const { data: invoices, error, count } = await db
    .from('invoices').select('id,batch_id', { count: 'exact' })
    .eq('workspace_id', workspaceId).eq('status', 'needs_review')
    .order('received_at', { ascending: false }).range(from, from + pageSize - 1)
  const total = typeof count === 'number' ? count : 0
  if (error) throw new Error(`REVIEW_LIST_ERROR: ${error.message}`)
  const rows = (invoices ?? []) as Array<{ id: string; batch_id?: string | null }>
  if (rows.length === 0) return { items: [], page: p, pageSize, total, hasMore: false }

  const periods = await batchPeriodMap(db, workspaceId, rows.map((r) => r.batch_id ?? null))
  const ids = rows.map((r) => r.id)
  const { data: records, error: recErr } = await db
    .from('extracted_records').select('invoice_id,encrypted_payload')
    .eq('workspace_id', workspaceId).eq('review_status', 'needs_review').in('invoice_id', ids)
  if (recErr) throw new Error(`REVIEW_RECORDS_ERROR: ${recErr.message}`)

  const batchById = new Map(rows.map((r) => [r.id, r.batch_id ?? null]))
  const items: PendingReviewItem[] = []
  for (const rec of (records ?? []) as Array<{ invoice_id: string; encrypted_payload: unknown }>) {
    let row: StoredRow
    try {
      row = JSON.parse(decryptExtractedPayload(byteaToBuffer(rec.encrypted_payload), masterKeyHex)) as StoredRow
    } catch {
      continue // undecryptable: skip it, never surface a garbage row to confirm
    }
    const number = typeof row.invoice_number === 'string' ? row.invoice_number.trim() : ''
    const vendor = typeof row.vendor_name === 'string' && row.vendor_name.trim() ? row.vendor_name.trim() : null
    const period = periods.get(batchById.get(rec.invoice_id) ?? '') ?? null
    items.push({
      invoiceId: rec.invoice_id,
      // Combined list label: fall back to vendor, then a clear marker, so a row
      // with no extracted number is still selectable (often exactly why it needs
      // editing) and never shown as a blank '#'.
      invoiceNumber: number || vendor || 'no number',
      vendorName: vendor,
      total: typeof row.total_amount === 'number' && Number.isFinite(row.total_amount)
        ? row.total_amount.toFixed(2) : null,
      why: summarizeReasons(storedReasons(row), 1),
      month: monthLabel(period),
    })
    if (items.length >= pageSize) break
  }
  return { items, page: p, pageSize, total, hasMore: from + pageSize < total }
}

/**
 * The first page of confirmable invoices (backwards-compatible thin wrapper over
 * listPendingReviewPage). New callers should page explicitly.
 */
export async function listPendingReview(
  db: Db, workspaceId: string,
): Promise<PendingReviewItem[]> {
  return (await listPendingReviewPage(db, workspaceId, 1, pageSize(10))).items
}

function pageSize(n: number): number { return Math.max(1, n) }

/**
 * Confirm ONE pending invoice on the reviewer's behalf: re-read its stored row
 * (tenant-scoped), echo the displayed required fields back as the confirmed
 * corrections, and run the shared review path. Idempotent — a double tap or a
 * webhook redelivery re-runs applyInvoiceReview, which upserts the row and
 * dedups the register enqueue, so it never creates a second batch or workbook.
 */
export async function confirmInvoice(
  db: Db, args: { workspaceId: string; invoiceId: string; deferRegister?: boolean },
): Promise<ConfirmOutcome> {
  const { workspaceId, invoiceId } = args
  const { masterKeyHex } = resolveFileKeyConfig()

  const { data: inv, error } = await db
    .from('invoices').select('id,status')
    .eq('workspace_id', workspaceId).eq('id', invoiceId).maybeSingle()
  if (error) return { ok: false, error: 'FAULT' }
  if (!inv) return { ok: false, error: 'NOT_FOUND' }
  if ((inv as { status: string }).status !== 'needs_review') {
    // Already completed/failed/deleted: a stale tap. Report it, change nothing.
    return { ok: false, error: 'NOT_PENDING' }
  }

  const { data: rec, error: recErr } = await db
    .from('extracted_records').select('encrypted_payload')
    .eq('workspace_id', workspaceId).eq('invoice_id', invoiceId).maybeSingle()
  if (recErr || !rec) return { ok: false, error: 'NOT_FOUND' }
  let row: StoredRow
  try {
    row = JSON.parse(decryptExtractedPayload(byteaToBuffer((rec as { encrypted_payload: unknown }).encrypted_payload), masterKeyHex)) as StoredRow
  } catch {
    return { ok: false, error: 'FAULT' }
  }

  // The corrections ARE the values the button displayed: confirming them is the
  // reviewer affirming exactly what they saw — never an invented field, and the
  // invoice number is present so review.ts honors a genuine approval.
  const corrections: LedgerCandidate = {}
  const strFields = ['invoice_number', 'invoice_date', 'vendor_name', 'supplier_gstin'] as const
  for (const f of strFields) {
    const v = row[f]
    if (typeof v === 'string' && v.trim() !== '') corrections[f] = v.trim()
  }
  const numFields = ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount'] as const
  for (const f of numFields) {
    const v = row[f]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) corrections[f] = v
  }

  const result = await applyInvoiceReview(db, {
    workspaceId, invoiceId, corrections, masterKeyHex, deferRegister: args.deferRegister,
  })
  return {
    ok: true,
    review: result.review,
    reasons: result.reasons,
    invoiceNumber: typeof row.invoice_number === 'string' ? row.invoice_number : null,
    vendorName: typeof row.vendor_name === 'string' ? row.vendor_name : null,
    batchId: result.batchId,
  }
}

// ---- WhatsApp-native bulk approval over the pending list (§P1-7) -----------
// A bounded, re-validating approve-everything path. It NEVER force-approves: each
// row runs the SAME confirmInvoice path, so an incomplete row stays needs_review.

/** Result of a bounded bulk-approve over the current confirmable page (§P1-7). */
export interface ApproveAllResult {
  approved: number
  stillPending: number
  failed: number
  /** §UX: distinct, field-specific "what to fix" hints aggregated from the rows
   *  that stayed pending, so "approve all" can tell the reviewer exactly WHICH
   *  field blocked filing instead of a vague "still needs attention". Descriptive
   *  only — it never changes an approval decision or force-files anything. */
  blockers: string[]
}

/**
 * Approve EVERY confirmable pending invoice in this workspace that is otherwise
 * complete, bounded to `cap` so a single tap can never fan out unbounded (cost +
 * the WhatsApp 24h window). Each one runs through confirmInvoice — the SAME shared
 * re-validating path — so precision is never traded for convenience: a row that
 * still fails validation simply stays needs_review (counted in stillPending) and is
 * NEVER force-approved. Tenant-scoped and idempotent (safe against a redelivery).
 */
export async function approveAllPending(
  db: Db, workspaceId: string, cap = 25,
): Promise<ApproveAllResult> {
  const items = await listPendingReview(db, workspaceId) // first (up to 10) confirmable
  let approved = 0; let stillPending = 0; let failed = 0
  const pendingReasons: string[] = []
  // §bulk-approve: the batches a newly-approved row was filed into. The per-row
  // register rebuild is DEFERRED (enqueue suppressed in confirmInvoice) and coalesced
  // into ONE deduped job per batch AFTER the loop, so build_register can never read a
  // half-approved batch and ship a partial workbook (the "September missing / only 2
  // of 3 rows" symptom seen in the field). Approvals + batching are unchanged.
  const touchedBatches = new Set<string>()
  for (const item of items.slice(0, Math.max(0, cap))) {
    const r = await confirmInvoice(db, { workspaceId, invoiceId: item.invoiceId, deferRegister: true })
    if (!r.ok) { failed += 1; continue }
    // Collect WHY a row stayed flagged (deduped by base code) so the summary can
    // name the exact field to correct (§UX). Purely descriptive — it never changes
    // the approve/hold decision made below.
    if (r.review !== 'approved') {
      for (const reason of r.reasons ?? []) {
        const base = reason.split(':')[0]
        if (!pendingReasons.some((x) => x.split(':')[0] === base)) pendingReasons.push(reason)
      }
    }
    if (r.review === 'approved') { approved += 1; if (r.batchId) touchedBatches.add(r.batchId) }
    else stillPending += 1 // re-validated but still flagged — never force-approved
  }
  // Coalesced scheduling: exactly one (deduped) register job per affected batch, now
  // that every approval has committed, so the single rebuild sees the full cumulative
  // approved set. Best-effort — an enqueue error cannot undo an approval, and any
  // later finalize for the batch re-schedules the register.
  for (const batchId of touchedBatches) {
    try {
      await enqueueRegisterGeneration(db, workspaceId, batchId)
    } catch (e) {
      logger.warn('[Review] coalesced register enqueue deferred', {
        batchId, error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return { approved, stillPending, failed, blockers: reasonFixHints(pendingReasons, 3) }
}

// ---- WhatsApp-native editable review (correct a field, then approve) --------
// The data/DB half of the combined in-chat editor (§user #2): the Review list row
// opens THIS editor, where a reviewer sees every field, corrects any of them, and
// only then approves. These helpers perform NO sending and NEVER invent a value or
// approve on a correction: a correction persists + re-validates through the SAME
// shared path the web/API uses (applyInvoiceCorrection), while only an explicit
// approve (confirmInvoice) files the invoice.

export type InvoiceEditLoad =
  | { ok: true; row: LedgerRow; reasons: string[]; classification: { documentType: string; accountingCategory: string; itcEligibility: string } | null }
  | { ok: false; error: 'NOT_FOUND' | 'NOT_PENDING' | 'FAULT' }

/**
 * Read + decrypt one invoice's stored row so the route can render the numbered
 * editor. Tenant-scoped; refuses an unknown/other-workspace id and an invoice
 * that is no longer pending, and never renders a corrupt row (FAULT). Opening the
 * editor is read-only — it changes nothing and approves nothing.
 */
export async function loadInvoiceForEdit(
  db: Db, args: { workspaceId: string; invoiceId: string },
): Promise<InvoiceEditLoad> {
  const { workspaceId, invoiceId } = args
  const { masterKeyHex } = resolveFileKeyConfig()
  const { data: inv, error } = await db
    .from('invoices').select('id,status')
    .eq('workspace_id', workspaceId).eq('id', invoiceId).maybeSingle()
  if (error) return { ok: false, error: 'FAULT' }
  if (!inv) return { ok: false, error: 'NOT_FOUND' }
  if ((inv as { status: string }).status !== 'needs_review') return { ok: false, error: 'NOT_PENDING' }
  const { data: rec, error: recErr } = await db
    .from('extracted_records').select('encrypted_payload')
    .eq('workspace_id', workspaceId).eq('invoice_id', invoiceId).maybeSingle()
  if (recErr) return { ok: false, error: 'FAULT' }
  if (!rec) return { ok: false, error: 'NOT_FOUND' }
  try {
    const parsed = JSON.parse(
      decryptExtractedPayload(byteaToBuffer((rec as { encrypted_payload: unknown }).encrypted_payload), masterKeyHex),
    ) as StoredRow
    const cls = parsed._classification
    const classification = cls && typeof cls.documentType === 'string' && typeof cls.accountingCategory === 'string'
      ? { documentType: cls.documentType, accountingCategory: cls.accountingCategory, itcEligibility: typeof cls.itcEligibility === 'string' ? cls.itcEligibility : 'needs_review' }
      : null
    return { ok: true, row: parsed as unknown as LedgerRow, reasons: storedReasons(parsed), classification }
  } catch {
    return { ok: false, error: 'FAULT' }
  }
}

export interface InvoiceEditOutcome {
  ok: boolean
  /** Field-level validation failures for this single edit (never silently dropped). */
  fieldErrors?: Array<{ field: string; code: string }>
  review?: 'approved' | 'needs_review'
  reasons?: string[]
  row?: LedgerRow
  /** True when the corrected row now validates clean + dated: a later APPROVE files it. */
  approvable?: boolean
  /** §Part-2 the classification after this edit, for the read-only editor line. */
  classification?: { documentType: string; accountingCategory: string; itcEligibility: string } | null
  error?: 'NOT_FOUND' | 'NOT_PENDING' | 'FAULT'
}

/**
 * Apply ONE editor field correction and re-validate — WITHOUT approving or
 * batching. The raw typed value goes through the SAME parseReviewCorrections the
 * web/API uses (so a value accepted in chat can never be rejected in the API or
 * vice-versa), then applyInvoiceCorrection persists the corrected row + audit and
 * deterministically re-scores it. A correction NEVER touches the lifecycle status;
 * only an explicit APPROVE does. Tenant + pending are re-checked before mutating.
 */
export async function applyInvoiceEdit(
  db: Db, args: { workspaceId: string; invoiceId: string; fieldKey: keyof LedgerRow; rawValue: string },
): Promise<InvoiceEditOutcome> {
  const { workspaceId, invoiceId, fieldKey, rawValue } = args
  const { masterKeyHex } = resolveFileKeyConfig()
  const { data: inv, error } = await db
    .from('invoices').select('id,status')
    .eq('workspace_id', workspaceId).eq('id', invoiceId).maybeSingle()
  if (error) return { ok: false, error: 'FAULT' }
  if (!inv) return { ok: false, error: 'NOT_FOUND' }
  if ((inv as { status: string }).status !== 'needs_review') return { ok: false, error: 'NOT_PENDING' }

  const { corrections, errors } = parseReviewCorrections({ [fieldKey]: rawValue })
  if (errors.length > 0) return { ok: false, fieldErrors: errors }

  try {
    const res = await applyInvoiceCorrection(db, { workspaceId, invoiceId, corrections, masterKeyHex })
    return {
      ok: true, review: res.review, reasons: res.reasons, row: res.row, approvable: res.approvable,
      classification: res.classification
        ? { documentType: res.classification.documentType, accountingCategory: res.classification.accountingCategory, itcEligibility: res.classification.itcEligibility }
        : null,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/CORRECTION_INVOICE_NOT_FOUND/.test(msg)) return { ok: false, error: 'NOT_FOUND' }
    return { ok: false, error: 'FAULT' }
  }
}
