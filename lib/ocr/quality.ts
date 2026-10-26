// lib/ocr/quality.ts — image-quality gating plus structure/data anomaly checks.
//
// Two responsibilities, both about refusing to trust a bad read:
//   * §P3-13 image-quality gate: a REAL sharp-derived focus (Laplacian variance)
//     and resolution check on a raster source. Replaces the old file-size "blur
//     heuristic" and the crude text `isCutOff` — neither predicted a bad read and
//     neither was ever wired in.
//   * row-level anomaly scan (NaN / negatives / total mismatch) for ledger rows.
import sharp from 'sharp'
import { logger } from '@/lib/logger'
import { moneyToMinorUnits } from './validators/money'
import { reconcileInvoiceTotal } from './calc/reconcile'

export interface QualityVerdict {
  ok: boolean
  reasons: string[]
  score: number
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

// ---- §P3-13 image-quality gate (pure metric + sharp glue) ------------------
// The metric helpers are PURE (no sharp / no alias deps), so they are exercised
// in-process by slicing them out and running them on synthetic pixel grids; only
// `assessSourceImageQuality` touches sharp. A quality verdict NEVER approves a row
// — the caller turns a non-empty `reasons` into needs_review, so this gate can only
// route work to a human and can never weaken auto-approve precision.

export interface GrayImage {
  /** 8-bit greyscale pixels, row-major, at least width*height long. */
  data: Uint8Array | ArrayLike<number>
  width: number
  height: number
}

export interface ImageQualityThresholds {
  /** Long edge below this is un-readably low resolution (px). */
  minLongEdge: number
  /** Total pixels below this is un-readably low resolution. */
  minPixels: number
  /** Laplacian variance at/below this is judged blurry. */
  blurVarianceAtMost: number
}

export const DEFAULT_IMAGE_QUALITY: ImageQualityThresholds = {
  minLongEdge: 500,
  minPixels: 250_000,
  blurVarianceAtMost: 100,
}

export type ImageQualityFlag = 'image-too-blurry' | 'image-too-small'

export interface ImageQualityVerdict {
  ok: boolean
  blurry: boolean
  lowRes: boolean
  longEdge: number
  pixels: number
  /** Laplacian variance, or null when not measurable (too small / decode fault). */
  focusScore: number | null
  reasons: ImageQualityFlag[]
}

/**
 * Population variance of the discrete 4-neighbour Laplacian (4c - up - down - left
 * - right) over every interior pixel. Sharp text yields high variance; a soft /
 * defocused photo yields near-zero. Null for a grid smaller than 3x3 (no interior)
 * or a short buffer, so callers can tell "unmeasurable" from "flat".
 */
export function laplacianVariance(img: GrayImage): number | null {
  const { width, height, data } = img
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) return null
  if (!data || data.length < width * height) return null

  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x
      const lap = 4 * (data[i] as number)
        - (data[i - 1] as number)
        - (data[i + 1] as number)
        - (data[i - width] as number)
        - (data[i + width] as number)
      sum += lap
      sumSq += lap * lap
      n += 1
    }
  }
  if (n === 0) return null
  const mean = sum / n
  return Math.max(0, sumSq / n - mean * mean)
}

/** Resolution verdict from ORIGINAL pixel dimensions (never from a resized copy). */
export function judgeResolution(
  width: number, height: number, t: ImageQualityThresholds = DEFAULT_IMAGE_QUALITY,
): { lowRes: boolean; longEdge: number; pixels: number } {
  const longEdge = Math.max(width, height)
  const pixels = width * height
  return { lowRes: longEdge < t.minLongEdge || pixels < t.minPixels, longEdge, pixels }
}

/**
 * Judge a full-resolution source. Resolution is checked on the original dimensions;
 * focus is checked on a normalised (fixed-long-edge) greyscale copy so one blur
 * threshold behaves the same for every phone size. A low-resolution source is
 * reported on its own (its focus score is meaningless), never also as blurry. A
 * decode/measure fault fails OPEN: it returns ok with no reasons so the gate can
 * never break extraction — a bad read still falls through to the field validators.
 * Cropping is deliberately NOT guessed from a single frame (a full-page scan has
 * ink at every legitimate edge); a real crop that removes the total/GSTIN/number is
 * already caught downstream by the field validators, so this stays honest.
 */
export async function assessSourceImageQuality(
  buffer: Buffer,
  t: ImageQualityThresholds = DEFAULT_IMAGE_QUALITY,
): Promise<ImageQualityVerdict> {
  try {
    const base = sharp(buffer, { animated: false, failOn: 'error' }).rotate()
    const meta = await base.metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    const res = judgeResolution(width, height, t)
    if (res.lowRes) {
      return {
        ok: false, blurry: false, lowRes: true,
        longEdge: res.longEdge, pixels: res.pixels, focusScore: null,
        reasons: ['image-too-small'],
      }
    }
    const { data, info } = await base
      .clone()
      .greyscale()
      .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true })
    const focusScore = laplacianVariance({ data: new Uint8Array(data), width: info.width, height: info.height })
    const blurry = focusScore !== null && focusScore <= t.blurVarianceAtMost
    return {
      ok: !blurry, blurry, lowRes: false,
      longEdge: res.longEdge, pixels: res.pixels, focusScore,
      reasons: blurry ? ['image-too-blurry'] : [],
    }
  } catch (error) {
    // Fail open, but never silently — a fault is a measurement gap, not a defect.
    logger.warn('[quality] image quality measurement skipped (decode fault)', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: true, blurry: false, lowRes: false, longEdge: 0, pixels: 0, focusScore: null, reasons: [] }
  }
}

export function isValidGstin(value: string): boolean {
  return GSTIN_RE.test(value.trim().toUpperCase())
}

/**
 * Row-level anomaly scan for extracted ledger rows (NaN, negatives, totals
 * mismatch). Delegates the total arithmetic to the SINGLE shared calculation
 * engine (./calc/reconcile) so this path can never diverge from the extraction
 * / review / export decision — the previous inline `taxable+tax` sum with a
 * magic `1.01` float tolerance is removed.
 */
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
  if (nums.every((n) => Number.isFinite(n))) {
    const [taxable, cgst, sgst, igst, total] = nums.map((n) => moneyToMinorUnits(n))
    const reconciliation = reconcileInvoiceTotal({ taxable, cgst, sgst, igst, printedTotal: total }, BigInt(101))
    if (reconciliation.status === 'mismatch') {
      reasons.push(`total mismatch: components sum to ${reconciliation.expectedMinor}, printed total is ${reconciliation.printedMinor}`)
    } else if (reconciliation.status === 'unverifiable') {
      reasons.push('total could not be reconciled from the available components')
    }
  }
  if (reasons.length > 0) logger.warn('ledger row anomaly', { reasons })
  return { ok: reasons.length === 0, reasons, score: reasons.length === 0 ? 1 : 0 }
}
