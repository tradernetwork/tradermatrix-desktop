/** Pure triggers for the non-price alerts (M17 tasks 10 and 11): verdict change, P&L and IV-rank thresholds, earnings inside an expiry, order-state changes. INFORM ONLY. */
import { daysBetween, type Verdict } from '../lib/strikeCheck'
import { evaluate, type EvalResult } from './evaluate'
import type { AlertDir, Side } from './types'

/** A verdict alert fires when the verdict CHANGES into `target`; the first look only records, and `unknown` never counts (it keeps the last known verdict). */
export function verdictFire(prev: Verdict | null, next: Verdict, target: Verdict): { fire: boolean; next: Verdict } {
  if (next === 'unknown') return { fire: false, next: prev ?? 'unknown' }
  if (prev === null || prev === 'unknown') return { fire: false, next }
  return { fire: next !== prev && next === target, next }
}

/** Crossing of a signed level (P&L dollars, IV rank 0..100) with the same side rules as a price alert. */
export function evalLevelTrigger(level: number, dir: AlertDir, prevSide: Side | null, value: number): EvalResult {
  return evaluate({ price: level, dir, mode: 'cross', extended_hours: true }, { px: value, prevSide, quoteAgeS: 0, sessionOpen: true, signed: true })
}

/** Earnings date inside the trade: today <= date <= expiry (the expiry date itself counts). `withinDays` also requires it to be at most that many days away. */
export function earningsInside(date: string | null, expiry: string, today: string, withinDays?: number): boolean {
  if (!date || date < today || date > expiry) return false
  return withinDays === undefined || daysBetween(today, date) <= withinDays
}

export interface OrderSnap {
  id: string
  symbol: string | null
  state: string | null
}
export interface OrderChange {
  id: string
  symbol: string
  text: string
}

function orderText(state: string): string | null {
  const s = state.toLowerCase()
  if (s === 'filled') return 'order filled'
  if (s === 'rejected' || s === 'failed') return 'order rejected'
  if (s.includes('approv')) return s === 'approved' ? 'order approved' : s === 'declined' || s === 'denied' ? 'order declined' : 'order waiting for approval'
  return null
}

/** Changes between two order lists worth a notice. The first snapshot (prev null) is silent: an alert never reports history. */
export function diffOrders(prev: readonly OrderSnap[] | null, next: readonly OrderSnap[]): OrderChange[] {
  if (prev === null) return []
  const before = new Map(prev.map((o) => [o.id, o.state]))
  const out: OrderChange[] = []
  for (const o of next) {
    if (!o.state || before.get(o.id) === o.state) continue
    const t = orderText(o.state)
    if (t) out.push({ id: o.id, symbol: o.symbol ?? '', text: `${o.symbol ?? 'Order'} ${t}`.replace('Order order', 'Order') })
  }
  return out
}
