import { createHash } from 'node:crypto'

/**
 * §content-fingerprint — the pure half of "did this register actually change?".
 *
 * Kept dependency-free (node:crypto only, no `@/` imports) so the rule the publisher
 * uses is the SAME code the tests execute, rather than a copy of it. A rebuild that
 * produces an identical fingerprint for a category is NOT new information: re-publishing
 * it minted a fresh workbook version, a fresh owed delivery row and a fresh copy of the
 * identical file in the owner's chat — the field symptom of the same one-row register
 * arriving several times for a month whose content had not moved.
 *
 * The fingerprint is one-way and id/amount-free: it folds the sorted source keys of a
 * category bucket (each key being `<invoice id>\u0000<that record's updated_at>`), so
 * an approval, rejection, correction or re-date always moves it, while a repeated
 * "Done" over an unchanged month never can.
 */

/** SHA-256 over a bucket's sorted source keys. Order-insensitive, content-free. */
export function fingerprintSourceKeys(keys: readonly string[]): string {
  return createHash('sha256').update([...keys].sort().join('\n')).digest('hex')
}

/**
 * The hex digest a stored `bytea` fingerprint column decodes to, or `''` when it is
 * absent or in a shape we cannot prove equality from. Returning `''` means "unknown",
 * and every caller must treat unknown as CHANGED — this gate is only ever allowed to
 * skip a duplicate, never to suppress a real change.
 */
export function parseStoredFingerprint(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  const hex = raw.startsWith('\\x') ? raw.slice(2) : raw
  return /^[0-9a-fA-F]{64}$/.test(hex) ? hex.toLowerCase() : ''
}
