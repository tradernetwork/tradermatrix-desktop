/** What the alert engine knows about a symbol's levels (M17 task 7): TraderMatrix data from the TM store (when fresh) plus the chart's Fib/ATR rows, which the chart publishes. INFORM ONLY. */
import type { LevelSnap } from '../alerts/levelRefs'
import { useTmStore } from './tm'

/** TM data older than this is treated as "not loaded" (the overlay toggles that refresh it may be off), never as a vanished level. */
export const TM_FRESH_MS = 600_000

const desk = new Map<string, LevelSnap['desk']>()

export function setDeskLevels(symbol: string, d: LevelSnap['desk']): void {
  if (d === null) desk.delete(symbol)
  else desk.set(symbol, d)
}

export function clearDeskLevels(): void {
  desk.clear()
}

export function snapFor(symbol: string, now: number = Date.now()): LevelSnap {
  const e = useTmStore.getState().bySymbol[symbol]
  const fresh = <T,>(leg: { data: T | null; at: number } | undefined): T | null => (leg?.data && now - leg.at < TM_FRESH_MS ? leg.data : null)
  return { apex: fresh(e?.apex), move: fresh(e?.move), desk: desk.get(symbol) ?? null }
}
