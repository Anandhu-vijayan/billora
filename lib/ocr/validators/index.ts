import { amountWordsMatchNumeric } from './amount-words'
import type { TaxHead, TaxRateInput } from './tax-rates'
import { checkPrintedTaxRates } from './tax-rates'

export interface InvoiceValidationInput {
  taxableValue: number | string | null | undefined
  cgstAmount: number | string | null | undefined
  sgstAmount: number | string | null | undefined
  igstAmount: number | string | null | undefined
  totalAmount: number | string | null | undefined
  taxRates?: Partial<Record<TaxHead, TaxRateInput>> | null
  totalAmountInWords?: string | null
  toleranceMinorUnits?: bigint
  /**
   * When true the printed total already reconciles against the summed components
   * (taxable + tax + adjustments = total). A rate-vs-amount disagreement on such a
   * bill is downgraded from a HARD `tax-rate-mismatch` to a SOFT `tax-rate-advisory`
   * — the money ties out, so it is a "glance at the rate text" hint a human may
   * one-tap approve, not an integrity break. Absent/undefined is treated as NOT
   * reconciling (the conservative hard path).
   */
  totalReconciles?: boolean
  /**
   * When true the bill carries more than one GST rate across its line items. A
   * single flat per-head rate can never reproduce a summed multi-slab tax amount,
   * so the whole printed-rate cross-check is skipped; those bills are guarded by
   * the mixed-slice breakdown validator and the invoice total invariant instead.
   */
  multiRate?: boolean
}

export interface InvoiceCrossCheck {
  reasons: string[]
  measuredConfidencePenalty: number
}

/** Cross-check optional invoice evidence without changing any extracted value. */
export function validateInvoiceCrossChecks(input: InvoiceValidationInput): InvoiceCrossCheck {
  const reasons: string[] = []
  let measuredConfidencePenalty = 0
  const hasTotalAmount = input.totalAmount !== undefined
    && input.totalAmount !== null
    && input.totalAmount !== ''

  // A genuine multi-rate bill is skipped here: `checkPrintedTaxRates` compares one
  // flat taxable x rate against the SUMMED tax head, which cannot tie across mixed
  // slabs, so running it would false-flag every legitimate multi-rate invoice.
  if (!input.multiRate && input.taxRates && input.taxableValue !== null && input.taxableValue !== undefined) {
    const checks = checkPrintedTaxRates({
      taxableValue: input.taxableValue,
      taxRates: input.taxRates,
      taxAmounts: {
        cgst: input.cgstAmount,
        sgst: input.sgstAmount,
        igst: input.igstAmount,
      },
      toleranceMinorUnits: input.toleranceMinorUnits,
    })
    for (const check of checks) {
      if (check.status === 'mismatch') {
        // Total ties out -> SOFT advisory (human one-tap approvable); total does
        // NOT tie -> keep the HARD integrity flag. The amount itself is never touched.
        reasons.push(input.totalReconciles
          ? `tax-rate-advisory:${check.head}`
          : `tax-rate-mismatch:${check.head}`)
        measuredConfidencePenalty = Math.max(measuredConfidencePenalty, 0.2)
      } else if (check.status === 'missing-amount') {
        reasons.push(`tax-rate-amount-missing:${check.head}`)
        measuredConfidencePenalty = Math.max(measuredConfidencePenalty, 0.2)
      } else if (check.status === 'invalid-rate') {
        reasons.push(`tax-rate-invalid:${check.head}`)
        measuredConfidencePenalty = Math.max(measuredConfidencePenalty, 0.2)
      }
    }

    if (input.taxRates.cgst !== undefined && input.taxRates.sgst !== undefined
      && Number(String(input.taxRates.cgst).replace(/%$/, '')) !== Number(String(input.taxRates.sgst).replace(/%$/, ''))) {
      reasons.push('tax-rate-cgst-sgst-unequal')
      measuredConfidencePenalty = Math.max(measuredConfidencePenalty, 0.2)
    }
    if (input.taxRates.igst !== undefined
      && (input.taxRates.cgst !== undefined || input.taxRates.sgst !== undefined)
      && Number(String(input.taxRates.igst).replace(/%$/, '')) > 0
      && (Number(String(input.taxRates.cgst ?? 0).replace(/%$/, '')) > 0
        || Number(String(input.taxRates.sgst ?? 0).replace(/%$/, '')) > 0)) {
      reasons.push('tax-rate-igst-with-cgst-sgst')
      measuredConfidencePenalty = Math.max(measuredConfidencePenalty, 0.2)
    }
  }

  if (input.totalAmountInWords?.trim() && hasTotalAmount) {
    const wordsMatch = amountWordsMatchNumeric(input.totalAmountInWords, input.totalAmount as number | string)
    if (wordsMatch === false) {
      reasons.push('amount-words-total-mismatch')
      measuredConfidencePenalty = Math.max(measuredConfidencePenalty, 0.2)
    }
  }

  return { reasons, measuredConfidencePenalty }
}

export { amountWordsMatchNumeric, parseIndianAmountWords } from './amount-words'
export { checkPrintedTaxRates, expectedTaxMinorUnits } from './tax-rates'
export { minorUnitsToNumber, minorUnitsToString, moneyToMinorUnits } from './money'
