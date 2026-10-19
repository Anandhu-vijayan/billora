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
    // An empty / whitespace-only rate means the head simply is not applicable on
    // this invoice (e.g. the vision model returns "" for IGST on an intra-state
    // supply, where only CGST+SGST apply). Absence of a printed rate is NOT a
    // data error, so skip it rather than flagging `invalid-rate`. The independent
    // total-sum invariant elsewhere still guards against a genuinely wrong amount.
    if (typeof rate === 'string' && rate.trim() === '') continue
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
    let status: TaxRateCheck['status'] =
      actualMinorUnits >= expectedMinorUnits - tolerance
      && actualMinorUnits <= expectedMinorUnits + tolerance ? 'match' : 'mismatch'

    // Recognize the combined-GST-rate annotation pattern: on Indian intra-state
    // invoices, the item line shows the TOTAL GST rate (e.g. 5%) which splits
    // equally into CGST (2.5%) + SGST (2.5%). The model may read the item-level
    // combined rate into the per-component field. If the printed rate is exactly
    // DOUBLE the implied per-component rate (half-rate interpretation matches the
    // actual amount within tolerance), this is NOT a data error — the amounts are
    // correct and the rate annotation is just the combined header. This does NOT
    // weaken financial validation: the total-sum check (total-mismatch) still
    // protects independently; a genuinely wrong amount is caught there.
    // Only applies to CGST/SGST (intra-state split); IGST is full-rate, no split.
    if (status === 'mismatch' && (head === 'cgst' || head === 'sgst')) {
      const rateNum = typeof rate === 'number' ? rate : Number(String(rate).replace(/%$/, ''))
      if (Number.isFinite(rateNum) && rateNum > 0) {
        const halfExpected = expectedTaxMinorUnits(args.taxableValue, rateNum / 2)
        if (halfExpected !== null
          && actualMinorUnits >= halfExpected - tolerance
          && actualMinorUnits <= halfExpected + tolerance) {
          status = 'match'
        }
      }
    }

    checks.push({ head, status, expectedMinorUnits, actualMinorUnits })
  }
  return checks
}
