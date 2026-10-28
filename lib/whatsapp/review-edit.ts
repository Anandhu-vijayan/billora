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
 * Plain-English description of a machine reason code, so the reviewer sees WHY an
 * invoice was flagged instead of an opaque code (§P0-3). Codes come from
 * lib/ocr/ledger.ts + lib/invoices/review.ts. A dynamic code (a `low-confidence:`
 * or `total-mismatch:` suffix, or an unknown future code) degrades to a truthful
 * generic line rather than a fabricated specific claim — the description never
 * asserts a cause we did not detect.
 */
const REASON_TEXT: Record<string, string> = {
  'invoice-date-unresolved': 'no readable invoice date',
  'invoice-date-future': 'the invoice date is in the future',
  'invoice-date-before-gst': 'the invoice date is before GST existed',
  'invoice-number-missing': 'no invoice number was found',
  'invoice-number-placeholder': 'the invoice number looks like a placeholder',
  'vendor-name-missing': 'no supplier name was found',
  'vendor-name-placeholder': 'the supplier name looks like a placeholder',
  'gstin-missing': 'no supplier GSTIN was found',
  'gstin-invalid': 'the supplier GSTIN is not a valid format',
  'gstin-state-invalid': 'the supplier GSTIN state code is invalid',
  'gstin-checksum-failed': 'the supplier GSTIN failed its checksum',
  'supplier-equals-buyer': 'the supplier GSTIN is actually your own (the buyer)',
  'supplier-equals-recipient': 'the supplier and buyer GSTINs are the same',
  'non-finite-amount': 'an amount could not be read as a number',
  'negative-amount': 'an amount came back negative',
  'total-zero': 'the total came back as zero',
  'igst-with-cgst-sgst': 'IGST and CGST/SGST are both present (pick one)',
  'cgst-sgst-unequal': 'CGST and SGST should be equal for a within-state bill',
  'igst-on-intrastate': 'IGST was used on a within-state bill',
  'cgst-sgst-on-interstate': 'CGST/SGST were used on an inter-state bill',
  'tax-rate-mismatch': 'a printed tax rate and its amount disagree',
  'tax-rate-amount-missing': 'a tax rate is printed but its amount is missing',
  'tax-rate-invalid': 'a printed tax rate could not be read',
  'tax-rate-cgst-sgst-unequal': 'the printed CGST/SGST rates are unequal',
  'tax-rate-igst-with-cgst-sgst': 'the printed tax-head rates conflict',
  'amount-words-total-mismatch': 'the amount in words disagrees with the numeric total',
  'candidate-conflict': 'two readings of the same field disagree',
  'image-too-blurry': 'the photo looks too blurry to read reliably',
  'image-too-small': 'the image resolution is too low to read reliably',
  'multi-invoice-document': 'this file looks like more than one invoice — only one was read, please split the others out',
  'credit-debit-note': 'this is a credit/debit note (it changes an earlier invoice), so a person must check it before it is used',
  // §Part-2 classification reasons (from lib/ocr/classify.ts). Descriptive only.
  'document-heading-conflict': 'the document prints more than one kind of title (for example a bill of supply and a tax invoice), so its type is ambiguous',
  'payment-evidence-not-an-invoice': 'this looks like a receipt or payment voucher (proof of payment), not a purchase invoice, so a person must check it',
  'delivery-challan-not-a-tax-invoice': 'this looks like a delivery challan (a goods-movement slip), not a tax invoice, so a person must check it',
  'proforma-not-a-tax-invoice': 'this looks like a proforma (a quotation), not a final tax invoice, so a person must check it',
  'category-evidence-conflict': 'the document has wording for more than one kind of accounting category, so its treatment is unclear',
  'category-could-not-be-determined': 'how this document should be booked could not be determined, so a person must choose its category',
  // §Part-5 duplicate-prevention reasons. Descriptive only — a possible duplicate
  // is flagged for a human to confirm, never auto-dropped or auto-approved.
  'possible-duplicate': 'this looks like the same invoice (same number, supplier and date) as one already filed, so please check it is not a duplicate',
  'review-confirmation-required': 'the invoice number has not been confirmed yet',
}

/** Turn one reason code into a short plain-English phrase. Never invents a cause. */
export function describeReason(code: string): string {
  const base = code.split(':')[0]
  if (base === 'low-confidence') return 'the reading was low-confidence'
  if (base === 'total-mismatch') return 'the amounts do not add up to the total'
  return REASON_TEXT[base] ?? 'it needs a manual check'
}

// Which EDITABLE_FIELDS number a reason code is actually about, so the editor can
// tell the reviewer exactly WHICH field to fix (§UX). A reason with no single
// value field (a document-type / duplicate / image / low-confidence check) has NO
// entry here and is surfaced as a 'general check' instead of pointing at a field
// that would not clear it — we never send a reviewer to edit a field that is not
// the real blocker. The 'amounts' sentinel means the money block (fields 5-9).
const REASON_FIELD: Record<string, number | 'amounts'> = {
  'invoice-number-missing': 1, 'invoice-number-placeholder': 1, 'review-confirmation-required': 1,
  'gstin-missing': 2, 'gstin-invalid': 2, 'gstin-state-invalid': 2, 'gstin-checksum-failed': 2,
  'supplier-equals-buyer': 2, 'supplier-equals-recipient': 2,
  'vendor-name-missing': 3, 'vendor-name-placeholder': 3,
  'invoice-date-unresolved': 4, 'invoice-date-future': 4, 'invoice-date-before-gst': 4,
  'non-finite-amount': 'amounts', 'negative-amount': 'amounts', 'total-zero': 'amounts',
  'igst-with-cgst-sgst': 'amounts', 'cgst-sgst-unequal': 'amounts', 'igst-on-intrastate': 'amounts',
  'cgst-sgst-on-interstate': 'amounts', 'tax-rate-mismatch': 'amounts', 'tax-rate-amount-missing': 'amounts',
  'tax-rate-invalid': 'amounts', 'tax-rate-cgst-sgst-unequal': 'amounts', 'tax-rate-igst-with-cgst-sgst': 'amounts',
  'amount-words-total-mismatch': 'amounts', 'total-mismatch': 'amounts', 'candidate-conflict': 'amounts',
}

