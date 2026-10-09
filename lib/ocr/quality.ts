// lib/ocr/quality.ts — Checks for structure anomalies and data corruption.
import { logger } from '@/lib/logger'

export interface QualityVerdict {
  ok: boolean
  reasons: string[]
  score: number
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export function isBlurryHeuristic(imageBuffer: Buffer): { blurry: boolean; score: number } {
  const sizeKB = imageBuffer.length / 1024
  if (sizeKB < 30) return { blurry: true, score: sizeKB }
  return { blurry: false, score: sizeKB }
}

export function isCutOff(text: string): boolean {
  if (!text) return true
  const hasNumber = /\d/.test(text)
  return !hasNumber || text.trim().length < 20
}

export function isValidGstin(value: string): boolean {
  return GSTIN_RE.test(value.trim().toUpperCase())
}

/** Row-level anomaly scan for extracted ledger rows (NaN, negatives, totals mismatch). */
export function checkLedgerRowAnomalies(row: {
  taxable_value: number
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  total_amount: number
}): QualityVerdict {
  const reasons: string[] = []
  const nums = [row.taxable_value, row.cgst_amount, row.sgst_amount, row.igst_amount, row.total_amount]
  if (nums.some((n) => !Number.isFinite(n))) reasons.push('non-finite amount detected')
  if (nums.some((n) => n < 0)) reasons.push('negative amount detected')
  const taxSum = row.taxable_value + row.cgst_amount + row.sgst_amount + row.igst_amount
  if (Math.abs(taxSum - row.total_amount) > 1.01) {
    reasons.push(`total mismatch: taxable+tax=${taxSum.toFixed(2)} vs total=${row.total_amount.toFixed(2)}`)
  }
  if (reasons.length > 0) logger.warn('ledger row anomaly', { reasons })
  return { ok: reasons.length === 0, reasons, score: reasons.length === 0 ? 1 : 0 }
}
