export type MoneyInput = number | string | null | undefined

const MONEY_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/

/** Parse currency into integer paise, rounding half-up beyond two decimals. */
export function moneyToMinorUnits(value: MoneyInput): bigint | null {
  if (value === null || value === undefined) return null
  const raw = (typeof value === 'number' ? String(value) : value)
    .trim()
    .replace(/[₹,\s]/g, '')
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
