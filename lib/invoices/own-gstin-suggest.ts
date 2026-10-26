// lib/invoices/own-gstin-suggest.ts — learn a client's OWN (buyer) GSTIN from
// their history and SUGGEST it for confirmation (§P0-1c). NEVER auto-applies.
//
// WHY THIS EXISTS: the primary path to know the buyer's own GSTIN is the
// onboarding capture (P0-1b). When it was skipped, the buyer's own GSTIN still
// prints on most of their purchase bills as the RECIPIENT. If the SAME recipient
// GSTIN appears on >= 3 of the client's invoices, that recurring figure is a
// strong candidate for the client's own number — but a machine must NOT silently
// rewrite a fact that drives a data-integrity guard. So we only ever surface a
// plain-English SUGGESTION and let the reviewer confirm it (with the existing
// `My GSTIN <number>` command). An unconfirmed suggestion changes nothing.
//
// Non-negotiables:
//   * Tenant isolation: every read is scoped by the caller's workspace_id + client.
//   * Never fabricate: we only tally recipient GSTINs the extractor already read
//     from a real document (persisted as an encrypted sibling key); a suggestion
//     must be a fully-valid GSTIN that dominates the client's bills, else null.
//   * Precision over recall: a clear plurality is required, and a tie at the top
//     is refused outright (no coin-flip on a value that flips supplier==buyer).
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptExtractedPayload } from '../encryption'
import { gstinFullyValid } from '../ocr/gstin'
import { tallyRecipientGstins } from './own-gstin-tally'

type Db = SupabaseClient

/** PostgREST renders bytea as a `\x`-prefixed hex string (same as review/intake). */
function byteaToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/i, ''), 'hex')
  throw new Error('BYTEA_DECODE_ERROR: unexpected encrypted_payload encoding')
}

export interface SuggestionResult {
  /** The suggested buyer GSTIN, or null when nothing qualifies. */
  suggestion: string | null
  count: number
  /** True when own_gstin is already set, so no suggestion is ever needed. */
  alreadySet: boolean
}

/**
 * Compute a NON-BINDING own-GSTIN suggestion for a client that has not set one.
 * Reads that client's recent invoices (tenant-scoped), decrypts each stored row,
 * tallies the printed recipient GSTINs, and returns a dominant valid value only
 * when it recurs on >= `minCount` invoices. It NEVER writes anything: applying it
 * requires the reviewer to confirm through the `My GSTIN <number>` command.
 */
export async function suggestOwnGstin(
  db: Db,
  args: { workspaceId: string; clientId: string; masterKeyHex: string; minCount?: number },
): Promise<SuggestionResult> {
  const { workspaceId, clientId, masterKeyHex } = args
  const minCount = Math.max(2, Math.trunc(args.minCount ?? 3))

  // Migration-safe + tenant-scoped own_gstin probe: `select('*')` so an unapplied
  // additive migration cannot raise PGRST204 here (the same resilience used in the
  // extract/review paths). Absent/null is treated as "not set".
  const { data: clientRow, error: clientErr } = await db
    .from('clients').select('*')
    .eq('workspace_id', workspaceId).eq('id', clientId).maybeSingle()
  if (clientErr) return { suggestion: null, count: 0, alreadySet: false }
  const own = (clientRow as { own_gstin?: string | null } | null)?.own_gstin
  if (own && gstinFullyValid(own)) return { suggestion: null, count: 0, alreadySet: true }

  const { data: invoices, error: invErr } = await db
    .from('invoices').select('id')
    .eq('workspace_id', workspaceId).eq('client_id', clientId)
    .order('received_at', { ascending: false }).limit(50)
  if (invErr) return { suggestion: null, count: 0, alreadySet: false }
  const ids = (invoices ?? []).map((r) => (r as { id: string }).id)
  if (ids.length < minCount) return { suggestion: null, count: 0, alreadySet: false }

  const { data: records, error: recErr } = await db
    .from('extracted_records').select('invoice_id,encrypted_payload')
    .eq('workspace_id', workspaceId).in('invoice_id', ids)
  if (recErr) return { suggestion: null, count: 0, alreadySet: false }

  const perInvoice: Array<string | null> = []
  for (const rec of (records ?? []) as Array<{ invoice_id: string; encrypted_payload: unknown }>) {
    let recipient: string | null = null
    try {
      const parsed = JSON.parse(decryptExtractedPayload(byteaToBuffer(rec.encrypted_payload), masterKeyHex)) as
        { _recipientGstin?: unknown }
      recipient = typeof parsed._recipientGstin === 'string' ? parsed._recipientGstin : null
    } catch {
      continue // undecryptable / pre-P0-1c row with no stored recipient: skip
    }
    perInvoice.push(recipient)
  }

  const tally = tallyRecipientGstins(perInvoice, minCount)
  return { suggestion: tally.value, count: tally.count, alreadySet: false }
}
