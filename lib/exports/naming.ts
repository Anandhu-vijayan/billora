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

/** The human-facing filename for one month's register. §separate-files-per-category: a non-purchase category register gets its category decorated into the name; the purchase file keeps the exact historical `Billora_YYYY-MM.xlsx` name. */
export function workbookFileName(periodStart: string | null | undefined, categoryToken?: string | null): string {
  const tok = monthToken(periodStart)
  if (!tok) return GENERIC_REGISTER_FILENAME
  return categoryToken ? `Billora_${tok}_${categoryToken}.xlsx` : `Billora_${tok}.xlsx`
}

/** A short label ("Oct 2026") for the bulk summary, or null when undated. */
export function monthLabel(periodStart: string | null | undefined): string | null {
  const tok = monthToken(periodStart)
  if (!tok) return null
  const month = Number(tok.slice(5, 7))
  return `${SHORT_MONTHS[month - 1]} ${tok.slice(0, 4)}`
}

/**
 * §separate-files-per-category: a filename-safe token for an accounting category
 * derived from its register sheet label (the SAME label the generator writes), so
 * the download name, the object key and the sheet name can never disagree.
 * 'Purchase Register' -> null (the purchase file keeps the historical name),
 * 'Expense Register' -> 'expense', 'Fixed Asset Register' -> 'fixed-asset',
 * 'Capital Purchase Register' -> 'capital-purchase'.
 */
export function categoryFileToken(registerSheetName: string): string | null {
  if (registerSheetName === 'Purchase Register') return null
  const words = registerSheetName.replace(/\s+Register$/, '').trim()
  if (!words) return null
  return words.toLowerCase().replace(/\s+/g, '-')
}

/**
 * §separate-files-per-category: the filename token for an accounting-category KEY
 * (the normalized value stored on generated_workbooks.accounting_category). Mirrors
 * categoryFileToken(sheetName) but without needing the generator, so the display
 * layer can name each per-category file. purchase/null -> null (bare month name).
 */
export function categoryTokenFromKey(categoryKey: string | null | undefined): string | null {
  if (!categoryKey || categoryKey === 'purchase') return null
  return categoryKey.replace(/_/g, '-')
}

/** A month label decorated with its category for the chat ("Oct 2026 (Expense)"). */
export function monthLabelFor(periodStart: string | null | undefined, categoryToken?: string | null): string | null {
  const base = monthLabel(periodStart)
  if (!base || !categoryToken) return base
  const pretty = categoryToken.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return `${base} (${pretty})`
}
