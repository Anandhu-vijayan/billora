// lib/ocr/classify.ts — Part 2 (§2.1–2.3): document type vs accounting category.
//
// Two INDEPENDENT concepts, one deterministic rules engine, zero I/O:
//   * documentType     — what the printed document IS (tax invoice, bill of
//     supply, credit/debit note, receipt, proforma, ...). Read ONLY from the
//     document's own headings/titles, never from an amount or a filename.
//   * accountingCategory — how it should be treated in the books (purchase,
//     expense, service, fixed asset, other). Only ever set from explicit
//     evidence; anything else stays 'unknown' and goes to human Review.
//
// Design rules this file enforces (from the production spec):
//   * Never fabricate: an absent or conflicting signal is 'unknown' + review,
//     never a guess. A note keeps its OWN document type even when it relates to
//     a purchase — the relationship is carried as `originalInvoiceRef` instead
//     of discarding the type.
//   * Headings are matched in the document's HEAD region only (see
//     HEADING_MAX_LINES) — "Receipt" in a footer signature line or "payment"
//     in bank details must not reclassify a genuine TAX INVOICE.
//   * The word "invoice" inside a credit-note body does not turn a note back
//     into an invoice: structural note detection runs first (full text, the
//     historical §P3-16 semantics), then the heading region decides between
//     the invoice-shaped types.
//   * AI output is only ever accepted through `acceptAiClassification`, which
//     re-validates every field against the strict enums (an out-of-enum label
//     is rejected, not coerced) and still demands Review when the answer is
//     'unknown' or disagrees with strong deterministic evidence.
//   * This module is alias-free and import-free so the in-process test
//     harness transpiles and runs the REAL engine, not a copy.

// ---------------------------------------------------------------------------
// Strict enums (source of truth for DB CHECKs, validation and exports).
// ---------------------------------------------------------------------------

export const DOC_TYPES = [
  'invoice', 'credit_note', 'debit_note', 'bill_of_supply',
  'receipt', 'payment_voucher', 'delivery_challan', 'proforma_invoice', 'unknown',
] as const
export type DocTypeFull = (typeof DOC_TYPES)[number]

export const ACCOUNTING_CATEGORIES = [
  'purchase', 'expense', 'service', 'fixed_asset', 'capital_purchase', 'sales', 'other', 'unknown',
] as const
export type AccountingCategory = (typeof ACCOUNTING_CATEGORIES)[number]

/**
 * §3.3 categories the MACHINE may never auto-assign. 'capital_purchase' and 'sales'
 * carry legal/use ambiguity the spec forbids guessing at ("HSN must not determine
 * whether an item is a purchase, expense or capital purchase"; "Sales classification
 * must follow the configured business workflow and document direction"), so they are
 * reachable ONLY through a human confirmation (applyUserClassification).
 * decideAccountingCategory never returns them, and acceptAiClassification rejects an
 * AI that proposes them — closing the loophole where a model reply would count as an
 * auto-assignment. The legacy 'fixed_asset' rules behaviour is left untouched.
 */
export const MACHINE_FORBIDDEN_CATEGORIES: ReadonlySet<AccountingCategory> =
  new Set<AccountingCategory>(['capital_purchase', 'sales'])

/**
 * §3.3 a THIRD, independent classification dimension — input-tax-credit eligibility.
 * The machine NEVER claims 'eligible' (that is a legal §17(5) determination we must
 * not fabricate); it only ever returns 'ineligible' for a document categorically not
 * a tax invoice, or 'needs_review'. A human sets the final value via the review path.
 * ITC is DESCRIPTIVE ONLY: it never adds a blocking review reason and never filters a
 * record out of its register (§5).
 */
export const ITC_ELIGIBILITY = ['eligible', 'ineligible', 'needs_review'] as const
export type ItcEligibility = (typeof ITC_ELIGIBILITY)[number]

export const CLASSIFICATION_METHODS = ['rules', 'ai', 'user'] as const
export type ClassificationMethod = (typeof CLASSIFICATION_METHODS)[number]

export const CLASSIFICATION_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const
export type ClassificationConfidence = (typeof CLASSIFICATION_CONFIDENCE_LEVELS)[number]

/** Current rules-engine version; bump on any rule change so stored rows are re-processable (§2.3). */
export const CLASSIFICATION_VERSION = 1

