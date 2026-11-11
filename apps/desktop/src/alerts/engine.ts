/** The quote-driven alert loop (M17 task 4): one pass over a batch of quotes, evaluating only alerts whose symbol is in the batch. INFORM ONLY. */
import type { RhQuote } from '../lib/api'
import { isSnoozed, isTracked } from './active'
import { evaluate as evaluateDefault, retreated, sideOf } from './evaluate'
import { isRefAlert, type Resolved } from './levelRefs'
import type { SessionInfo } from './session'
import type { Alert, AlertEvent, FireOutcome, Side } from './types'

export interface EngineDeps {
  now: () => number
  session: (now: number) => SessionInfo
  /** The transactional single-fire command. */
  fire: (id: number, side: number, px: number, quoteAgeS: number) => Promise<FireOutcome>
  /** Record the side locally (and persist it). `null` reverts an unknown side. */
  setSide: (id: number, side: number | null) => void
  /** Re-arm check for a fired `rearm` alert (Rust decides). */
  rearm?: (id: number, px: number) => void
  evaluate?: typeof evaluateDefault
  /** Resolve a by-reference alert's level right now (apex / flip / expected move / fib / ATR). Absent = every alert uses its stored price. */
  levelFor?: (a: Alert) => Resolved
  /** The reference moved: store the new level and the side relative to it. The alert never fires on its own move. */
  follow?: (id: number, level: number, side: Side) => void
  /** The reference vanished: auto-snooze with ONE level-gone event (Rust makes it exactly once). */
  levelGone?: (a: Alert, px: number) => Promise<void>
  sessionSnoozed?: ReadonlySet<number>
}

export interface TickReport {
  evaluated: number
  fired: AlertEvent[]
  errors: number
  /** By-reference alerts whose level vanished (one report each). */
  gone: number
}

/** Last trade, else the bid/ask mid; null when neither is a positive number. */
export function quotePx(q: RhQuote): number | null {
  const last = q.last_trade_price
  if (last !== null && Number.isFinite(last) && last > 0) return last
  const { bid_price: b, ask_price: a } = q
  if (b !== null && a !== null && Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) return (b + a) / 2
  return null
}

/**
 * `meta.startedAt` is when the fetch began: Robinhood quotes carry no timestamp of their own, so the age handed to `evaluate` is the time
 * since the request went out (a slow or stalled poll counts as stale).
 */
export async function runAlertTick(alerts: readonly Alert[], quotes: readonly RhQuote[], meta: { startedAt: number }, deps: EngineDeps): Promise<TickReport> {
  const report: TickReport = { evaluated: 0, fired: [], errors: 0, gone: 0 }
  const px = new Map<string, number>()
  for (const q of quotes) {
    const p = quotePx(q)
    if (p !== null) px.set(q.symbol, p)
  }
  if (px.size === 0) return report
  const evaluate = deps.evaluate ?? evaluateDefault
  const now = deps.now()
  const session = deps.session(now)
  const age = Math.max(0, (now - meta.startedAt) / 1000)
  for (const a of alerts) {
    // only price alerts are quote-driven; verdict / P&L / IV / earnings / order alerts have their own feeds
    if (a.kind !== 'price') continue
    const p = px.get(a.symbol)
    if (p === undefined || !a.enabled) continue
    if (!a.armed) {
      if (a.repeat === 'rearm' && deps.rearm && retreated(a, p)) deps.rearm(a.id, p)
      continue
    }
    if (!isTracked(a, now)) continue
    if (deps.levelFor && isRefAlert(a)) {
      const r = deps.levelFor(a)
      if (r.state === 'gone') {
        if (!isSnoozed(a, now, deps.sessionSnoozed) && deps.levelGone) {
          report.gone += 1
          try {
            await deps.levelGone(a, p)
          } catch {
            report.errors += 1
          }
        }
        continue
      }
      if (r.state === 'ok' && Math.abs(r.level - a.price) > 1e-9) {
        deps.follow?.(a.id, r.level, sideOf(p, r.level))
        continue
      }
    }
    report.evaluated += 1
    const r = evaluate(a, { px: p, prevSide: a.last_side as Side | null, quoteAgeS: age, sessionOpen: session.open, extendedOnly: session.extendedOnly })
    if (!r.fire) {
      if (r.observed && r.side !== a.last_side) deps.setSide(a.id, r.side)
      continue
    }
    // The side moves first (synchronously), so a second poll arriving while the fire call is in flight sees no flip. Rust's guard is the real protection.
    deps.setSide(a.id, r.side)
    if (isSnoozed(a, now, deps.sessionSnoozed)) continue
    try {
      const out = await deps.fire(a.id, r.side, p, age)
      if (out.outcome === 'fired') report.fired.push(out.event)
    } catch {
      report.errors += 1
      deps.setSide(a.id, a.last_side)
    }
  }
  return report
}
