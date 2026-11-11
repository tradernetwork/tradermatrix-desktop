/**
 * Strike check for premium sellers (M13). INFORMATIONAL ONLY: nothing here (or anywhere that renders it) blocks, disables or
 * alters Review / Place. Pure functions, no React, no store, no network.
 *
 * Units: `emPct` is a decimal fraction of spot (0.04 = 4%, TraderMatrix expectedMovePct); `ivRank` is 0..100; option quotes are
 * per share. Apex levels are positioning maps, not targets. Every missing input becomes `null` (shown as "-"), and a missing input
 * never produces a verdict that implies safety: 'protected' needs a known wall, a known EM and a known event calendar.
 */
import type { ApexLevels, EarningsInfo, ExpectedMove, IvRank, RhOptionPosition, RhOptionRow } from './api'

export type Verdict = 'protected' | 'exposed' | 'event' | 'unknown'
export type EmCoverage = 'ok' | 'mismatch' | 'missing'
export type ApexCoverage = 'ok' | 'beyond' | 'missing'

export interface StrikeCheckInput {
  side: 'sell' | 'buy'
  right: 'call' | 'put'
  strike: number
  /** ISO date YYYY-MM-DD. */
  expiration: string
  dte: number
  spot: number | null
  delta?: number | null
  /** 0..100. */
  ivRank?: number | null
  /** Expected move as a decimal fraction of spot. */
  emPct?: number | null
  /** The expiry (ISO date) the expected move covers. When present and different from `expiration`, emUnits is NOT computed. */
  emFor?: string | null
  /** Apex levels (aggregate). Empty or absent = no apex data. */
  apex?: { price: number; kind?: string }[] | null
  /** Last expiry the apex aggregate covers; an option expiring after it gets no apex verdict. Absent = coverage unknown, taken as ok. */
  apexThrough?: string | null
  earnings: { date: string } | null
  /** 'unknown' = the earnings lookup has not answered (error, no key, not loaded): the event row shows "-". Default 'ok'. */
  earningsStatus?: 'ok' | 'unknown'
  /** Daily ATR of the underlying (chart). */
  atr?: number | null
  /** ISO date of today. */
  today: string
}

