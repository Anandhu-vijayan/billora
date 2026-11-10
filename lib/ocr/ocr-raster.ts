/**
 * Compute a bounded OCR raster size without pretending that upscaling creates
 * source detail. Small WhatsApp images are enlarged for Tesseract's character
 * segmentation only; the original bytes remain the Gemini/evidence source.
 */
export function getOcrRasterSize(
  width: number,
  height: number,
  maxPixels = 40_000_000,
  maxLongEdge = 3508,
  maxUpscale = 2,
): { width: number; height: number } {
  if (![width, height, maxPixels, maxLongEdge, maxUpscale].every(Number.isFinite)
    || width < 1 || height < 1 || maxPixels < 1 || maxLongEdge < 1 || maxUpscale < 1) {
    throw new RangeError('Invalid OCR raster dimensions or limits')
  }
  const scale = Math.min(
    maxUpscale,
    maxLongEdge / Math.max(width, height),
    Math.sqrt(maxPixels / (width * height)),
  )
  if (scale <= 1) return { width: Math.round(width), height: Math.round(height) }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
