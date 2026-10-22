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

/**
 * Parse common Indian invoice amount-in-words spellings to paise.
 *
 * Handles: "INR One Thousand Only", "Rupees Five Lakh ... Fifty One Only",
 * "Five Lakh ... Fifty One Indian Rupee only." (the country adjective used to
 * make the whole parse return null, silently disabling the words cross-check),
 * "One Thousand Rupees and Fifty Paise Only" (paise BEFORE the word "paise" —
 * the old code folded those words into the rupee figure), and the legacy
 * "One Thousand and Paise Fifty" order.
 */
export function parseIndianAmountWords(input: string): bigint | null {
  const NOISE = new Set(['indian', 'inr', 'rs', 'only', 'ruppee', 'ruppees'])
  const tokens = input.toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !NOISE.has(t))
  if (tokens.length === 0) return null

  const isRupee = (t: string) => t === 'rupee' || t === 'rupees'
  const isPaise = (t: string) => t === 'paise' || t === 'paisa'
  const paiseIndex = tokens.findIndex(isPaise)
  // A rupee word at index 0 is the PREFIX form ("Rupees Fifty One ..."), not a
  // separator between rupees and paise.
  const suffixRupeeIndex = tokens.findIndex((t, i) => i > 0 && isRupee(t))

  let rupeeTokens: string[]
  let paiseTokens: string[] = []
  if (paiseIndex >= 0 && suffixRupeeIndex >= 0 && suffixRupeeIndex < paiseIndex) {
    // "<rupees> Rupees [and] <paise> Paise"
    rupeeTokens = tokens.slice(0, suffixRupeeIndex)
    paiseTokens = tokens.slice(suffixRupeeIndex + 1, paiseIndex)
  } else if (paiseIndex >= 0 && paiseIndex < tokens.length - 1) {
    // legacy "<rupees> [and] Paise <paise>"
    rupeeTokens = tokens.slice(0, paiseIndex).filter((t) => !isRupee(t))
    paiseTokens = tokens.slice(paiseIndex + 1)
  } else if (paiseIndex >= 0) {
    // prefix form "Rupees <rupees> and <paise> Paise": split on the last "and"
    const before = tokens.slice(0, paiseIndex).filter((t) => !isRupee(t))
    const andAt = before.lastIndexOf('and')
    if (andAt < 0) return null
    rupeeTokens = before.slice(0, andAt)
    paiseTokens = before.slice(andAt + 1)
  } else {
    rupeeTokens = tokens.filter((t) => !isRupee(t))
  }

  const integerValue = parseNumberWords(rupeeTokens)
  if (integerValue === null) return null
  let paise = BigInt(0)
  if (paiseTokens.length > 0) {
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
