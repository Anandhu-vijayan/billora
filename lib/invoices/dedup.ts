// lib/invoices/dedup.ts — duplicate-prevention primitives (pure, no I/O, no aliases).
//
// Part 5 ships TWO independent layers and this file holds the shared, testable
// half of the SECOND layer (invoice-identity dedup). Layer 1 (exact-file SHA-256
// dedup at intake) reuses the hash already stored on `invoices.file_sha256` and
// lives in the intake module, so nothing here is needed for it.
//
// Identity dedup must be a BLIND INDEX: the invoice number, supplier and date
// are financial/PII facts and must never be stored or logged in plaintext, so
// we persist only an HMAC-SHA256 of a canonicalised identity tuple under the
// file master key. A lookup finds a PRIOR live invoice sharing the same blind
// index — a possible duplicate a HUMAN must confirm. It NEVER auto-drops or
// auto-approves a record (the additive-review-gate invariant).
//
// Why keyed on the tuple (not amounts): the same bill re-sent is the danger we
// guard; a reissued bill with a corrected amount is NOT a duplicate and must
// never be collapsed. We therefore key ONLY on identity facts that are stable
// across a faithful resend and refuse to key at all when any is absent/partial
// (never guess). A GSTIN and a vendor name are kept in SEPARATE discriminator
// namespaces so a supplier identified by GSTIN can never falsely collide with a
// different supplier identified only by name.
//
// alias-free + imports only `node:crypto`, so the in-process test harness runs
// the REAL function rather than a copy.
import { createHmac } from 'node:crypto'

/**
 * Domain-separation prefix so an identity blind index can never be mistaken for
 * (or reused as) any other HMAC derived from the same master key. Bumping the
 * trailing version invalidates every existing index — only do so alongside a
 * deliberate re-derivation of stored `identity_key` values.
 */
export const IDENTITY_KEY_DOMAIN = 'billora:identity:v1:'

/** Review reason code folded when a prior live invoice shares this identity. */
export const DUPLICATE_IDENTITY_REASON = 'possible-duplicate'
/** Intake ack reason for an exact-file (SHA-256) duplicate — Layer 1. */
export const DUPLICATE_FILE_REASON = 'duplicate-file'

/** The four identity facts a duplicate key may be built from. */
export interface IdentityInput {
  invoiceNumber?: string | null
  supplierGstin?: string | null
  vendorName?: string | null
  invoiceDate?: string | null
}

/**
 * Canonicalise an invoice number for the blind index: uppercase, then keep only
 * ASCII letters and digits so punctuation/spacing differences (`INV-0042`,
 * `inv 0042`, `INV/0042`) collapse to one token `INV0042`. Returns '' when there
 * is nothing to key on.
 */
export function normalizeInvoiceNumber(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Canonicalise a vendor name for the name-namespace key: uppercase and collapse
 * every run of non-alphanumerics to a single space, then trim. This is only ever
 * used behind the `n:` discriminator, so it never mixes with a GSTIN key.
 */
export function normalizeVendorName(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

/** Canonicalise a GSTIN: uppercase alphanumerics only (a GSTIN is 15 of them). */
export function normalizeGstin(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Strict canonical date. Unlike the OCR parser this does NOT expand 2-digit
 * years or accept textual months: the identity index is built from the ALREADY
 * canonicalised `evaluation.row.invoice_date`, so anything that is not exactly
 * `YYYY-MM-DD` is treated as UNRESOLVED and we refuse to key (never guess a
 * month for a partial date). Returns '' when absent/partial.
 */
export function normalizeIdentityDate(raw: string | null | undefined): string {
  const s = (raw ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

/**
 * Build the supplier discriminator, keeping the GSTIN and name namespaces apart:
 *   * a valid normalised GSTIN -> `g:<gstin>` (the strongest identity);
 *   * else a usable vendor name -> `n:<normalized name>`;
 *   * else '' (no usable supplier identity — the caller must refuse to key).
 */
export function buildSupplierDiscriminator(input: IdentityInput): string {
  const gstin = normalizeGstin(input.supplierGstin)
  if (gstin !== '') return `g:${gstin}`
  const vendor = normalizeVendorName(input.vendorName)
  if (vendor !== '') return `n:${vendor}`
  return ''
}

/**
 * Compute the invoice-identity blind index, or null when the identity is not
 * fully resolved (we NEVER key on an absent invoice number, supplier, or date —
 * a partial key would both miss true duplicates and create false ones).
 *
 * The canonical material is joined with a control character separator so no
 * field's contents can be reinterpreted as a boundary by an adversarial/odd
 * value, then HMAC-SHA256'd under the caller-supplied master key hex.
 *
 * @returns lowercase hex digest (store as bytea via `\x` + this value), or null.
 */
export function computeIdentityKey(
  input: IdentityInput,
  keyHex: string,
): string | null {
  if (!keyHex) return null
  const invoiceNumber = normalizeInvoiceNumber(input.invoiceNumber)
  const supplier = buildSupplierDiscriminator(input)
  const date = normalizeIdentityDate(input.invoiceDate)
  // Every element is mandatory: an absent/partial identity is never keyed.
  if (invoiceNumber === '' || supplier === '' || date === '') return null
  const material = `${IDENTITY_KEY_DOMAIN}${invoiceNumber}\u0000${supplier}\u0000${date}`
  return createHmac('sha256', keyHex).update(material).digest('hex')
}

/** Encode a hex blind index for a `bytea` column (Postgres `\x` hex literal). */
export function identityKeyToBytea(hexKey: string | null): string | null {
  return hexKey ? `\\x${hexKey}` : null
}

/** Decode a stored `bytea` (`\x`-hex or raw hex) back to lowercase hex, or null. */
export function byteaToHexKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const stripped = value.replace(/^\\x/i, '').trim()
  return /^[0-9a-fA-F]+$/.test(stripped) && stripped.length > 0 ? stripped.toLowerCase() : null
}