const DOC_TYPE_SET: ReadonlySet<string> = new Set(DOC_TYPES)
const CATEGORY_SET: ReadonlySet<string> = new Set(ACCOUNTING_CATEGORIES)
const ITC_SET: ReadonlySet<string> = new Set(ITC_ELIGIBILITY)

export function isDocTypeFull(value: unknown): value is DocTypeFull {
  return typeof value === 'string' && DOC_TYPE_SET.has(value)
}
export function isAccountingCategory(value: unknown): value is AccountingCategory {
  return typeof value === 'string' && CATEGORY_SET.has(value)
}
export function isItcEligibility(value: unknown): value is ItcEligibility {
  return typeof value === 'string' && ITC_SET.has(value)
}

/** Categories whose documents are purchase-register-shaped (the historical product scope). */
const INVOICE_SHAPED: ReadonlySet<DocTypeFull> = new Set<DocTypeFull>([
  'invoice', 'credit_note', 'debit_note', 'bill_of_supply',
])
/** Non-invoice documents that are never ledger additions on their own — human review. */
const REVIEW_ONLY_TYPES: Partial<Record<DocTypeFull, string>> = {
  receipt: 'payment-evidence-not-an-invoice',
  payment_voucher: 'payment-evidence-not-an-invoice',
  delivery_challan: 'delivery-challan-not-a-tax-invoice',
  proforma_invoice: 'proforma-not-a-tax-invoice',
}

// ---------------------------------------------------------------------------
// Deterministic heading rules.
// ---------------------------------------------------------------------------

/**
 * A document heading sits at the TOP. Only the first N non-empty lines (and a
 * character budget so one giant line cannot swallow the whole page) count as
 * heading evidence. `classifyFromText` must be fed this region, so a footer
 * "Received payment" or a bank-details "Payment terms" line cannot reclassify.
 */
export const HEADING_MAX_LINES = 15
export const HEADING_MAX_CHARS = 800

/** Pure: take the head region of a raw extracted text for heading classification. */
export function headingRegion(text: string): string {
  const lines = (text ?? '').replace(/\r/g, '').split('\n')
    .map((l) => l.trim()).filter((l) => l.length > 0)
  let out = ''
  for (let i = 0; i < Math.min(HEADING_MAX_LINES, lines.length); i++) {
    if (out.length >= HEADING_MAX_CHARS) break
    out += (out ? '\n' : '') + lines[i]
  }
  return out.slice(0, HEADING_MAX_CHARS)
}

// Document-title signals, matched in the heading region. These are grouped by
// SPECIFICITY, not by first-word position: a genuine invoice-family title is
// strong purchase-register evidence and is NEVER hijacked by a stray generic
// "receipt" / "voucher" line elsewhere in the head (which would misclassify a
// real TAX INVOICE into a review-forcing non-invoice type and regress recall).
// A note is matched ONLY structurally (below), never here — a "credit note" may
// appear in a tax invoice's footer legend and must not change the invoice type.
const BILL_OF_SUPPLY_RE = /\bbill\s+of\s+supply\b/i
// proforma invoice / pro-forma / proforma tax invoice
const PROFORMA_RE = /\bpro[\s-]?forma\b[^&\n]{0,40}?\binvoice\b|\bproforma\b/i
// the invoice family (tax / commercial invoice). Tested AFTER bill-of-supply and
// proforma so those more-specific titles win.
const INVOICE_FAMILY_RE = /\b(?:tax\s+|commercial\s+)?invoice\b/i
// standalone non-invoice document titles — phrase-required, never a bare keyword,
// so a "Received by" signature line or a "credit period" term cannot qualify.
const PAYMENT_VOUCHER_RE = /\bpayment\s+voucher\b|\bvoucher\s+cum\s+receipt\b/i
const DELIVERY_CHALLAN_RE = /\bdelivery\s+challan\b/i
const RECEIPT_RE = /\breceipt\b|\bpayment\s+received\b|\bamount\s+received\b/i

// Structural note signals — the SAME historical semantics as §P3-16 (anywhere
// in the FULL text, phrase-required), because a printed "CREDIT NOTE" title is
// the issuer's own description of the document.
const NOTE_CREDIT_FIRST = /\bcredit\s*\/\s*debit\s+note\b/i
const NOTE_DEBIT_FIRST = /\bdebit\s*\/\s*credit\s+note\b/i
const NOTE_CREDIT = /\bcredit\s*[/ ]?\s*note\b/i
const NOTE_DEBIT = /\bdebit\s*[/ ]?\s*note\b/i

