/** The app-closed pass (M17 task 9): what crossed while the app was not running. Stored candles plus one fresh quote; events are stored with missed=1 and never notify. INFORM ONLY. */
import type { RhQuote, StoredCandle } from '../lib/api'
import { isSnoozed } from './active'
import { quotePx } from './engine'
import { sideOf } from './evaluate'
import type { Alert, AlertEvent, FireOutcome } from './types'

export interface Crossing {
  side: 1 | -1
  px: number
}

const dirOk = (dir: Alert['dir'], to: 1 | -1) => dir === 'either' || (dir === 'up' && to === 1) || (dir === 'down' && to === -1)

/** First candle after `sinceMs` that went through the level from the side the alert last saw. Touching is not crossing. Null for a never-observed alert. */
export function missedCross(a: Pick<Alert, 'price' | 'dir' | 'last_side'>, candles: readonly StoredCandle[], sinceMs: number): Crossing | null {
  if (a.last_side !== 1 && a.last_side !== -1) return null
  for (const c of [...candles].sort((x, y) => x.ts - y.ts)) {
    if (c.ts <= sinceMs) continue
    if (a.last_side === -1 && c.high > a.price && dirOk(a.dir, 1)) return { side: 1, px: c.high }
    if (a.last_side === 1 && c.low < a.price && dirOk(a.dir, -1)) return { side: -1, px: c.low }
  }
  return null
}

export interface MissedDeps {
  loadCandles: (a: Alert, fromMs: number) => Promise<StoredCandle[]>
  quotes: (symbols: string[]) => Promise<RhQuote[]>
  fire: (id: number, side: number, px: number, ageS: number, extra: { kind: string; label: string; missed: boolean }) => Promise<FireOutcome>
  /** When the app last ran (UTC ms). */
  since: number
  now?: () => number
}

export async function runMissedPass(alerts: readonly Alert[], d: MissedDeps): Promise<{ events: AlertEvent[] }> {
  const now = (d.now ?? Date.now)()
  const todo = alerts.filter((a) => a.kind === 'price' && a.enabled && a.armed && !isSnoozed(a, now) && !(a.expires_at !== null && a.expires_at <= now))
  const events: AlertEvent[] = []
  if (todo.length === 0) return { events }
  let quotes: RhQuote[] = []
  try {
    quotes = await d.quotes([...new Set(todo.map((a) => a.symbol))])
  } catch {
    /* candles alone still work */
  }
  const last = new Map<string, number>()
  for (const q of quotes) {
    const p = quotePx(q)
    if (p !== null) last.set(q.symbol, p)
  }
  for (const a of todo) {
    const since = Math.max(d.since, a.created_at)
    let hit: Crossing | null = null
    try {
      hit = missedCross(a, await d.loadCandles(a, since), since)
    } catch {
      /* no stored candles for this symbol */
    }
    if (!hit) {
      const p = last.get(a.symbol)
      if (p !== undefined && (a.last_side === 1 || a.last_side === -1)) {
        const s = sideOf(p, a.price)
        if (s !== 0 && s !== a.last_side && dirOk(a.dir, s)) hit = { side: s, px: p }
      }
    }
    if (!hit) continue
    const way = hit.side === 1 ? 'above' : 'below'
    try {
      const out = await d.fire(a.id, hit.side, hit.px, 0, { kind: 'missed', label: `${a.symbol} crossed ${way} ${a.price.toFixed(2)} while you were away`, missed: true })
      if (out.outcome === 'fired') events.push(out.event)
    } catch {
      /* one bad alert never stops the pass */
    }
  }
  return { events }
}