export interface StrikeCheckResult {
  graded: boolean
  distancePct: number | null
  /** The strike is on the in-the-money side of spot. */
  itm: boolean | null
  emUnits: number | null
  /** Strict: emUnits < 1. Exactly one EM away is NOT inside. */
  insideEm: boolean | null
  emCoverage: EmCoverage
  apexCoverage: ApexCoverage
  /** Nearest apex level strictly between spot and the strike (on the strike's side), nearest to the strike. */
  wallBetween: number | null
  /** An apex level exactly at the strike (reported separately; it is not "between"). */
  atStrike: number | null
  /** true / false, or null when the calendar is unknown. Earnings date == expiration counts as inside; a date before today is ignored. */
  eventInside: boolean | null
  eventDate: string | null
  /** EM move in dollars over the daily ATR times sqrt(DTE). Null without ATR or with dte < 1. */
  emVsAtr: number | null
  ivRank: number | null
  delta: number | null
  /** Short legs only. */
  verdict?: Verdict
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const round9 = (n: number) => Math.round(n * 1e9) / 1e9

export function strikeCheck(i: StrikeCheckInput): StrikeCheckResult {
  const spot = fin(i.spot) && i.spot > 0 ? i.spot : null
  const strikeOk = fin(i.strike) && i.strike > 0
  const distancePct = spot !== null && strikeOk ? round9(Math.abs(i.strike - spot) / spot) : null
  const itm = spot !== null && strikeOk ? (i.right === 'put' ? i.strike > spot : i.strike < spot) : null

  // ---- expected move ----
  const emRaw = fin(i.emPct) && i.emPct > 0 ? i.emPct : null
  let emCoverage: EmCoverage = 'missing'
  let emUnits: number | null = null
  if (emRaw !== null) {
    if (i.emFor && i.emFor !== i.expiration) emCoverage = 'mismatch'
    else {
      emCoverage = 'ok'
      if (distancePct !== null) emUnits = round9(distancePct / emRaw)
    }
  }
  const insideEm = emUnits === null ? null : emUnits < 1

  // ---- apex wall ----
  const levels = (i.apex ?? []).map((l) => l.price).filter((p) => fin(p) && p > 0)
  let apexCoverage: ApexCoverage = levels.length === 0 ? 'missing' : 'ok'
  if (apexCoverage === 'ok' && i.apexThrough && i.expiration > i.apexThrough) apexCoverage = 'beyond'
  let wallBetween: number | null = null
  let atStrike: number | null = null
  if (apexCoverage === 'ok' && spot !== null && strikeOk) {
    atStrike = levels.find((p) => p === i.strike) ?? null
    const lo = Math.min(spot, i.strike)
    const hi = Math.max(spot, i.strike)
    // Only the strike's own side counts: a put's walls sit below spot, a call's above (ITM strikes have nothing between on that side).
    const between = itm ? [] : levels.filter((p) => p > lo && p < hi)
    if (between.length > 0) wallBetween = i.right === 'put' ? Math.min(...between) : Math.max(...between)
  }

  // ---- event calendar ----
  const known = (i.earningsStatus ?? 'ok') === 'ok'
  const date = i.earnings?.date ?? null
  const eventInside = !known ? null : date !== null && date >= i.today && date <= i.expiration
  const eventDate = known ? date : null

  // ---- EM vs realized ATR ----
  const emVsAtr =
    emRaw !== null && emCoverage === 'ok' && spot !== null && fin(i.atr) && i.atr > 0 && fin(i.dte) && i.dte >= 1 ? (emRaw * spot) / (i.atr * Math.sqrt(i.dte)) : null

  const out: StrikeCheckResult = {
    graded: i.side === 'sell',
    distancePct,
    itm,
    emUnits,
    insideEm,
    emCoverage,
    apexCoverage,
    wallBetween,
    atStrike,
    eventInside,
    eventDate,
    emVsAtr,
    ivRank: fin(i.ivRank) ? i.ivRank : null,
    delta: fin(i.delta) ? i.delta : null,
  }
  if (i.side !== 'sell') return out

  // ---- verdict (short legs only) ----
  if (eventInside === true) out.verdict = 'event'
  else if (apexCoverage !== 'ok' || spot === null || !strikeOk) out.verdict = 'unknown'
  else if (wallBetween !== null && insideEm === false && eventInside === false) out.verdict = 'protected'
  else if (wallBetween === null) out.verdict = 'exposed'
  else if (insideEm === true) out.verdict = 'exposed'
  else out.verdict = 'unknown' // wall present, but the EM or the calendar is unknown: never imply safety
  return out
}

// ---------------------------------------------------------------------------------------------------------------------------
// Mapping from what the app already holds to the pure input.

export interface TmBits {
  apex: ApexLevels | null
  move: ExpectedMove | null
  iv: IvRank | null
}

export interface BuildStrikeArgs {
  side: 'sell' | 'buy'
  row: Pick<RhOptionRow, 'instrument' | 'quote'>
  spot: number | null
  tm: TmBits
  /** null = no row/answer; `status` says whether the lookup answered. */
  earnings: EarningsInfo | null
  earningsStatus: 'ok' | 'unknown'
  atr?: number | null
  today: string
}

/** Whole days from `a` to `b` (ISO dates, UTC). */
export function daysBetween(a: string, b: string): number {
  const pa = Date.parse(`${a}T00:00:00Z`)
  const pb = Date.parse(`${b}T00:00:00Z`)
  return Number.isFinite(pa) && Number.isFinite(pb) ? Math.round((pb - pa) / 86_400_000) : NaN
}

/** The expected-move horizon for an expiry: the one whose through_date IS the expiry, else the nearest by date (flagged by emFor, never reused silently). */
export function pickHorizon(move: ExpectedMove | null, expiration: string): { pct: number; through: string } | null {
  if (!move) return null
  let best: { pct: number; through: string; gap: number } | null = null
  for (const h of move.horizons) {
    if (!fin(h.expected_move_pct) || !h.through_date) continue
    const gap = Math.abs(daysBetween(h.through_date, expiration))
    if (!Number.isFinite(gap)) continue
    if (best === null || gap < best.gap) best = { pct: h.expected_move_pct, through: h.through_date, gap }
  }
  return best ? { pct: best.pct, through: best.through } : null
}

/** Chain row + TM store + earnings + ATR -> `StrikeCheckInput`; null when the row has no usable strike, expiry or right. */
export function buildStrikeInput(a: BuildStrikeArgs): StrikeCheckInput | null {
  const { strike_price: strike, expiration_date: expiration, option_type: type } = a.row.instrument
  if (!fin(strike) || !expiration || (type !== 'call' && type !== 'put')) return null
  const h = pickHorizon(a.tm.move, expiration)
  const apexLevels = a.tm.apex?.levels.filter((l): l is typeof l & { strike: number } => fin(l.strike)).map((l) => ({ price: l.strike, kind: l.is_above_spot === true ? 'above' : l.is_above_spot === false ? 'below' : undefined })) ?? []
  const used = a.tm.apex?.expirations_used ?? []
  const through = used.length > 0 ? [...used].sort().at(-1)! : null
  // The Rust core cuts `next` at today in UTC; after the UTC rollover (US evening) a report dated "today" in the US sits in `last`.
  // Candidates dated before OUR today are dropped, so a stale row is ignored and the earliest live date wins.
  const live = a.earningsStatus === 'ok' && a.earnings ? [a.earnings.last, a.earnings.next].filter((e): e is NonNullable<typeof e> => !!e && e.date >= a.today).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)) : []
  const nextEarn = live[0] ?? null
  return {
    side: a.side,
    right: type,
    strike,
    expiration,
    dte: daysBetween(a.today, expiration),
    spot: a.spot,
    delta: a.row.quote?.delta ?? null,
    ivRank: a.tm.iv?.iv_rank ?? null,
    emPct: h?.pct ?? null,
    emFor: h?.through ?? null,
    apex: apexLevels,
    apexThrough: through,
    earnings: nextEarn ? { date: nextEarn.date } : null,
    earningsStatus: a.earningsStatus,
    atr: a.atr ?? null,
    today: a.today,
  }
}

