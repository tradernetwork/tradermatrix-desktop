/**
 * Number-grounding check (M16 A1). Every number in a model reply is compared with the numbers in the digest that was sent; the ones
 * with no counterpart come back as `flagged` ranges (the pane draws a dotted underline: "not in the data I sent"). Pure, linear, no network.
 *
 * Tolerance: relative 0.6% or half of the last decimal the reply shows, whichever is wider. Percent vs decimal: a reply `2.1%` matches a
 * digest `0.021` or `2.1`; a plain reply decimal below 1 also matches a digest percent. Sign is ignored (a drop of 1.2% against +1.23%).
 * Not graded: years, ISO dates, month-day dates, clock times, list markers, ordinals and unit-glued tokens (15m, 3rd, Q3, IV30), `N-day`
 * style adjectives, plain integers up to 10 ("3 reasons"), and the closing `Used:` line.
 */
export interface Flag {
  text: string
  start: number
  end: number
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*'
const MASKS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, 'gi'),
  /^[ \t]*Used:.*$/gim,
  /^[ \t]*\d{1,3}[.)](?=[ \t])/gm,
]
const NUMBER = /(?<![A-Za-z0-9.])(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%)?(?![A-Za-z0-9])/g
const ADJ = /^-(?:day|days|period|bar|bars|week|weeks|month|months|minute|min|hour|hr|year|years)\b/i
const EPS = 1e-9

interface DigestNum {
  v: number
}

function digestNumbers(digest: string): DigestNum[] {
  const out: DigestNum[] = []
  for (const m of digest.matchAll(/\d+(?:\.\d+)?/g)) {
    const v = Number(m[0])
    if (Number.isFinite(v)) out.push({ v })
  }
  return out
}

function masked(text: string): [number, number][] {
  const out: [number, number][] = []
  for (const re of MASKS) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length])
  }
  return out
}

function matches(value: number, decimals: number, pct: boolean, nums: readonly DigestNum[]): boolean {
  const half = 0.5 * Math.pow(10, -decimals)
  for (const { v } of nums) {
    const cands = pct ? [v, v * 100] : value < 1 && decimals > 0 ? [v, v / 100] : [v]
    for (const c of cands) {
      const tol = Math.max(0.006 * Math.abs(c), half)
      if (Math.abs(value - c) <= tol + EPS) return true
    }
  }
  return false
}

export function groundReply(reply: string, digest: string): { flagged: Flag[] } {
  const flagged: Flag[] = []
  if (!reply) return { flagged }
  const nums = digestNumbers(digest)
  const skip = masked(reply)
  NUMBER.lastIndex = 0
  for (const m of reply.matchAll(NUMBER)) {
    const start = m.index
    const end = start + m[0].length
    if (skip.some(([a, b]) => start < b && end > a)) continue
    const [, dollar, whole, frac, pct] = m
    const plainInt = !dollar && !frac && !pct && !whole!.includes(',')
    if (plainInt && Number(whole) <= 10) continue
    if (plainInt && whole!.length === 4 && Number(whole) >= 1900 && Number(whole) <= 2100) continue
    if (ADJ.test(reply.slice(end, end + 12))) continue
    const value = Number(whole!.replace(/,/g, '') + (frac ?? ''))
    if (!Number.isFinite(value)) {
      flagged.push({ text: m[0], start, end })
      continue
    }
    const decimals = frac ? frac.length - 1 : 0
    if (!matches(value, decimals, !!pct, nums)) flagged.push({ text: m[0], start, end })
  }
  return { flagged }
}
