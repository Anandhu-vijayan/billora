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

  if (input.taxRates && input.taxableValue !== null && input.taxableValue !== undefined) {
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
        reasons.push(`tax-rate-mismatch:${check.head}`)
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
