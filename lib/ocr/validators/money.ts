export type MoneyInput = number | string | null | undefined

const MONEY_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/
// Whitespace-ish characters OCR/Gemini emit around numbers: NBSP, narrow + thin
// spaces. Collapsed to a plain space so the later `[\u00a0,\s]` strip catches them.
const ODD_SPACES = /[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g
// Leading currency token ("₹", "Rs", "Rs.", "INR") and trailing receipt fillers
// ("1,18,200/-", "1,18,200/", "1,18,200-") are formatting, not value.
const LEADING_CURRENCY = /^(?:inr|rs\.?|\u20b9)\s*/i
const TRAILING_FILLER = /[/\-=.,]+$/

/** Parse currency into integer paise, rounding half-up beyond two decimals. */
export function moneyToMinorUnits(value: MoneyInput): bigint | null {
  if (value === null || value === undefined) return null
  // Never treat NaN / Infinity as a monetary amount.
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  const raw = (typeof value === 'number' ? String(value) : value)
    .replace(ODD_SPACES, ' ')
    .trim()
    .replace(LEADING_CURRENCY, '')
    .replace(/[\u20b9,\s]/g, '')
    .replace(TRAILING_FILLER, '')
  const match = MONEY_RE.exec(raw)
  if (!match) return null

  const [, sign, whole, fraction = ''] = match
  const firstTwo = fraction.slice(0, 2).padEnd(2, '0')
  let minor = BigInt(whole) * BigInt(100) + BigInt(firstTwo || '0')
  if (fraction.length > 2 && fraction[2] >= '5') minor += BigInt(1)
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return sign === '-' ? -minor : minor
}

export function minorUnitsToNumber(value: bigint): number {
  const sign = value < BigInt(0) ? -1 : 1
  const absolute = value < BigInt(0) ? -value : value
  const whole = absolute / BigInt(100)
  const fraction = absolute % BigInt(100)
  return sign * Number(`${whole}.${fraction.toString().padStart(2, '0')}`)
}

export function minorUnitsToString(value: bigint): string {
  const sign = value < BigInt(0) ? '-' : ''
  const absolute = value < BigInt(0) ? -value : value
  return `${sign}${absolute / BigInt(100)}.${(absolute % BigInt(100)).toString().padStart(2, '0')}`
}
