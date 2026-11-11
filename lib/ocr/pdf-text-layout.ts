// Rebuild pdf.js text items into visual lines before deterministic invoice parsing.
// pdf.js often emits several text runs for one printed line (logo/name fragments,
// labels and values). Joining every run with a newline destroys the layout cues the
// invoice parser relies on. Coordinates are PDF user-space points; the helper is
// pure so the ordering/spacing rules can be regression-tested without pdf.js.
export interface PdfTextItemLike {
  str?: string
  transform?: readonly number[]
  width?: number
  height?: number
}

interface PositionedItem {
  text: string
  x: number
  y: number
  width: number
  fontSize: number
  height: number
}

export function reconstructPdfText(items: readonly PdfTextItemLike[]): string {
  const clean = items
    .map((item, index) => ({ item, index, text: (item.str ?? '').replace(/\s+/g, ' ').trim() }))
    .filter((entry) => entry.text.length > 0)
  if (clean.length === 0) return ''

  const positioned: PositionedItem[] = []
  for (const entry of clean) {
    const t = entry.item.transform
    if (!Array.isArray(t) || t.length < 6
      || !Number.isFinite(t[4]) || !Number.isFinite(t[5])) {
      // Partial geometry is not safe to guess at: retain pdf.js item order rather
      // than manufacture line boundaries from incomplete coordinates.
      return clean.map((part) => part.text).join('\n')
    }
    const fontSize = Math.max(1, Math.hypot(Number(t[2] ?? 0), Number(t[3] ?? 0)))
    const height = Math.max(1, Number(entry.item.height ?? fontSize))
    positioned.push({
      text: entry.text,
      x: Number(t[4]),
      y: Number(t[5]),
      width: Math.max(0, Number(entry.item.width ?? 0)),
      fontSize,
      height,
    })
  }

  // pdf.js page coordinates grow upward. Sort top-to-bottom, then left-to-right.
  positioned.sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: Array<{ y: number; height: number; items: PositionedItem[] }> = []
  for (const item of positioned) {
    const tolerance = Math.max(1.5, Math.min(item.height, 14) * 0.3)
    let row = rows.find((candidate) =>
      Math.abs(candidate.y - item.y) <= Math.max(tolerance, Math.min(candidate.height, 14) * 0.3),
    )
    if (!row) {
      row = { y: item.y, height: item.height, items: [] }
      rows.push(row)
    }
    row.items.push(item)
    row.y = row.items.reduce((sum, part) => sum + part.y, 0) / row.items.length
    row.height = Math.max(row.height, item.height)
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      row.items.sort((a, b) => a.x - b.x)
      let line = ''
      let previous: PositionedItem | null = null
      for (const item of row.items) {
        if (previous) {
          const gap = item.x - (previous.x + previous.width)
          const threshold = Math.max(0.5, Math.min(previous.fontSize, item.fontSize) * 0.14)
          if (gap > threshold && !/\s$/.test(line) && !/^[,.;:)]/.test(item.text)) line += ' '
        }
        line += item.text
        previous = item
      }
      return line.trim()
    })
    .filter(Boolean)
    .join('\n')
}
