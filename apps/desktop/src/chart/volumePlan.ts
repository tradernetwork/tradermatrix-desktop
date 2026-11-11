/** Pure column geometry for the volume pane (the indicator's draw hook only paints these rectangles). */
import type { Candle } from './bars'
import { splitVolume } from './volumeSplit'

export interface VolRect {
  x: number
  y: number
  w: number
  h: number
  color: string
}

export interface VolGeometry {
  /** Pixel x of the bar CENTER for a data index. */
  x: (i: number) => number
  /** Pixel y for a volume value. */
  y: (v: number) => number
  /** Pixel y of the zero line (bottom of the columns). */
  yBase: number
  /** Column width in px. */
  barW: number
  /** Visible index range, inclusive; clamped to the data. */
  from: number
  to: number
}

export interface VolColors {
  up: string
  down: string
  buy: string
  sell: string
}

/**
 * 'vol': one column per bar (up color when close >= open). 'split': a buy column from the base with the sell column
 * stacked on top; together they are as tall as the total. Zero or unusable volume draws nothing.
 */
export function planVolume(bars: readonly Candle[], mode: 'vol' | 'split', g: VolGeometry, colors: VolColors): VolRect[] {
  const out: VolRect[] = []
  const from = Math.max(0, Math.floor(g.from))
  const to = Math.min(bars.length - 1, Math.floor(g.to))
  const col = (cx: number, top: number, bottom: number, color: string) => {
    const h = bottom - top
    if (!Number.isFinite(cx) || !Number.isFinite(top) || !Number.isFinite(bottom) || !(h > 0)) return
    out.push({ x: cx - g.barW / 2, y: top, w: g.barW, h, color })
  }
  for (let i = from; i <= to; i++) {
    const b = bars[i]!
    const s = splitVolume(b)
    if (s.total === 0) continue
    const cx = g.x(i)
    if (mode === 'vol') {
      col(cx, g.y(s.total), g.yBase, b.close >= b.open ? colors.up : colors.down)
    } else {
      const buyTop = g.y(s.buy)
      col(cx, buyTop, g.yBase, colors.buy)
      col(cx, g.y(s.total), buyTop, colors.sell)
    }
  }
  return out
}