/**
 * Concrete, field-specific "what to type" hints for the flagged reasons (§UX).
 * Each line names the exact editor field number(s) that clear the reason, so a
 * reviewer never stares at a vague "needs review" with no idea which value is
 * wrong. A reason that no single field can clear becomes one honest 'general
 * check' line rather than a misleading field pointer. De-duplicated and capped
 * to keep the message inside the WhatsApp text limits.
 */
export function reasonFixHints(codes: readonly string[], maxItems = 3): string[] {
  const fielded: string[] = []
  let generalCount = 0
  const seen = new Set<string>()
  for (const code of codes) {
    const base = code.split(':')[0]
    const target = REASON_FIELD[base]
    const why = describeReason(code)
    if (target === undefined) { generalCount += 1; continue }
    const ref = target === 'amounts'
      ? `${EDITABLE_FIELDS[4].index}-${EDITABLE_FIELDS[EDITABLE_FIELDS.length - 1].index} (the amounts)`
      : `${target} (${editableFieldByIndex(target)?.label ?? 'this field'})`
    const line = `reply ${ref} — ${why}`
    if (seen.has(line)) continue
    seen.add(line); fielded.push(line)
  }
  const out = fielded.slice(0, maxItems)
  const hiddenFielded = fielded.length - out.length
  if (generalCount > 0) {
    out.push(hiddenFielded > 0
      ? `plus ${hiddenFielded + generalCount} more check(s) — correct what looks wrong, then reply APPROVE`
      : `also: ${generalCount} general check(s) no single field clears — fix what looks wrong, then reply APPROVE`)
  } else if (hiddenFielded > 0) {
    out.push(`+${hiddenFielded} more field(s) to correct`)
  }
  return out
}

/**
 * A compact, de-duplicated one-line summary of why a row is flagged, safe for a
 * WhatsApp list description. `maxItems` bounds length so a row stays within the
 * Meta interactive-row character caps even when many checks failed.
 */
export function summarizeReasons(codes: readonly string[], maxItems = 2): string {
  const unique: string[] = []
  for (const c of codes) {
    const t = describeReason(c)
    if (!unique.includes(t)) unique.push(t)
  }
  if (unique.length === 0) return 'needs a manual check'
  const shown = unique.slice(0, maxItems).join('; ')
  return unique.length > maxItems ? `${shown}; +${unique.length - maxItems} more` : shown
}

/** Readable labels for a stored classification, shown to the reviewer as info only. */
const DOC_TYPE_LABEL: Record<string, string> = {
  invoice: 'Tax invoice', credit_note: 'Credit note', debit_note: 'Debit note',
  bill_of_supply: 'Bill of supply', receipt: 'Receipt', payment_voucher: 'Payment voucher',
  delivery_challan: 'Delivery challan', proforma_invoice: 'Proforma invoice', unknown: 'not recognised',
}
const CATEGORY_LABEL: Record<string, string> = {
  purchase: 'Purchase', expense: 'Expense', service: 'Service',
  fixed_asset: 'Fixed asset', other: 'Other', unknown: 'not set',
}

/**
 * Compose the numbered editor body. Shown ONLY to the invoice's own (verified)
 * reviewer in their private chat, so surfacing the extracted values is the whole
 * point of an editable review — this is a display, not a log. `note` carries the
 * result of the last action (e.g. "Saved — amounts still don't add up; correct the
 * total") so the reviewer sees the effect of their edit. `classification` (§Part-2)
 * is shown as a read-only line so the reviewer sees the machine's document type
 * and accounting category; it is descriptive only and never editable via a numbered
 * field here (a confirmed re-classification goes through the shared review path).
 */
export function composeReviewEditorMessage(
  row: Partial<LedgerRow>,
  opts?: {
    header?: string
    note?: string
    reasons?: readonly string[]
    classification?: { documentType?: string; accountingCategory?: string } | null
  },
): string {
  const header = opts?.header ?? 'Editing this invoice. Reply with a number and the new value.'
  const lines: string[] = [header]
  if (opts?.note) lines.push(opts.note)
  // Why this invoice is flagged, in plain English (§P0-3). Shown under the header
  // so the reviewer knows which field to fix; purely descriptive, changes nothing.
  if (opts?.reasons && opts.reasons.length > 0) {
    lines.push(`Why this needs a check: ${summarizeReasons(opts.reasons, 3)}`)
    // §UX: name the EXACT field number that clears each blocker, so "type something"
    // is never a guess. Descriptive only — it changes no value and approves nothing.
    const hints = reasonFixHints(opts.reasons)
    if (hints.length > 0) {
      lines.push('To fix, reply with the number shown:')
      for (const h of hints) lines.push(`• ${h}`)
    }
  }
  // §Part-2 read-only classification line (only when a classification is present).
  if (opts?.classification) {
    const dt = DOC_TYPE_LABEL[opts.classification.documentType ?? 'unknown'] ?? 'not recognised'
    const cat = CATEGORY_LABEL[opts.classification.accountingCategory ?? 'unknown'] ?? 'not set'
    lines.push(`Detected: ${dt} · Category: ${cat}`)
  }
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
