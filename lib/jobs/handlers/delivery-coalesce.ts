// lib/jobs/handlers/delivery-coalesce.ts — the pure half of the register-spam fix.
//
// A cumulative purchase register is REBUILT after every single approval, so one
// upload burst leaves several versions of the SAME month owed to the same owner.
// Shipping each of them is what buried an owner in 4-5 copies of their own October
// file (2 invoices, then 3, then the real 5). This module collapses a claimed page
// to ONE file per (batch, accounting category) — the highest version — and reports
// everything it dropped so the caller can park it instead of re-claiming it later.
//
// It is deliberately dependency-free (no logger, no Supabase, no env) so the rule
// itself is unit-testable in process against the REAL code, not a copy. All the
// I/O and state-machine decisions stay in the delivery consumer.
export type DeliveryScopeFields = {
  /** the register's own batch; null when it cannot be determined. */
  batchId: string | null
  /** accounting category; null is the legacy/historical purchase register. */
  category: string | null
  /** monotonic publish version within the batch; null when unknown. */
  version: number | null
}

/**
 * Keep only the newest owed workbook per (batch, category).
 *
 * Rows whose scope cannot be established (no batch id, or a field read that
 * failed) are ALWAYS kept — dropping a file we are not certain about is worse
 * than sending one extra copy, and the send boundary re-checks supersession.
 * Within one scope the highest `version` wins; an unknown version counts as the
 * oldest possible (0) so a real version always outranks it. Output order is
 * deterministic: scoped winners first, then the unscopable rows.
 */
export function newestPerScope<T extends { workbook_id: string }>(
  claimed: readonly T[],
  fields: ReadonlyMap<string, DeliveryScopeFields>,
): { keep: T[]; superseded: T[] } {
  const winnerByScope = new Map<string, T>()
  const winnerVersionByScope = new Map<string, number>()
  const keep: T[] = []
  const superseded: T[] = []
  for (const row of claimed) {
    const f = fields.get(row.workbook_id)
    const scope = f?.batchId ? `${f.batchId}|${f.category ?? ''}` : null
    if (!scope) { keep.push(row); continue }
    const version = f?.version ?? 0
    const held = winnerVersionByScope.get(scope)
    if (held === undefined || version > held) {
      if (held !== undefined) superseded.push(winnerByScope.get(scope) as T)
      winnerByScope.set(scope, row)
      winnerVersionByScope.set(scope, version)
    } else superseded.push(row)
  }
  return { keep: [...winnerByScope.values()].concat(keep), superseded }
}

/**
 * A bounded, PII-free `last_error` note: what happened and why, never who. The
 * outbox column is a short text, so a long provider payload is truncated instead
 * of overflowing into a rejected write.
 */
export function errorNote(prefix: string, detail?: string | null): string {
  const d = (detail ?? '').trim()
  return `${prefix}${d ? `: ${d}` : ''}`.slice(0, 120)
}
