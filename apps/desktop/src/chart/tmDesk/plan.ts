/**
 * Draw-op planner for the desk overlay. Takes the pure overlay output plus a pixel mapper and returns DrawOps. No canvas, no
 * KLineChart types. Nothing here feeds the y-axis (the indicator has no figures); lines and rects are clipped to the plot area.
 * Fib / ATR labels are plain mono text in the line color, right-aligned in the right gutter and spread by `spreadLabels`;
 * filled chips stay reserved for TM-sourced levels.
 */
import type { DrawOp } from '../drawPlan'
import { CHIP_H, MIN_LABEL_GAP, spreadLabels } from '../tmOverlay'
import { limitFvg } from './fvg'
import type { OverlayOutput } from './overlay'
import type { DeskSettings } from './deskSettings'

export interface DeskColors {
  cyan: string
  textSecondary: string
  textMuted: string
  purple: string
  bear: string
  bull: string
  warn: string
  /** Halo behind label text. */
  halo: string
}

/** Fallbacks matching tokens.css (--tm-cyan, --tm-text-secondary, --tm-text-muted, --tm-purple, --tm-bear, --tm-bull, --tm-warn, --tm-surface-1). */
export const DESK_COLORS: DeskColors = {
  cyan: '#5fb3d9',
  textSecondary: '#8ea3c4',
  textMuted: '#6c7a92',
  purple: '#b49ae0',
  bear: '#f43f5e',
  bull: '#22c55e',
  warn: '#d6a73a',
  halo: '#0a0e17',
}

export interface DeskMapper {
  /** Pixel x of a data index; must extrapolate past the last bar (KLineChart's does: linear, no clamp). */
  x(index: number): number
  y(value: number): number
  from: number
  to: number
  last: number
  left: number
  right: number
  top: number
  bottom: number
  /** Pixels per bar. */
  barSpace: number
}

export type DeskView = Pick<DeskSettings, 'fib' | 'fvg' | 'sma'> & {
  /** ATR levels shown (already resolved from off/auto/on). */
  atrOn: boolean
  /** Pane height in px; defaults to bottom - top. */
  paneHeight?: number
}

