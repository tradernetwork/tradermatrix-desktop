/** Small pure helpers between the alerts store and the chart (M17 task 6). INFORM ONLY. */
import { isSnoozed } from '../alerts/active'
import { refText } from '../alerts/levelRefs'
import type { Alert } from '../alerts/types'
import type { AlertLineItem } from './alertLines'

/** The alerts of one symbol as chart lines: price alerts only (verdict / P&L / IV / earnings / order alerts have no price line). */
export function alertItemsFor(alerts: readonly Alert[], symbol: string, now: number, sessionSnoozed: ReadonlySet<number>, flashIds: ReadonlySet<number>): AlertLineItem[] {
  return alerts
    .filter((a) => a.symbol === symbol && a.kind === 'price' && a.enabled)
    .map((a) => ({
      id: a.id,
      price: a.price,
      dir: a.dir,
      state: !a.armed ? ('off' as const) : isSnoozed(a, now, sessionSnoozed) ? ('snoozed' as const) : ('armed' as const),
      flash: flashIds.has(a.id),
      tag: a.ref_kind === 'price' ? '' : refText(a),
    }))
}

/** "Alert at 190.00" goes up when the price is above the last, down when below, either at the last. */
export function dirForPrice(price: number, last: number | null): 'up' | 'down' | 'either' {
  if (last === null || !Number.isFinite(last) || price === last) return 'either'
  return price > last ? 'up' : 'down'
}

/** The alert whose line is within `tolPx` of `y`, nearest first (by-pixel hit test for dragging the chip). */
export function hitAlert(items: readonly AlertLineItem[], y: number, yOf: (p: number) => number, tolPx = 8): number | null {
  let best: { id: number; d: number } | null = null
  for (const i of items) {
    const d = Math.abs(yOf(i.price) - y)
    if (Number.isFinite(d) && d <= tolPx && (best === null || d < best.d)) best = { id: i.id, d }
  }
  return best?.id ?? null
}
