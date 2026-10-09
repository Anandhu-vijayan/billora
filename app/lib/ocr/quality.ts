export function isBlurryHeuristic(imageBuffer: Buffer): { blurry: boolean, score: number } {
  const sizeKB = imageBuffer.length / 1024
  if (sizeKB < 30) return { blurry: true, score: sizeKB }
  return { blurry: false, score: sizeKB }
}
export function isCutOff(text: string): boolean {
  if (!text) return true
  const hasNumber = /\d/.test(text)
  return !hasNumber || text.trim().length < 20
}