/** Original-invoice reference printed on a note (§2.3: preserved separately, never folded into the type). */
const ORIGINAL_REF_RE = /\b(?:against|reference|ref\.?|related\s+to|original)\s*(?:invoice)?\s*(?:no\.?|number|#)\s*[:\s]\s*([A-Za-z0-9][A-Za-z0-9/_-]{2,39})/i

export interface HeadingDecision {
  docType: DocTypeFull
  confidence: ClassificationConfidence
  evidence: string[]
  /** True when two different strong headings compete — a machine must not pick. */
  conflicting: boolean
  /** The competing headings, for the review reason. */
  conflictWith?: string
}

/**
 * Pure deterministic document-type decision from the document's own words.
 * `structuralNoteType` is the historical full-text credit/debit-note signal
 * (the parser's detectDocumentType); `headingText` should be `headingRegion()`
 * of the raw text. Never returns a guess: competing headings or a total absence
 * of evidence yields 'unknown' (+review) — except that a genuine note IS strong
 * evidence, so notes are decided, not deferred.
 */
export function decideDocType(structuralNoteType: string | null | undefined, headingText: string): HeadingDecision {
  const t = (headingText ?? '').replace(/\r/g, '')
  const evidence: string[] = []
  // 1) structural notes win over everything (a note mentioning "invoice" is still a note)
  if (structuralNoteType === 'credit_note' || structuralNoteType === 'debit_note') {
    evidence.push(`heading: ${structuralNoteType === 'credit_note' ? 'CREDIT NOTE' : 'DEBIT NOTE'} (structural §P3-16 signal)`)
    return { docType: structuralNoteType, confidence: 'high', evidence, conflicting: false }
  }
  // A NOTE phrase inside the heading region itself is equally structural.
  const combinedCredit = NOTE_CREDIT_FIRST.test(t)
  const combinedDebit = NOTE_DEBIT_FIRST.test(t)
  const credit = combinedCredit || NOTE_CREDIT.test(t)
  const debit = combinedDebit || NOTE_DEBIT.test(t)
  if (credit && debit) {
    // Both note words printed (a combined "CREDIT/DEBIT NOTE" title or two titles):
    // the historical first-token rule decides WHICH note, and it stays review-forced
    // anyway, so this is not a silent financial choice.
    const posC = combinedCredit ? t.search(NOTE_CREDIT_FIRST) : t.search(NOTE_CREDIT)
    const posD = combinedDebit ? t.search(NOTE_DEBIT_FIRST) : t.search(NOTE_DEBIT)
    const pick: DocTypeFull = posC <= posD ? 'credit_note' : 'debit_note'
    evidence.push(`heading: combined credit/debit note title (first token at ${posC <= posD ? posC : posD})`)
    return { docType: pick, confidence: 'high', evidence, conflicting: false }
  }
  if (credit) { evidence.push('heading: CREDIT NOTE'); return { docType: 'credit_note', confidence: 'high', evidence, conflicting: false } }
  if (debit) { evidence.push('heading: DEBIT NOTE'); return { docType: 'debit_note', confidence: 'high', evidence, conflicting: false } }

  // 2) ordinary heading-region scan by SPECIFICITY PRECEDENCE, not first-word
  //    position. An invoice-family title is strong purchase-register evidence and
  //    is never overridden by a generic "receipt"/"voucher" line in the same head;
  //    conversely a page whose ONLY title is a standalone non-invoice document
  //    (payment voucher / delivery challan / receipt) is not invoice-shaped and the
  //    category step sends it to Review. Never a single-keyword guess: the
  //    non-invoice titles require their full phrase.
  const billOfSupply = BILL_OF_SUPPLY_RE.test(t)
  const proforma = PROFORMA_RE.test(t)
  const invoiceFamily = INVOICE_FAMILY_RE.test(t)
  const paymentVoucher = PAYMENT_VOUCHER_RE.test(t)
  const deliveryChallan = DELIVERY_CHALLAN_RE.test(t)
  const receipt = RECEIPT_RE.test(t)

  // The invoice family and its specific members (bill of supply, proforma) are
  // decided from their own titles; a stray payment/receipt word is ignored here.
  if (billOfSupply) { evidence.push('heading: BILL OF SUPPLY'); return { docType: 'bill_of_supply', confidence: 'high', evidence, conflicting: false } }
  if (proforma) { evidence.push('heading: PROFORMA INVOICE'); return { docType: 'proforma_invoice', confidence: 'high', evidence, conflicting: false } }
  if (invoiceFamily) { evidence.push('heading: INVOICE (tax / commercial)'); return { docType: 'invoice', confidence: 'high', evidence, conflicting: false } }

  // No invoice-family title. Look for a STANDALONE non-invoice document title; if
  // two different ones compete the machine must not pick — Review.
  const standalone: Array<readonly [boolean, DocTypeFull, string]> = [
    [paymentVoucher, 'payment_voucher', 'PAYMENT VOUCHER'],
    [deliveryChallan, 'delivery_challan', 'DELIVERY CHALLAN'],
    [receipt, 'receipt', 'RECEIPT'],
  ]
  const matched = standalone.filter(([hit]) => hit)
  if (matched.length > 1) {
    return {
      docType: 'unknown', confidence: 'low',
      evidence: [...evidence, `heading conflict: ${matched.map(([, , label]) => label).join(' / ')}`],
      conflicting: true, conflictWith: matched.map(([, type]) => type).join('+'),
    }
  }
  if (matched.length === 1) {
    const [, type, label] = matched[0]
    evidence.push(`heading: ${label}`)
    return { docType: type, confidence: 'high', evidence, conflicting: false }
  }
  // 3) no document-title evidence at all. Never default to 'invoice' silently:
  //    'unknown' is the honest answer for an unheadered page (the category step
  //    keeps the historical purchase-register default, so recall is preserved).
  return { docType: 'unknown', confidence: 'low', evidence: [...evidence, 'no document heading found'], conflicting: false }
}

/** Extract a note's original-invoice reference (display value preserved verbatim, §2.3). */
export function extractOriginalInvoiceRef(text: string): string | null {
  const m = ORIGINAL_REF_RE.exec(text ?? '')
  return m && m[1] ? m[1].trim() : null
}

// ---------------------------------------------------------------------------
// Accounting category — explicit evidence only, everything else is Review.
// ---------------------------------------------------------------------------

const FIXED_ASSET_RE = /\b(fixed\s+asset|capital\s+goods|machin(e|er)y|equipment|computer\s+system|plant\s+and\s+machinery)\b[\s\S]{0,120}?\b(model(\s*no\.?)?|serial(\s*no\.?)?|installation)\b/i
const EXPENSE_RE = /\b(reimbursement|subscription\s+(charges|fees)|rent\s+(invoice|bill)|professional\s+fees|legal\s+fees|maintenance\s+charges)\b/i
const SERVICE_RE = /\b(service\s+(invoice|bill|charges)|consulting\s+fees|manpower\s+services|amc\s+(charges|fees))\b/i

export interface CategoryDecision {
  category: AccountingCategory
  confidence: ClassificationConfidence
  evidence: string[]
  needsReview: boolean
  reason?: string
}

/**
 * Pure deterministic category decision. The historical product scope is a
 * PURCHASE register: an invoice-shaped document with no contrary evidence is
 * 'purchase' (that is the user's confirmed intent, not a guess). Any explicit
 * evidence for a different treatment that is not unambiguous forces Review —
 * §2.2: "If the intended ledger treatment cannot be determined from available
 * evidence, ask the user." Non-invoice documents are 'unknown' until a human
 * (or a later AI pass) says otherwise.
 */
export function decideAccountingCategory(docType: DocTypeFull, fullText: string): CategoryDecision {
  const t = fullText ?? ''
  if (docType === 'unknown') {
    // NO positive heading evidence is not a contrary signal: the historical
    // behaviour (a default 'purchase' register row) is KEPT, and the unknown
    // TYPE itself is recorded truthfully + advisory. Only a POSITIVE conflict
    // (decideDocType conflicting=true) blocks. A human can still re-categorise.
    return {
      category: 'purchase', confidence: 'medium',
      evidence: ['document type undetermined; purchase-register default retained (additive)'],
      needsReview: false,
    }
  }
  if (!INVOICE_SHAPED.has(docType)) {
    return {
      category: 'unknown', confidence: 'low',
      evidence: [`${docType} is not an invoice-shaped document; category awaits a human`],
      needsReview: true, reason: REVIEW_ONLY_TYPES[docType] ?? 'category-could-not-be-determined',
    }
  }
  const fixed = FIXED_ASSET_RE.test(t)
  const expense = EXPENSE_RE.test(t)
  const service = SERVICE_RE.test(t)
  const hits = [fixed && 'fixed_asset', expense && 'expense', service && 'service'].filter(Boolean) as AccountingCategory[]
  if (hits.length > 1) {
    return {
      category: 'other', confidence: 'low',
      evidence: hits.map((h) => `explicit ${h} wording present`),
      needsReview: true, reason: 'category-evidence-conflict',
    }
  }
  if (hits.length === 1) {
    return {
      category: hits[0], confidence: 'medium',
      evidence: [`explicit ${hits[0]} wording in the document body`],
      needsReview: false,
    }
  }
  if (docType === 'bill_of_supply') {
    return { category: 'purchase', confidence: 'high', evidence: ['bill of supply is a supply of goods to be recorded as a purchase'], needsReview: false }
  }
  // A plain (credit/debit) note or tax invoice with no contrary evidence: this
  // product records PURCHASES; that is the user's stated intent for every such
  // document, so it is not a guess. A human can still re-categorise it.
  return { category: 'purchase', confidence: 'high', evidence: ['purchase register default for an invoice-shaped GST document'], needsReview: false }
}

// ---------------------------------------------------------------------------
// ITC eligibility (§3.3 third dimension) — descriptive, never auto-'eligible'.
// ---------------------------------------------------------------------------

export interface ItcDecision {
  eligibility: ItcEligibility
  reason: string
}

/**
 * Pure, conservative ITC-eligibility decision. The machine NEVER returns 'eligible'
 * — claiming input-tax credit is a legal §17(5) determination we must not fabricate.
 * A document categorically NOT a tax invoice (a receipt, payment voucher, delivery
 * challan or proforma) is 'ineligible' (it can never support ITC); every invoice-shaped
 * or undetermined document is 'needs_review' until a human decides. Like the accounting
 * category this rides the encrypted `_classification` sibling only; it never filters a
 * record out of its register (§5).
 */
export function decideItcEligibility(docType: DocTypeFull): ItcDecision {
  if (docType === 'receipt' || docType === 'payment_voucher'
    || docType === 'delivery_challan' || docType === 'proforma_invoice') {
    return { eligibility: 'ineligible', reason: `${docType} is not a tax invoice and cannot support input tax credit` }
  }
  return { eligibility: 'needs_review', reason: 'input-tax-credit eligibility requires human confirmation' }
}

// ---------------------------------------------------------------------------
// Combined classification result (§2.3 metadata bundle).
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  documentType: DocTypeFull
  accountingCategory: AccountingCategory
  itcEligibility: ItcEligibility
  itcReason: string
  method: ClassificationMethod
  confidence: ClassificationConfidence
  evidence: string[]
  needsReview: boolean
  reviewReasons: string[]
  originalInvoiceRef: string | null
  version: number
}