const fin = Number.isFinite
export const EXTENSION_BARS = 25
export const GUTTER_PAD = 4
const MIN_PANE_HEIGHT = 400
const MIN_BAR_PX = 3
const LABEL_FONT = "10px 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Intersect a rect with the plot area; null when nothing is left or an input is not finite. */
export function clipRect(x: number, y: number, w: number, h: number, m: { left: number; right: number; top: number; bottom: number }): Rect | null {
  if (![x, y, w, h, m.left, m.right, m.top, m.bottom].every(fin)) return null
  const x0 = Math.max(x, m.left)
  const y0 = Math.max(y, m.top)
  const x1 = Math.min(x + w, m.right)
  const y1 = Math.min(y + h, m.bottom)
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const KEY_RATIOS = new Set([0.382, 0.5, 0.618])
const MAJOR_RATIOS = new Set([0, 0.5, 1, 0.618])
const fmtRatio = (r: number) => String(r)

interface Lbl {
  text: string
  y: number
  color: string
  alpha: number
}

export function planDesk(out: OverlayOutput, m: DeskMapper, c: DeskColors, v: DeskView): DrawOp[] {
  const ops: DrawOp[] = []
  if (![m.left, m.right, m.top, m.bottom, m.barSpace].every(fin) || m.right <= m.left) return ops
  const height = v.paneHeight ?? m.bottom - m.top
  const small = height < MIN_PANE_HEIGHT // only the golden zone survives a short pane
  const zoomedOut = m.barSpace < MIN_BAR_PX
  const inside = (y: number) => fin(y) && y >= m.top && y <= m.bottom
  const endX = Math.min(m.right, m.x(m.last + EXTENSION_BARS))
  const startIdx = m.last - out.lookback
  const fibX0 = Math.max(m.left, m.x(startIdx))
  const labels: Lbl[] = []

  const rect = (xa: number, xb: number, ya: number, yb: number, color: string, alpha: number) => {
    const r = clipRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya), m)
    if (r) ops.push({ kind: 'rect', ...r, color, alpha })
  }

  // ---- golden ("script") zone: fib mode "all" only, drawn behind everything ----
  if (v.fib === 'all' && out.fib && fin(endX)) rect(fibX0, endX, m.y(out.fib.zone.hi), m.y(out.fib.zone.lo), c.warn, 0.08)

  if (small) return finish(ops)

  // ---- fair-value gaps: nearest 3 above and 3 below, 6 at most ----
  if (v.fvg && !zoomedOut) {
    for (const b of limitFvg(out.fvg, { price: out.close, atr: out.atrValue })) {
      rect(m.x(b.left), m.x(b.right), m.y(b.top), m.y(b.bottom), b.bull ? c.bull : c.bear, 0.07)
    }
  }

  // ---- moving averages over the visible slice, split at NaN ----
  const smaLine = (vals: readonly number[], color: string) => {
    const lo = Math.max(0, Math.floor(m.from) - 1)
    const hi = Math.min(vals.length - 1, Math.ceil(m.to) + 1)
    let seg: [number, number][] = []
    const flush = () => {
      if (seg.length >= 2) ops.push({ kind: 'polyline', points: seg, color, width: 1 })
      seg = []
    }
    for (let i = lo; i <= hi; i++) {
      const x = m.x(i)
      const y = m.y(vals[i]!)
      if (fin(vals[i]!) && fin(x) && fin(y)) seg.push([x, y])
      else flush()
    }
    flush()
  }
  if (v.sma.p20 && !zoomedOut) smaLine(out.sma.p20, c.purple)
  if (v.sma.p50) smaLine(out.sma.p50, c.textMuted)
  if (v.sma.p200) smaLine(out.sma.p200, c.textSecondary)

  // ---- fib ladder ----
  if (v.fib !== 'off' && out.fib && fin(endX)) {
    for (const l of out.fib.levels) {
      if (v.fib === 'key' ? !KEY_RATIOS.has(l.ratio) : zoomedOut && !MAJOR_RATIOS.has(l.ratio)) continue
      const y = m.y(l.price)
      if (!inside(y)) continue
      const ext = l.kind === 'ext'
      const color = ext ? c.textSecondary : c.cyan
      const alpha = ext ? 0.8 : l.kind === 'golden' ? 0.7 : 0.35
      ops.push({ kind: 'hline', y, color, width: l.kind === 'golden' ? 1.5 : 1, dash: ext ? [6, 4] : [], x0: fibX0, x1: endX, alpha })
      labels.push({ text: `${fmtRatio(l.ratio)} ${l.price.toFixed(2)}`, y, color, alpha: ext ? 0.85 : 0.9 })
    }
  }

  // ---- ATR stop and targets: from the last bar, dotted ----
  if (v.atrOn && out.atr && fin(endX)) {
    const a = out.atr.levels
    const x0 = Math.max(m.left, m.x(m.last))
    const rows: [string, number, string, number][] = [
      ['SL', a.sl, c.bear, 1],
      ['TP1', a.tp1, c.bull, 1],
      ['TP2', a.tp2, c.bull, 0.7],
      ['TP3', a.tp3, c.bull, 0.5],
    ]
    for (const [name, price, color, alpha] of rows) {
      const y = m.y(price)
      if (!inside(y)) continue
      ops.push({ kind: 'hline', y, color, width: 1, dash: [2, 3], x0, x1: endX, alpha })
      labels.push({ text: `${name} ${price.toFixed(2)}`, y, color, alpha: 0.9 })
    }
  }

  // ---- labels: one spread pass, right-aligned in the gutter ----
  if (!zoomedOut && labels.length > 0) {
    const ys = spreadLabels(labels.map((l) => l.y), MIN_LABEL_GAP, m.top + CHIP_H / 2, m.bottom - CHIP_H / 2)
    labels.forEach((l, i) => {
      ops.push({ kind: 'label', text: l.text, x: m.right - GUTTER_PAD, y: ys[i]! + 3.5, color: l.color, align: 'right', alpha: l.alpha, halo: c.halo, font: LABEL_FONT })
    })
  }
  return finish(ops)
}

function finish(ops: DrawOp[]): DrawOp[] {
  return ops.filter((op) => Object.values(op).every((x) => typeof x !== 'number' || Number.isFinite(x)))
}
