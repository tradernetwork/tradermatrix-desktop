/** Pure overlay computation: bars + timeframe + options -> everything the planner draws. Data space only. */
import type { Candle, TimeframeId } from '../bars'
import { atrLevels, type AtrLevels, type Side } from './atr'
import { computeFib, rangePosition, type Fib } from './fib'
import { computeFvg, type FvgBox } from './fvg'
import { htfSwing } from './htf'
import { rma, sma, tr } from './ta'
import { tfRow } from './tfTable'

export interface OverlayOptions {
  lookbackOverride: number | null
  narrow: boolean
  side: Side
  /** Run the FVG engine (skipped when no layer needs it). */
  fvg: boolean
  fvgMaxBoxes?: number
}

export interface OverlayOutput {
  fib: Fib | null
  /** Header chip: position of the HTF close in the swing (NaN when unknown). */
  rangePos: number
  /** All unmitigated gaps (the faithful engine); the planner applies the display limiter. */
  fvg: FvgBox[]
  sma: { p20: number[]; p50: number[]; p200: number[] }
  atr: { len: number; value: number; levels: AtrLevels } | null
  /** ATR(len) at the last bar even when no level can be drawn (NaN: not enough bars). */
  atrLen: number
  atrValue: number
  htfFallback: boolean
  lookback: number
  /** Last bar's close (the limiter and ATR anchor); NaN with no bars. */
  close: number
}

export function computeOverlay(bars: readonly Candle[], tf: TimeframeId, o: OverlayOptions): OverlayOutput {
  const row = tfRow(tf, o.lookbackOverride)
  const n = bars.length
  const close = n > 0 ? bars[n - 1]!.close : NaN
  const closes = bars.map((b) => b.close)
  const swing = htfSwing(bars, tf, row.lookback)
  const fib = computeFib(swing.swingHigh, swing.swingLow, close, row.show886)
  const atrSeries = rma(tr(bars), row.atrLen)
  const atrValue = n > 0 ? atrSeries[n - 1]! : NaN
  const levels = atrLevels(close, atrValue, o.side, o.narrow)
  return {
    fib,
    rangePos: rangePosition(swing.htfClose, swing.swingHigh, swing.swingLow),
    fvg: o.fvg ? computeFvg(bars, { vgN: row.vgN, vgF: row.vgF, maxBoxes: o.fvgMaxBoxes }) : [],
    sma: { p20: sma(closes, 20), p50: sma(closes, 50), p200: sma(closes, 200) },
    atr: levels ? { len: row.atrLen, value: atrValue, levels } : null,
    atrLen: row.atrLen,
    atrValue,
    htfFallback: swing.htfFallback,
    lookback: row.lookback,
    close,
  }
}

type KeyBar = Pick<Candle, 'timestamp' | 'open' | 'high' | 'low' | 'close'>

/** Memo key: options, timeframe, bar count, first timestamp and the last bar's OHLC. Panning changes none of these. */
export function overlayKey(bars: readonly KeyBar[], tf: TimeframeId, o: OverlayOptions): string {
  const n = bars.length
  const l = bars[n - 1]
  return `${JSON.stringify(o)}|${tf}|${n}|${bars[0]?.timestamp ?? ''}|${l ? `${l.open},${l.high},${l.low},${l.close}` : ''}`
}

export function createOverlayMemo() {
  let key = ''
  let value: OverlayOutput | null = null
  const memo = {
    computes: 0,
    get(bars: readonly Candle[], tf: TimeframeId, o: OverlayOptions): OverlayOutput {
      const k = overlayKey(bars, tf, o)
      if (value && k === key) return value
      memo.computes++
      key = k
      value = computeOverlay(bars, tf, o)
      return value
    },
  }
  return memo
}
