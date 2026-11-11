/** Pure helpers for the TraderMatrix call budget (M20a): the header chip, the degraded "TM paused until HH:MM" text, and the two budget fields. */
import type { QuotaStatus } from './api'

export const QUOTA_AMBER = 0.8
export const MAX_PER_MIN = 12
export const MAX_PER_DAY = 10_000

export type ChipTone = 'ok' | 'warn' | 'bad' | ''

/** Local `HH:MM` (24 h), or `HH:MM:SS`. `timeZone` is for tests; the app uses the machine's zone. */
export function fmtClock(ms: number, opts: { seconds?: boolean; timeZone?: string } = {}): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
    hour12: false,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  }).format(new Date(ms))
}

const sameDay = (a: number, b: number, timeZone?: string): boolean => {
  const f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) })
  return f.format(new Date(a)) === f.format(new Date(b))
}

/** `19:00`, or `19:00 tomorrow` when it is not today (local). */
export function untilText(until: number, now: number, timeZone?: string): string {
  return `${fmtClock(until, timeZone ? { timeZone } : {})}${sameDay(until, now, timeZone) ? '' : ' tomorrow'}`
}

export const isoOf = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Paused for the day (budget used or the server said so) and the pause has not ended yet. */
export function isPaused(q: QuotaStatus | null | undefined, now: number): boolean {
  return !!q && q.paused && (q.paused_until_ms === null || q.paused_until_ms > now)
}

/** The same words the Rust core uses, so one parser reads both. */
export function pausedMessage(q: QuotaStatus): string {
  const until = q.paused_until_ms ?? q.now_ms
  return `TM paused until ${isoOf(until)}: daily budget used (${Math.min(q.used, q.limit)} of ${q.limit} calls)`
}

/** Epoch ms from "TM paused until 2026-11-12T00:00:00Z: ..." or "TM throttled until ...", else null. */
export function untilOf(msg: string): number | null {
  const m = /until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(msg)
  if (!m) return null
  const t = Date.parse(m[1]!)
  return Number.isFinite(t) ? t : null
}

export const isTmPausedText = (msg: string): boolean => /\bTM paused until\b/i.test(msg)
export const isTmThrottledText = (msg: string): boolean => /\bTM throttled until\b/i.test(msg)

/** "TM paused until 19:00 (daily budget used (200 of 200 calls))": a degraded state, not an error wall. */
export function degradedText(msg: string, now: number = Date.now(), timeZone?: string): string {
  const paused = isTmPausedText(msg)
  const word = paused ? 'TM paused' : 'TM throttled'
  const until = untilOf(msg)
  const reason = msg.includes(': ') ? msg.slice(msg.indexOf(': ') + 2).trim() : ''
  const clock = until === null ? '' : ` until ${paused ? untilText(until, now, timeZone) : fmtClock(until, { seconds: true, ...(timeZone ? { timeZone } : {}) })}`
  return `${word}${clock}${reason ? ` (${reason})` : ''}`
}

export interface Chip {
  text: string
  tone: ChipTone
  title: string
}

/** "TM 37/200 today": amber from 80%, red when the day is used up or paused. Null until the first status arrives. */
export function quotaChip(q: QuotaStatus | null, now: number, timeZone?: string): Chip | null {
  if (!q) return null
  const text = `TM ${q.used}/${q.limit} today`
  const learned = q.limit_seen !== null && q.limit_seen < q.per_day ? ` TraderMatrix told us the limit is ${q.limit_seen}.` : ''
  if (isPaused(q, now) || q.used >= q.limit) {
    const until = q.paused_until_ms ?? now
    return { text, tone: 'bad', title: `TM paused until ${untilText(until, now, timeZone)}: today's budget is used (${Math.min(q.used, q.limit)} of ${q.limit} calls).${learned}` }
  }
  const tone: ChipTone = q.used / q.limit >= QUOTA_AMBER ? 'warn' : 'ok'
  return { text, tone, title: `${q.remaining} TraderMatrix calls left today (${q.per_min} per minute allowed). Cached reads cost nothing.${learned}` }
}

/** Shown only while the per-minute wall or a server backoff is holding calls back. */
export function throttleChip(q: QuotaStatus | null, now: number, timeZone?: string): Chip | null {
  if (!q || q.throttled_until_ms === null || q.throttled_until_ms <= now) return null
  return { text: `TM slow until ${fmtClock(q.throttled_until_ms, { seconds: true, ...(timeZone ? { timeZone } : {}) })}`, tone: 'warn', title: `TraderMatrix allows ${q.per_min} calls a minute; calls resume at that time.` }
}

/** Free tier: TM cut some lists short. */
export function previewChip(q: QuotaStatus | null): Chip | null {
  if (!q || !q.preview) return null
  return { text: 'TM preview', tone: 'warn', title: 'preview: upgrade for full lists. TraderMatrix cut a list to its first items, so the watchlist sync is off.' }
}

export type BudgetInput = { ok: true; perMin: number; perDay: number } | { ok: false; error: string }

/** Whole numbers only: 1 to 12 per minute (TraderMatrix's own limit on every plan), 1 to 10000 per day. */
export function parseBudgetInput(perMin: string, perDay: string): BudgetInput {
  const n = (s: string): number => (/^\s*\d{1,6}\s*$/.test(s) ? Number(s) : NaN)
  const a = n(perMin)
  const b = n(perDay)
  if (!Number.isInteger(a) || a < 1 || a > MAX_PER_MIN) return { ok: false, error: `Calls per minute must be a whole number from 1 to ${MAX_PER_MIN} (TraderMatrix allows ${MAX_PER_MIN} on every plan).` }
  if (!Number.isInteger(b) || b < 1 || b > MAX_PER_DAY) return { ok: false, error: `Calls per day must be a whole number from 1 to ${MAX_PER_DAY}.` }
  return { ok: true, perMin: a, perDay: b }
}
