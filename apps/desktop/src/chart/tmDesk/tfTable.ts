/**
 * Per-timeframe parameters of the desk overlay: higher-timeframe selector, lookback bars, ATR length and fair-value-gap noise settings.
 * Pure data space: no pixels, no DOM.
 */
import type { TimeframeId } from '../bars'

export interface TfRow {
  /** The higher timeframe the swing is read from (Pine `request.security` timeframe). */
  sel: string
  /** Swing lookback in CHART bars. */
  lookback: number
  atrLen: number
  /** Fair-value-gap noise length / factor. */
  vgN: number
  vgF: number
  /** 0.886 fib shown only on weekly and monthly. */
  show886: boolean
}

// id -> [sel, lookback, atrLen]. 1m and 3m both read a 3m HTF; 10m/15m/30m read 30m.
const TABLE: Record<TimeframeId, [string, number, number]> = {
  '1m': ['3', 250, 250],
  '3m': ['3', 250, 250],
  '5m': ['5', 200, 200],
  '10m': ['30', 200, 175],
  '15m': ['30', 200, 175],
  '30m': ['30', 200, 175],
  '1h': ['60', 200, 150],
  '2h': ['120', 200, 100],
  '4h': ['240', 200, 75],
  '1D': ['D', 100, 34],
  '1W': ['W', 200, 21],
  '1M': ['M', 50, 21],
}

const MINUTES: Record<TimeframeId, number> = { '1m': 1, '3m': 3, '5m': 5, '10m': 10, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '1D': 1440, '1W': 10080, '1M': 43200 }

export const clampLookback = (n: number): number => Math.min(500, Math.max(5, Math.round(n)))

export function tfRow(id: TimeframeId, lookbackOverride?: number | null): TfRow {
  const [sel, lookback, atrLen] = TABLE[id]
  const hi = MINUTES[id] >= 60
  return {
    sel,
    lookback: typeof lookbackOverride === 'number' && Number.isFinite(lookbackOverride) ? clampLookback(lookbackOverride) : lookback,
    atrLen,
    vgN: hi ? 100 : 500,
    vgF: hi ? 1 : 2,
    show886: id === '1W' || id === '1M',
  }
}

const MIN_MS = 60_000
const DAY_MS = 86_400_000

/** Nominal duration of a Pine HTF selector in ms (M is 30 days nominal; the real bucketing is calendar, see htf.ts). */
export function htfMs(sel: string): number {
  switch (sel) {
    case 'D':
      return DAY_MS
    case 'W':
      return 7 * DAY_MS
    case 'M':
      return 30 * DAY_MS
    default: {
      const m = Number(sel)
      return Number.isFinite(m) && m > 0 ? m * MIN_MS : DAY_MS
    }
  }
}
