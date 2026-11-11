/**
 * Higher-timeframe swing, ported from the Pine `request.security(..., lookahead_off)` + `ta.highest/lowest`.
 *
 * The HTF series is rebuilt from the CHART bars: bars are bucketed by floor(ts / htfMs) and each bucket carries a running
 * high/low (the developing HTF bar, which is what lookahead_off shows on the live bar). That series is STEPPED (one value per
 * chart bar), and the swing is the max/min of it over the last `lookback` CHART bars (not a raw window max of the chart).
 *
 * Divergence from TradingView: buckets sit on the UTC epoch grid (calendar-month for "M", Monday-aligned weeks), not on
 * the exchange session grid, so an intraday HTF bar can start at a different minute than TradingView draws it.
 */
import type { TimeframeId } from '../bars'
import { timeframeById, type Candle } from '../bars'
import { htfMs, tfRow } from './tfTable'

export interface HtfSwing {
  swingHigh: number
  swingLow: number
  /** Close of the developing HTF bar at the last chart bar (= last chart close). */
  htfClose: number
  /** The chart timeframe is coarser than the selected HTF, so chart high/low were used. */
  htfFallback: boolean
}

const DAY = 86_400_000
const WEEK_OFFSET = 4 * DAY // epoch day 0 is a Thursday; shift so weeks start on Monday

function bucketKey(ts: number, sel: string): number {
  if (sel === 'M') {
    const d = new Date(ts)
    return d.getUTCFullYear() * 12 + d.getUTCMonth()
  }
  if (sel === 'W') return Math.floor((ts + WEEK_OFFSET) / (7 * DAY))
  return Math.floor(ts / htfMs(sel))
}

export function htfSwing(bars: readonly Pick<Candle, 'timestamp' | 'high' | 'low' | 'close'>[], tf: TimeframeId, lookback: number, selOverride?: string): HtfSwing {
  const none: HtfSwing = { swingHigh: NaN, swingLow: NaN, htfClose: NaN, htfFallback: false }
  const n = bars.length
  if (n === 0 || n < lookback || !(lookback >= 1)) return none
  const sel = selOverride ?? tfRow(tf).sel
  const fallback = timeframeById(tf).barMs > htfMs(sel)
  const hi = new Array<number>(n)
  const lo = new Array<number>(n)
  let key = NaN
  let rh = NaN
  let rl = NaN
  for (let i = 0; i < n; i++) {
    const b = bars[i]!
    if (fallback) {
      rh = b.high
      rl = b.low
    } else {
      const k = bucketKey(b.timestamp, sel)
      if (k !== key) {
        key = k
        rh = b.high
        rl = b.low
      } else {
        rh = Math.max(rh, b.high)
        rl = Math.min(rl, b.low)
      }
    }
    hi[i] = rh
    lo[i] = rl
  }
  let swingHigh = -Infinity
  let swingLow = Infinity
  for (let i = n - lookback; i < n; i++) {
    swingHigh = Math.max(swingHigh, hi[i]!)
    swingLow = Math.min(swingLow, lo[i]!)
  }
  if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow)) return { ...none, htfFallback: fallback }
  return { swingHigh, swingLow, htfClose: bars[n - 1]!.close, htfFallback: fallback }
}
