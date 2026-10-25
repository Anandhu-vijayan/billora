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
}

export interface PendingReviewItem {
  invoiceId: string
  invoiceNumber: string
  vendorName: string | null
  total: string | null
}

/**
 * The needs_review invoices in this workspace that CAN be confirmed in chat:
 * they must already be batched (a reliable invoice date existed), carry an
 * extracted invoice number (the field a confirm affirms), and store a readable
 * row. Returns at most 10 (a WhatsApp list's row cap), newest first.
 */
export async function listPendingReview(
  db: Db, workspaceId: string,
): Promise<PendingReviewItem[]> {
  const { masterKeyHex } = resolveFileKeyConfig()
  const { data: invoices, error } = await db
    .from('invoices').select('id')
    .eq('workspace_id', workspaceId).eq('status', 'needs_review').not('batch_id', 'is', null)
    .order('received_at', { ascending: false }).limit(10)
  if (error) throw new Error(`REVIEW_LIST_ERROR: ${error.message}`)
  const ids = (invoices ?? []).map((r) => (r as { id: string }).id)
  if (ids.length === 0) return []

  const { data: records, error: recErr } = await db
    .from('extracted_records').select('invoice_id,encrypted_payload')
    .eq('workspace_id', workspaceId).eq('review_status', 'needs_review').in('invoice_id', ids)
  if (recErr) throw new Error(`REVIEW_RECORDS_ERROR: ${recErr.message}`)

  const items: PendingReviewItem[] = []
  for (const rec of (records ?? []) as Array<{ invoice_id: string; encrypted_payload: unknown }>) {
    let row: StoredRow
    try {
      row = JSON.parse(decryptExtractedPayload(byteaToBuffer(rec.encrypted_payload), masterKeyHex)) as StoredRow
    } catch {
      continue // undecryptable: skip it, never surface a garbage row to confirm
    }
    const invoiceNumber = typeof row.invoice_number === 'string' ? row.invoice_number.trim() : ''
    if (!invoiceNumber) continue // nothing to confirm meaningfully; stays flagged
    items.push({
      invoiceId: rec.invoice_id,
      invoiceNumber,
      vendorName: typeof row.vendor_name === 'string' ? row.vendor_name : null,
      total: typeof row.total_amount === 'number' && Number.isFinite(row.total_amount)
        ? row.total_amount.toFixed(2) : null,
    })
    if (items.length >= 10) break
  }
  return items
}

/**
 * Confirm ONE pending invoice on the reviewer's behalf: re-read its stored row
 * (tenant-scoped), echo the displayed required fields back as the confirmed
 * corrections, and run the shared review path. Idempotent — a double tap or a
 * webhook redelivery re-runs applyInvoiceReview, which upserts the row and
 * dedups the register enqueue, so it never creates a second batch or workbook.
 */
export async function confirmInvoice(
  db: Db, args: { workspaceId: string; invoiceId: string },
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

  const result = await applyInvoiceReview(db, { workspaceId, invoiceId, corrections, masterKeyHex })
  return {
    ok: true,
    review: result.review,
    reasons: result.reasons,
    invoiceNumber: typeof row.invoice_number === 'string' ? row.invoice_number : null,
    vendorName: typeof row.vendor_name === 'string' ? row.vendor_name : null,
    batchId: result.batchId,
  }
}

// ---- WhatsApp-native editable review (correct a field, then approve) --------
// These are the data/DB half of the in-chat editor. They perform NO sending and
// NEVER invent a value or approve on a correction: a correction persists +
// re-validates through the SAME shared path the web/API uses (applyInvoiceCorrec
// tion), while only an explicit approve (confirmInvoice) files the invoice.

/** One invoice shown in the edit picker. `invoiceNumber` is a DISPLAY label. */
export interface EditableInvoiceItem {
  invoiceId: string
  invoiceNumber: string
  vendorName: string | null
  total: string | null
}

/**
 * The needs_review invoices the reviewer may OPEN to correct fields. Unlike
 * listPendingReview this does NOT require a batch or an extracted invoice number:
 * an invoice whose only problem is a missing/unparseable DATE (so it was never
 * batched) or a missing NUMBER is exactly the one that needs editing — leaving it
 * out would make it unreachable in-chat. Newest first, capped at the WhatsApp
 * list's 10 rows; an undecryptable row is skipped, never rendered as garbage.
 */
export async function listEditableInvoices(
  db: Db, workspaceId: string,
): Promise<EditableInvoiceItem[]> {
  const { masterKeyHex } = resolveFileKeyConfig()
  const { data: invoices, error } = await db
    .from('invoices').select('id')
    .eq('workspace_id', workspaceId).eq('status', 'needs_review')
    .order('received_at', { ascending: false }).limit(10)
  if (error) throw new Error(`REVIEW_EDIT_LIST_ERROR: ${error.message}`)
  const ids = (invoices ?? []).map((r) => (r as { id: string }).id)
  if (ids.length === 0) return []

  const { data: records, error: recErr } = await db
    .from('extracted_records').select('invoice_id,encrypted_payload')
    .eq('workspace_id', workspaceId).eq('review_status', 'needs_review').in('invoice_id', ids)
  if (recErr) throw new Error(`REVIEW_EDIT_RECORDS_ERROR: ${recErr.message}`)

  const items: EditableInvoiceItem[] = []
  for (const rec of (records ?? []) as Array<{ invoice_id: string; encrypted_payload: unknown }>) {
    let row: StoredRow
    try {
      row = JSON.parse(decryptExtractedPayload(byteaToBuffer(rec.encrypted_payload), masterKeyHex)) as StoredRow
    } catch {
      continue // undecryptable: skip it, never surface a garbage row to edit
    }
    const number = typeof row.invoice_number === 'string' ? row.invoice_number.trim() : ''
    const vendor = typeof row.vendor_name === 'string' && row.vendor_name.trim() ? row.vendor_name.trim() : null
    items.push({
      invoiceId: rec.invoice_id,
      // A truthful picker label: fall back to the vendor, then a clear marker, so
      // an invoice with no extracted number is still selectable (that is often
      // exactly why it needs editing) — never shown as a blank '#'.
      invoiceNumber: number || vendor || 'no number',
      vendorName: vendor,
      total: typeof row.total_amount === 'number' && Number.isFinite(row.total_amount)
        ? row.total_amount.toFixed(2) : null,
    })
    if (items.length >= 10) break
  }
  return items
}

export type InvoiceEditLoad =
  | { ok: true; row: LedgerRow }
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
    const row = JSON.parse(
      decryptExtractedPayload(byteaToBuffer((rec as { encrypted_payload: unknown }).encrypted_payload), masterKeyHex),
    ) as LedgerRow
    return { ok: true, row }
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
    return { ok: true, review: res.review, reasons: res.reasons, row: res.row, approvable: res.approvable }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/CORRECTION_INVOICE_NOT_FOUND/.test(msg)) return { ok: false, error: 'NOT_FOUND' }
    return { ok: false, error: 'FAULT' }
  }
}
