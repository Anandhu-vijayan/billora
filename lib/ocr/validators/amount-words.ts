import { moneyToMinorUnits } from './money'

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}
const SCALES: Record<string, bigint> = {
  thousand: BigInt(1_000),
  lakh: BigInt(100_000),
  lac: BigInt(100_000),
  crore: BigInt(10_000_000),
}

function parseNumberWords(words: string[]): bigint | null {
  if (words.length === 0) return BigInt(0)
  let total = BigInt(0)
  let group = BigInt(0)
  let sawNumber = false

  for (const word of words) {
    if (word === 'and') continue
    if (Object.hasOwn(SMALL, word)) {
      group += BigInt(SMALL[word])
      sawNumber = true
      continue
    }
    if (Object.hasOwn(TENS, word)) {
      group += BigInt(TENS[word])
      sawNumber = true
      continue
    }
    if (word === 'hundred') {
      group = (group === BigInt(0) ? BigInt(1) : group) * BigInt(100)
      sawNumber = true
      continue
    }
    const scale = SCALES[word]
    if (scale) {
      total += (group === BigInt(0) ? BigInt(1) : group) * scale
      group = BigInt(0)
      sawNumber = true
      continue
    }
    return null
  }

  return sawNumber ? total + group : null
}

/** Parse common Indian invoice amount-in-words spellings to paise. */
export function parseIndianAmountWords(input: string): bigint | null {
  const normalized = input.toLowerCase()
    .replace(/\b(inr|rs\.?|rupees?)\b/g, ' ')
    .replace(/\bonly\b/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim()
  if (!normalized) return null

  const tokens = normalized.split(/\s+/).filter(Boolean)
  const paiseIndex = tokens.indexOf('paise')
  const integerTokens = tokens.slice(0, paiseIndex >= 0 ? paiseIndex : undefined)
  const integerValue = parseNumberWords(integerTokens)
  if (integerValue === null) return null

  let paise = BigInt(0)
  if (paiseIndex >= 0) {
    const paiseTokens = tokens.slice(paiseIndex + 1)
    const parsedPaise = parseNumberWords(paiseTokens)
    if (parsedPaise === null || parsedPaise > BigInt(99)) return null
    paise = parsedPaise
  }

  return integerValue * BigInt(100) + paise
}

export function amountWordsMatchNumeric(words: string, numeric: number | string): boolean | null {
  const inWords = parseIndianAmountWords(words)
  const numericMinor = moneyToMinorUnits(numeric)
  if (inWords === null || numericMinor === null) return null
  return inWords === numericMinor
}
