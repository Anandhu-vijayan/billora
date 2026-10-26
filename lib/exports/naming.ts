// lib/exports/naming.ts — deterministic, per-month register filenames (§P1-5).
//
// A batch is one (client, calendar month), so every generated workbook covers a
// single accounting period. Accountants file these by month, so the download and
// the in-chat document must be named `Billora_YYYY-MM.xlsx` — derived ONLY from
// the batch's real period_start (never from an upload date or a guess). When no
// period is available we fall back to a stable generic name rather than inventing
// a month, so a mis-dated batch can never masquerade as a specific period.
//
// Pure + alias-free so the exact filename a client receives is unit-testable in
// process (the whole point of this module is a deterministic, human-facing string).

/** Fallback when a workbook carries no resolvable accounting month. */
export const GENERIC_REGISTER_FILENAME = 'Billora-register.xlsx'

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/**
 * Normalise any date-ish period_start ("2026-10-01", a full timestamptz, etc.)
 * to its `YYYY-MM` accounting token, or null when it is absent/malformed/out of
 * range. Never coerces a bad value into a plausible month.
 */
export function monthToken(periodStart: string | null | undefined): string | null {
  if (typeof periodStart !== 'string') return null
  const m = /^(\d{4})-(\d{2})/.exec(periodStart.trim())
  if (!m) return null
  const month = Number(m[2])
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  return `${m[1]}-${String(month).padStart(2, '0')}`
}

/** The human-facing filename for one month's register. */
export function workbookFileName(periodStart: string | null | undefined): string {
  const tok = monthToken(periodStart)
  return tok ? `Billora_${tok}.xlsx` : GENERIC_REGISTER_FILENAME
}

/** A short label ("Oct 2026") for the bulk summary, or null when undated. */
export function monthLabel(periodStart: string | null | undefined): string | null {
  const tok = monthToken(periodStart)
  if (!tok) return null
  const month = Number(tok.slice(5, 7))
  return `${SHORT_MONTHS[month - 1]} ${tok.slice(0, 4)}`
}
