/**
 * Fair-value-gap ("volume gap") engine, bull and bear gap arrays with 50% mitigation, plus a display limiter.
 * gap = |close - open|; rgap[i] = body[i-1] / sma(body, vgN)[i-1]. Bull at i: low[i] > high[i-2] and rgap > vgF
 * (box left i-2, right i+1, top low[i], bottom high[i-2]); bear mirrors. Per bar: create, then sweep every box (a new box is
 * swept on its own bar): a bear box dies when high > mid, a bull box when low < mid (strict), survivors extend to i+1; the
 * oldest box of a side is shifted out past `maxBoxes`. Indices only, no pixels.
 */
import type { Candle } from '../bars'
import { sma } from './ta'

export interface FvgBox {
  /** Data index of the left edge (i-2). */
  left: number
  /** Data index of the right edge (last bar + 1 for survivors). */
  right: number
  top: number
  bottom: number
  bull: boolean
  /** Volume of the bar at i-2 (the Pine box text). */
  vol: number
}

export interface FvgOptions {
  vgN: number
  vgF: number
  /** Cap per side (Pine: 500). */
  maxBoxes?: number
}

type Ohlcv = Pick<Candle, 'open' | 'high' | 'low' | 'close' | 'volume'>

export function computeFvg(bars: readonly Ohlcv[], o: FvgOptions): FvgBox[] {
  const n = bars.length
  const cap = o.maxBoxes ?? 500
  if (n < 3) return []
  const body = bars.map((b) => Math.abs(b.close - b.open))
  const avg = sma(body, o.vgN)
  const bulls: FvgBox[] = []
  const bears: FvgBox[] = []
  const sweep = (list: FvgBox[], i: number, bull: boolean) => {
    for (let k = list.length - 1; k >= 0; k--) {
      const bx = list[k]!
      const mid = (bx.top + bx.bottom) / 2
      const dead = bull ? bars[i]!.low < mid : bars[i]!.high > mid
      if (dead) list.splice(k, 1)
      else bx.right = i + 1
    }
    while (list.length > cap) list.shift()
  }
  for (let i = 2; i < n; i++) {
    const rgap = body[i - 1]! / avg[i - 1]!
    const b = bars[i]!
    const p2 = bars[i - 2]!
    if (rgap > o.vgF) {
      if (b.low > p2.high) bulls.push({ left: i - 2, right: i + 1, top: b.low, bottom: p2.high, bull: true, vol: p2.volume })
      if (b.high < p2.low) bears.push({ left: i - 2, right: i + 1, top: p2.low, bottom: b.high, bull: false, vol: p2.volume })
    }
    if (bears.length > 0) sweep(bears, i, false)
    if (bulls.length > 0) sweep(bulls, i, true)
  }
  return [...bulls, ...bears].sort((a, b) => a.left - b.left)
}

export interface LimitOptions {
  price: number
  atr: number
  /** Total kept (half above, half below the price). Default 6. */
  max?: number
  /** Minimum box height in ATR. Default 0.25. */
  minAtr?: number
}

/** Display limiter: drop gaps under minAtr * ATR, then keep the nearest max/2 boxes above and max/2 below the price. */
export function limitFvg(boxes: readonly FvgBox[], o: LimitOptions): FvgBox[] {
  const per = Math.floor((o.max ?? 6) / 2)
  const minH = Number.isFinite(o.atr) ? (o.minAtr ?? 0.25) * o.atr : 0
  const ok = boxes.filter((b) => b.top - b.bottom >= minH && Number.isFinite(b.top) && Number.isFinite(b.bottom))
  const mid = (b: FvgBox) => (b.top + b.bottom) / 2
  const near = (b: FvgBox) => Math.abs(mid(b) - o.price)
  const above = ok.filter((b) => mid(b) > o.price).sort((a, b) => near(a) - near(b)).slice(0, per)
  const below = ok.filter((b) => mid(b) <= o.price).sort((a, b) => near(a) - near(b)).slice(0, per)
  return [...below, ...above].sort((a, b) => a.left - b.left)
}