/**
 * Pure: run the whole deterministic pipeline for one document. `structuralNoteType`
 * is the existing parser note signal; `headingText` should be `headingRegion(raw)`;
 * `fullText` feeds the category evidence + the original-invoice reference.
 */
export function classifyDocument(args: {
  structuralNoteType?: string | null
  headingText: string
  fullText: string
}): ClassificationResult {
  const heading = decideDocType(args.structuralNoteType, args.headingText)
  const category = decideAccountingCategory(heading.docType, args.fullText)
  // ITC is computed but NEVER pushed into reviewReasons: it is descriptive (§5).
  const itc = decideItcEligibility(heading.docType)
  const reviewReasons: string[] = []
  // A POSITIVE heading conflict is blocking (two competing document titles).
  // Mere absence of a heading is not — see decideAccountingCategory's fail-open
  // note; it downgrades confidence instead, preserving historical recall.
  if (heading.conflicting) reviewReasons.push('document-heading-conflict')
  if (category.needsReview && category.reason && !reviewReasons.includes(category.reason)) reviewReasons.push(category.reason)
  return {
    documentType: heading.docType,
    accountingCategory: category.category,
    itcEligibility: itc.eligibility,
    itcReason: itc.reason,
    method: 'rules',
    confidence: heading.docType === 'unknown' || category.confidence === 'low' ? 'low'
      : heading.docType === 'invoice' && category.confidence === 'high' ? 'high'
        : 'medium',
    evidence: [...heading.evidence, ...category.evidence],
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    originalInvoiceRef: extractOriginalInvoiceRef(args.fullText),
    version: CLASSIFICATION_VERSION,
  }
}

