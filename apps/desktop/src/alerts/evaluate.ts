/** Pure alert evaluation (M17 task 2). No clock, no network, no store: the caller supplies the price, the previous side, the quote age and the session. INFORM ONLY. */
import type { Alert, Side } from './types'

/** A quote older than this (seconds) is never evaluated: a stale price must not fire an alert. */
export const STALE_QUOTE_S = 20

export interface Obs {
  px: number
  /** The side recorded at the previous observation; null before the first one (a first observation only records). */
  prevSide: Side | null
  quoteAgeS: number
  sessionOpen: boolean
  /** Only extended hours are open (pre-market or after-hours): the alert needs `extended_hours`. */
  extendedOnly?: boolean
  /** The resolved level for a by-reference alert; defaults to the alert's own price. */
  level?: number
  /** Allow a level of 0 or below (a P&L threshold in dollars). Prices and IV rank never need it. */
  signed?: boolean
}

export interface EvalResult {
  fire: boolean
  /** The side to remember. */
  side: Side
  /** False when the guards skipped the observation (stale quote, closed session, bad number): the side was not advanced. */
  observed: boolean
  event?: { kind: 'fire'; side: Side; px: number; level: number }
}

export function sideOf(px: number, level: number): Side {
  return px > level ? 1 : px < level ? -1 : 0
}

export function evaluate(alert: Pick<Alert, 'price' | 'dir' | 'mode' | 'extended_hours'>, obs: Obs): EvalResult {
  const level = obs.level ?? alert.price
  const keep: Side = obs.prevSide ?? 0
  if (
    !Number.isFinite(obs.px) ||
    !Number.isFinite(level) ||
    (obs.signed !== true && !(level > 0)) ||
    !(obs.quoteAgeS <= STALE_QUOTE_S) ||
    !obs.sessionOpen ||
    (obs.extendedOnly === true && !alert.extended_hours)
  ) {
    return { fire: false, side: keep, observed: false }
  }
  const side = sideOf(obs.px, level)
  // The first observation after creation (or after a drag) only records the side.
  if (obs.prevSide === null) return { fire: false, side, observed: true }
  const prev = obs.prevSide
  const dirOk = (to: Side) => alert.dir === 'either' || (alert.dir === 'up' && to === 1) || (alert.dir === 'down' && to === -1)
  if (side === 0) {
    // Touching the level is not crossing it: the old side is kept so the later real crossing still counts.
    if (alert.mode === 'touch' && prev !== 0) return { fire: true, side: 0, observed: true, event: { kind: 'fire', side: 0, px: obs.px, level } }
    return { fire: false, side: prev, observed: true }
  }
  const flipped = prev !== 0 && side !== prev
  if (flipped && dirOk(side)) return { fire: true, side, observed: true, event: { kind: 'fire', side, px: obs.px, level } }
  return { fire: false, side, observed: true }
}

/** Mirror of the Rust re-arm rule: a fired `rearm` alert may re-arm once the price is `hysteresis_pct` away from the level on the side it came from. */
export function retreated(alert: Pick<Alert, 'price' | 'hysteresis_pct' | 'last_side'>, px: number, level = alert.price): boolean {
  if (!Number.isFinite(px)) return false
  const band = (level * alert.hysteresis_pct) / 100
  if (alert.last_side === 1) return px <= level - band
  if (alert.last_side === -1) return px >= level + band
  return false
}
