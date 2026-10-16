import { moneyToMinorUnits } from './money'

export type TaxHead = 'cgst' | 'sgst' | 'igst'
export type TaxRateInput = number | string

export interface TaxRateCheck {
  head: TaxHead
  status: 'match' | 'mismatch' | 'missing-amount' | 'invalid-rate'
  expectedMinorUnits: bigint | null
  actualMinorUnits: bigint | null
}

function rateToBasisPoints(rawRate: TaxRateInput): bigint | null {
  const text = typeof rawRate === 'number' ? String(rawRate) : rawRate.trim().replace(/%$/, '')
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) return null
  const rate = Number(text)
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null
  const scaled = rate * 100
  if (!Number.isInteger(scaled)) return null
  return BigInt(scaled)
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / BigInt(2)) / denominator
}

export function expectedTaxMinorUnits(taxable: number | string, ratePercent: TaxRateInput): bigint | null {
  const taxableMinor = moneyToMinorUnits(taxable)
  const basisPoints = rateToBasisPoints(ratePercent)
  if (taxableMinor === null || basisPoints === null || taxableMinor < BigInt(0)) return null
  return roundedDivide(taxableMinor * basisPoints, BigInt(10_000))
}

/** Compare printed tax rates with extracted amounts; never computes replacement values. */
export function checkPrintedTaxRates(args: {
  taxableValue: number | string
  taxRates: Partial<Record<TaxHead, TaxRateInput>>
  taxAmounts: Partial<Record<TaxHead, number | string | null | undefined>>
  toleranceMinorUnits?: bigint
}): TaxRateCheck[] {
  const tolerance = args.toleranceMinorUnits ?? BigInt(101)
  const checks: TaxRateCheck[] = []

  for (const head of ['cgst', 'sgst', 'igst'] as const) {
    const rate = args.taxRates[head]
    if (rate === undefined) continue
    const expectedMinorUnits = expectedTaxMinorUnits(args.taxableValue, rate)
    if (expectedMinorUnits === null) {
      checks.push({ head, status: 'invalid-rate', expectedMinorUnits: null, actualMinorUnits: null })
      continue
    }
    const actualValue = args.taxAmounts[head]
    const actualMinorUnits = moneyToMinorUnits(actualValue)
    if (actualMinorUnits === null) {
      checks.push({
        head,
        status: expectedMinorUnits === BigInt(0) ? 'match' : 'missing-amount',
        expectedMinorUnits,
        actualMinorUnits: null,
      })
      continue
    }
    checks.push({
      head,
      status: actualMinorUnits >= expectedMinorUnits - tolerance
        && actualMinorUnits <= expectedMinorUnits + tolerance ? 'match' : 'mismatch',
      expectedMinorUnits,
      actualMinorUnits,
    })
  }
  return checks
}