// ---------------------------------------------------------------------------
// AI output gate (§2.2 steps 5–6): strict schema, evidence-validated, never coerced.
// ---------------------------------------------------------------------------

export interface AiClassificationInput {
  documentType?: unknown
  accountingCategory?: unknown
  confidence?: unknown
  reason?: string
}

/**
 * Validate a Gemini classification reply. An out-of-enum value is REJECTED (the
 * caller falls back to the rules result + Review), never mapped or guessed. A
 * model 'high' confidence is not trusted as calibrated certainty (§2.3): the
 * result carries 'medium' at best and only replaces the rules answer when the
 * rules themselves were undecided; strong deterministic evidence always wins.
 */
export function acceptAiClassification(
  reply: AiClassificationInput,
  rules: ClassificationResult,
): { accepted: false } | { accepted: true; result: ClassificationResult } {
  if (!isDocTypeFull(reply.documentType) || !isAccountingCategory(reply.accountingCategory)) return { accepted: false }
  // A model reply is still a MACHINE: it may never auto-assign the review-only
  // categories (§3.3). Reject so the rules answer + Review stands and a human decides.
  if (MACHINE_FORBIDDEN_CATEGORIES.has(reply.accountingCategory)) return { accepted: false }
  const overridesRules = rules.documentType === 'unknown' || rules.confidence === 'low'
  if (!overridesRules) return { accepted: false }
  const reviewReasons = (reply.documentType === 'unknown' || reply.accountingCategory === 'unknown')
    ? [...new Set([...rules.reviewReasons, 'category-could-not-be-determined'])]
    : rules.reviewReasons.filter((r) => r !== 'document-type-could-not-be-determined' && r !== 'category-could-not-be-determined')
  return {
    accepted: true,
    result: {
      ...rules,
      documentType: reply.documentType,
      accountingCategory: reply.accountingCategory,
      method: 'ai',
      confidence: 'medium', // a model self-report is never promoted to calibrated 'high'
      evidence: [...rules.evidence, `ai: ${reply.documentType}/${reply.accountingCategory}${reply.reason ? ` — ${reply.reason.slice(0, 80)}` : ''}`],
      needsReview: reviewReasons.length > 0,
      reviewReasons,
    },
  }
}