/** Display helpers: "-" for unknown. */
export const dash = (s: string | null | undefined): string => (s === null || s === undefined || s === '' ? '-' : s)
export const pctText = (n: number | null): string => (n === null ? '-' : `${(n * 100).toFixed(1)}%`)
export const unitsText = (n: number | null): string => (n === null ? '-' : `${n.toFixed(2)} EM`)

export const VERDICT_TEXT: Record<Verdict, string> = {
  protected: 'wall in front, outside 1 EM',
  exposed: 'no wall in front or inside 1 EM',
  event: 'earnings before expiry',
  unknown: 'not enough data',
}

/** Row list for the panel and the Positions tooltip: label + value text, "-" where unknown. */
export function strikeRows(r: StrikeCheckResult, i: Pick<StrikeCheckInput, 'strike' | 'expiration' | 'emFor' | 'apexThrough'>): { label: string; value: string }[] {
  const em =
    r.emCoverage === 'mismatch'
      ? `- (TM covers ${dash(i.emFor)}, not ${i.expiration})`
      : r.emCoverage === 'missing'
        ? '-'
        : `${unitsText(r.emUnits)} (${r.insideEm ? 'inside' : 'outside'} 1 EM)`
  const wall =
    r.apexCoverage === 'missing'
      ? '-'
      : r.apexCoverage === 'beyond'
        ? `- (Apex covers through ${dash(i.apexThrough)})`
        : r.wallBetween !== null
          ? `Apex ${r.wallBetween}`
          : r.atStrike !== null
            ? `Apex wall AT the strike ${r.atStrike}`
            : 'none between'
  const event = r.eventInside === null ? '-' : r.eventInside ? `earnings ${dash(r.eventDate)} before expiry` : r.eventDate ? `next ${r.eventDate}, after expiry` : 'none found'
  return [
    { label: 'Distance', value: pctText(r.distancePct) },
    { label: 'Expected move', value: em },
    { label: 'Wall in front', value: wall },
    { label: 'Event', value: event },
    { label: 'EM vs ATR', value: r.emVsAtr === null ? '-' : `${r.emVsAtr.toFixed(2)}x`},
    { label: 'IV rank', value: r.ivRank === null ? '-' : r.ivRank.toFixed(0) },
  ]
}

/** Local calendar date as YYYY-MM-DD (the user's "today"; earnings dates are US calendar dates). */
export function localIsoDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** An open option position as a chain-row-shaped input for `buildStrikeInput` (the quote carries only what the check reads). */
export function rowFromPosition(o: RhOptionPosition): Pick<RhOptionRow, 'instrument' | 'quote'> {
  return {
    instrument: { id: o.option_id, chain_id: '', chain_symbol: o.chain_symbol, expiration_date: o.expiration_date, strike_price: o.strike_price, option_type: o.option_type },
    quote: { instrument_id: o.option_id, bid: o.bid, ask: o.ask, mark: o.mark, delta: o.delta, gamma: null, theta: o.theta, vega: null, rho: null, implied_volatility: o.iv, open_interest: null, volume: null },
  }
}

/** Dot color class and tooltip for a position's verdict. Long positions get no dot (null). */
export function verdictDot(r: StrikeCheckResult | null): { cls: string; text: string } | null {
  if (!r || r.verdict === undefined) return null
  return { cls: `sc-dot sc-${r.verdict}`, text: `Strike check (info only): ${r.verdict}, ${VERDICT_TEXT[r.verdict]}` }
}
