/**
 * Arya's states and small touches (M16 B6). EXPLAIN ONLY. Pure helpers: the pane maps store flags to an avatar state, prints a freshness
 * stamp, says plainly when a value she was asked about is not on screen, and shows one static fact a day. Tone: plain, warm, dry, first
 * person; no emojis, no advice, nothing about getting rich.
 */
import { groundReply } from './explainGround'
import type { AryaState } from './brand'

export interface AryaFlags {
  busy: boolean
  /** Some of the answer has already arrived. */
  streamingText: boolean
  /** How many numbers in the latest answer are not in the data she was sent. */
  flagged: number
  error: boolean
}
/** error > streaming (text arriving) > thinking (waiting) > check numbers (flagged answer) > idle. */
export function aryaStateFor(f: AryaFlags): AryaState {
  if (f.error) return 'error'
  if (f.busy) return f.streamingText ? 'streaming' : 'thinking'
  if (f.flagged > 0) return 'check'
  return 'idle'
}

/** Numbers in `text` that are not in `digest` (the grounding check); 0 without a digest. */
export function flaggedCountFor(text: string, digest: string | null): number {
  return digest ? groundReply(text, digest).flagged.length : 0
}

const pad = (n: number) => String(n).padStart(2, '0')
/** "data as of 14:32, 3 min ago" (local time). null without a usable timestamp. */
export function freshness(ts: number | null, now: number): string | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null
  const d = new Date(ts)
  const secs = Math.max(0, Math.floor((now - ts) / 1000))
  const ago = secs < 45 ? 'just now' : secs < 3600 ? `${Math.max(1, Math.floor(secs / 60))} min ago` : secs < 86_400 ? `${Math.floor(secs / 3600)} h ago` : `${Math.floor(secs / 86_400)} d ago`
  return `data as of ${pad(d.getHours())}:${pad(d.getMinutes())}, ${ago}`
}

interface Topic {
  label: string
  asked: RegExp
  /** True when the digest does not have this value. */
  missing: (d: string) => boolean
}
const line = (d: string, p: string): string => d.split('\n').find((l) => l.startsWith(p)) ?? ''
const TOPICS: Topic[] = [
  { label: 'IV rank', asked: /\biv\s*rank\b|\bimplied vol/i, missing: (d) => /(^|\s)rank=NA(\s|$)/.test(line(d, 'IV:')) },
  { label: 'Apex levels', asked: /\bapex\b|\bwalls?\b/i, missing: (d) => /(^|\s)apex=NA(\s|$)/.test(line(d, 'LEVELS:')) },
  { label: 'gamma flip', asked: /\bgamma\b|\bflip\b/i, missing: (d) => /(^|\s)flip=NA(\s|$)/.test(line(d, 'LEVELS:')) },
  { label: 'expected move', asked: /\bexpected\s*move\b|\bem\b/i, missing: (d) => /(^|\s)em_pct=NA(\s|$)/.test(line(d, 'LEVELS:')) },
  { label: 'Fibonacci levels', asked: /\bfib/i, missing: (d) => /(^|\s)up=NA(\s|$)/.test(line(d, 'FIB:')) },
  { label: 'strike check', asked: /\bstrike\b/i, missing: (d) => !d.split('\n').some((l) => l.startsWith('STRIKE:')) },
]
/** The values the question is about that the digest does not have. The pane prints "I don't see that on your screen: ..." for them. */
export function naNotes(question: string, digest: string): string[] {
  if (!question.trim()) return []
  return TOPICS.filter((t) => t.asked.test(question) && t.missing(digest)).map((t) => t.label)
}
export const naMessage = (labels: readonly string[]): string => `I don't see that on your screen: ${labels.join(', ')}.`

/** One static fact a day for the empty state. Plain definitions only. */
export const DAILY_FACTS: readonly string[] = [
  "IV rank compares today's implied volatility with its own range over the past year, on a scale from 0 to 100.",
  'An expected move is the range the options market is pricing for a date. It is a statistical range, not a forecast.',
  'The gamma flip is the price where estimated dealer hedging changes from calming moves to amplifying them.',
  "Theta is how much an option's price is expected to lose per day from time passing alone, other things equal.",
  'Delta is roughly how many shares an option behaves like: a 0.30 delta call moves about 30 cents when the stock moves a dollar.',
  "A fair value gap is a stretch where the first candle's high and the third candle's low leave a price range between them untouched.",
  'A candle shows the open, high, low and close of one period. The body spans open to close and the wicks reach the extremes.',
  'DTE counts the calendar days left until an option expires. Time decay tends to speed up as that number gets small.',
  'Open interest counts contracts that are still open. Volume counts the contracts traded today.',
  'ATR, the average true range, measures how far price typically travels in one bar, gaps included.',
]
/** Rotates by local calendar day. */
export function factForDay(d: Date): string {
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
  return DAILY_FACTS[((day % DAILY_FACTS.length) + DAILY_FACTS.length) % DAILY_FACTS.length]!
}
