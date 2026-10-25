// lib/whatsapp/review-edit.ts — pure WhatsApp-native editable-review helpers.
//
// This is the state-free half of the in-chat correction flow: it turns one
// flagged invoice's stored row into a numbered editor the reviewer can read,
// parses their typed reply into an unambiguous command, and maps a field number
// back to the canonical LedgerCandidate key the shared review path
// (lib/invoices/review.ts) already validates and persists. It performs NO I/O,
// touches NO database, and NEVER changes a value — it only decides WHICH field a
// reply refers to and hands the raw entered text to the same validated
// `applyInvoiceCorrection` the web/API reviewer uses, so a WhatsApp correction
// can never diverge from the API's field validation.
//
// Alias-free + import-only-types so the in-process test harness (which transpiles
// one file and cannot resolve `@/`) exercises the REAL parser, not a copy.
import type { LedgerRow } from '../ocr/ledger'

/** The canonical fields a reviewer may correct, in display order. */
export type EditableFieldKind = 'text' | 'gstin' | 'date' | 'amount'
export interface EditableField {
  /** 1-based number shown to the reviewer. */
  index: number
  /** Canonical LedgerCandidate / LedgerRow key the shared path expects. */
  key: keyof LedgerRow
  /** Plain-English label. */
  label: string
  /** Value class, so the caller knows how the shared validator treats it. */
  kind: EditableFieldKind
}

// The editable set is exactly the canonical register row. Tax RATES and ROUND-OFF
// are carried through extraction/export but are intentionally NOT offered for
// single-field chat correction in this profile: the register is one row per
// invoice with invoice-level heads, so a rate/round-off edit cannot be
// re-validated against line data here. They stay surfaced for the reviewer to
// re-check by correcting the amounts they were derived from, never auto-filled.
export const EDITABLE_FIELDS: readonly EditableField[] = [
  { index: 1, key: 'invoice_number', label: 'Invoice number', kind: 'text' },
  { index: 2, key: 'supplier_gstin', label: 'Supplier GSTIN', kind: 'gstin' },
  { index: 3, key: 'vendor_name', label: 'Supplier name', kind: 'text' },
  { index: 4, key: 'invoice_date', label: 'Invoice date', kind: 'date' },
  { index: 5, key: 'taxable_value', label: 'Taxable value', kind: 'amount' },
  { index: 6, key: 'cgst_amount', label: 'CGST amount', kind: 'amount' },
  { index: 7, key: 'sgst_amount', label: 'SGST amount', kind: 'amount' },
  { index: 8, key: 'igst_amount', label: 'IGST amount', kind: 'amount' },
  { index: 9, key: 'total_amount', label: 'Invoice total', kind: 'amount' },
] as const

export const MAX_FIELD_INDEX = EDITABLE_FIELDS.length

export function editableFieldByIndex(index: number): EditableField | null {
  return EDITABLE_FIELDS.find((f) => f.index === index) ?? null
}

/** A parsed reviewer reply within the editor. Never coerces a value. */
export type ReviewEditCommand =
  | { action: 'approve' }
  | { action: 'cancel' }
  | { action: 'help' }
  /** `value` is the RAW entered text for the named field; validation is the shared path's job. */
  | { action: 'correct'; field: EditableField; value: string }
  /** A bare/absent/over-range field number with no usable value. */
  | { action: 'unknown-field'; fieldNo: number | null }
  /** Anything we cannot classify — the caller re-prompts with the field list. */
  | { action: 'reprompt' }

const APPROVE_WORDS = new Set(['approve', 'ok', 'confirm', 'save', 'yes'])
const CANCEL_WORDS = new Set(['cancel', 'back', 'exit', 'leave', 'done', 'no'])
const HELP_WORDS = new Set(['help', '?', 'menu', 'info'])

/**
 * Classify one editor reply. Numbered corrections use the unambiguous
 * `<fieldNumber> <value>` form (a leading number, then the value — the value may
 * itself contain spaces, e.g. a supplier name). A number with no following value,
 * or an out-of-range number, is NOT guessed: it becomes `unknown-field` so the
 * caller shows valid options rather than silently applying the wrong edit.
 */
export function parseReviewEditCommand(raw: string | null | undefined): ReviewEditCommand {
  const text = (raw ?? '').trim()
  if (text === '') return { action: 'reprompt' }
  const lower = text.toLowerCase()
  if (APPROVE_WORDS.has(lower)) return { action: 'approve' }
  if (CANCEL_WORDS.has(lower)) return { action: 'cancel' }
  if (HELP_WORDS.has(lower)) return { action: 'help' }

  // Leading field number, then everything after it is the value.
  const m = /^(\d{1,2})(?![\d])(?:[\s:=-]+([\s\S]*))?$/.exec(text)
  if (m) {
    const fieldNo = Number(m[1])
    const value = (m[2] ?? '').trim()
    const field = editableFieldByIndex(fieldNo)
    if (!field || value === '') return { action: 'unknown-field', fieldNo }
    return { action: 'correct', field, value }
  }
  return { action: 'reprompt' }
}

/** Render one stored value for display: never invents, marks unset as "(not set)". */
function displayValue(row: Partial<LedgerRow>, field: EditableField): string {
  const v = row[field.key]
  if (v === null || v === undefined || v === '') return '(not set)'
  if (field.kind === 'amount') {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n.toFixed(2) : String(v)
  }
  return String(v)
}

/**
 * Compose the numbered editor body. Shown ONLY to the invoice's own (verified)
 * reviewer in their private chat, so surfacing the extracted values is the whole
 * point of an editable review — this is a display, not a log. `note` carries the
 * result of the last action (e.g. "Saved — amounts still don't add up; correct the
 * total") so the reviewer sees the effect of their edit.
 */
export function composeReviewEditorMessage(
  row: Partial<LedgerRow>,
  opts?: { header?: string; note?: string },
): string {
  const header = opts?.header ?? 'Editing this invoice. Reply with a number and the new value.'
  const lines: string[] = [header]
  if (opts?.note) lines.push(opts.note)
  lines.push('')
  for (const f of EDITABLE_FIELDS) {
    lines.push(`${f.index}. ${f.label}: ${displayValue(row, f)}`)
  }
  lines.push('')
  lines.push('Example — reply: 1 INV-000125')
  lines.push('Reply APPROVE when everything looks right, or CANCEL to leave it flagged.')
  return lines.join('\n')
}

/** Short, safe help text when a reply cannot be classified. */
export const REVIEW_EDIT_HELP =
  'Reply with a field number and the new value (for example: 1 INV-000125), '
  + 'or APPROVE to confirm, or CANCEL to leave this invoice flagged.'