// ---------------------------------------------------------------------------
// Human correction (§2.3: user-confirmed category; original OCR never overwritten).
// ---------------------------------------------------------------------------

/**
 * Apply a reviewer-confirmed classification. The stored row's ORIGINAL extracted
 * values live on in `_audit.originalExtracted` (the review path already keeps
 * that history); here we only mark provenance as 'user' and clear the review
 * flags the machine raised, because a human has now answered the question.
 */
export function applyUserClassification(
  rules: ClassificationResult,
  patch: { documentType?: unknown; accountingCategory?: unknown; itcEligibility?: unknown },
): ClassificationResult {
  const documentType = isDocTypeFull(patch.documentType) ? patch.documentType : rules.documentType
  const accountingCategory = isAccountingCategory(patch.accountingCategory) ? patch.accountingCategory : rules.accountingCategory
  // Only a HUMAN may promote ITC to 'eligible'; the machine never could. An absent or
  // invalid patch value leaves the machine's honest 'needs_review' standing.
  const itcEligibility = isItcEligibility(patch.itcEligibility) ? patch.itcEligibility : rules.itcEligibility
  const itcChanged = isItcEligibility(patch.itcEligibility) && patch.itcEligibility !== rules.itcEligibility
  const itcReason = itcChanged ? `human confirmed ITC as ${itcEligibility}` : rules.itcReason
  const machineReasons = new Set([
    'document-type-could-not-be-determined', 'category-could-not-be-determined',
    'document-heading-conflict', 'category-evidence-conflict',
    ...Object.values(REVIEW_ONLY_TYPES),
  ])
  const stillUndecided = documentType === 'unknown' || accountingCategory === 'unknown'
  return {
    ...rules,
    documentType,
    accountingCategory,
    itcEligibility,
    itcReason,
    method: 'user',
    confidence: stillUndecided ? 'low' : 'high',
    evidence: [...rules.evidence, `user confirmed ${documentType}/${accountingCategory}`],
    needsReview: stillUndecided || rules.needsReview && machineReasons.size === 0,
    reviewReasons: stillUndecided
      ? [...new Set([...rules.reviewReasons.filter((r) => !machineReasons.has(r)), 'category-could-not-be-determined'])]
      : rules.reviewReasons.filter((r) => !machineReasons.has(r)),
    originalInvoiceRef: rules.originalInvoiceRef,
  }
}
