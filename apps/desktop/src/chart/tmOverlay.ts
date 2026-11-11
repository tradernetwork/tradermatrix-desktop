/**
 * Pure planner for the TraderMatrix chart overlay: Apex levels, gamma flip and expected-move bands as draw ops.
 * No canvas, no KLineChart types. Levels are dashed lines with a FILLED chip at the left edge (desk style). These are POSITIONING maps (where options open interest and hedging concentrate),
 * never targets or forecasts, and they add nothing to the y-axis range (the indicator has no figures).
 */
import type { ApexLevel, ApexLevels, ExpectedMove, TmBand } from '../lib/api'
import type { DrawOp, Mapper } from './drawPlan'

export interface TmOverlayData {
  apex?: ApexLevels | null
  move?: ExpectedMove | null
  /** Horizon label, e.g. "1 week". An unknown label draws no band. */
  horizon: string
  show: { apex: boolean; flip: boolean; move: boolean }
  colors?: Partial<TmOverlayColors>
}

/** Desk level colors (tokens --tm-hot / --tm-support / --tm-flip / --tm-range / --tm-chip-ink). `ink` is the dark text on a chip. */
export interface TmOverlayColors {
  /** resistance / call wall: levels above the last price */
  hot: string
  /** support / put wall: levels below the last price */
  support: string
  flip: string
  range: string
  ink: string
}

export const TM_DEFAULT_COLORS: TmOverlayColors = { hot: '#ff8000', support: '#00e070', flip: '#b45bff', range: '#4f86ff', ink: '#070E1F' }

export const MAX_LEVELS = 8
/** Chip height in px and the least distance between two chip centres. */
export const CHIP_H = 14
export const MIN_LABEL_GAP = CHIP_H + 1
const LABEL_PAD = 4
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Trimmed price text: 355 -> "355", 362.5 -> "362.5". */
export const fmtLevel = (n: number): string => String(Number(n.toFixed(2)))

/**
 * Spread label baselines so neighbours are at least `gap` apart, keeping their order. Pushes down from the top,
 * then pulls back up if the stack ran past `bottom`. The result is aligned with the input order.
 */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const idx = ys.map((_, i) => i).sort((a, b) => ys[a]! - ys[b]! || a - b)
  const out = ys.map((y) => Math.min(Math.max(y, top), bottom))
  for (let k = 1; k < idx.length; k++) {
    const i = idx[k]!
    const prev = out[idx[k - 1]!]!
    if (out[i]! < prev + gap) out[i] = prev + gap
  }
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k]!
    const limit = k === idx.length - 1 ? bottom : out[idx[k + 1]!]! - gap
    if (out[i]! > limit) out[i] = limit
  }
  return out
}

interface Pending {
  text: string
  y: number
  color: string
}

const bandOk = (b: TmBand | null | undefined): b is { low: number; high: number } => !!b && fin(b.low) && fin(b.high) && b.low <= b.high

export function planTmOverlay(data: TmOverlayData, m: Mapper, spot: number): DrawOp[] {
  const c = { ...TM_DEFAULT_COLORS, ...data.colors }
  const ops: DrawOp[] = []
  const x0 = m.left ?? m.x(m.from)
  const x1 = m.right ?? m.x(m.to)
  const top = m.top ?? -Infinity
  const bottom = m.bottom ?? Infinity
  if (!fin(x0) || !fin(x1) || x1 <= x0) return ops
  const inside = (y: number) => fin(y) && y >= top && y <= bottom
  const labTop = (fin(top) ? top : 0) + CHIP_H / 2
  const labBottom = fin(bottom) ? bottom - CHIP_H / 2 : Number.MAX_SAFE_INTEGER

  // All level chips (apex, flip, expected-move edges) share one spread pass so they never overlap. Chips sit at the LEFT edge.
  const chips: Pending[] = []

  // ---- expected-move bands first, so lines and chips sit on top ----
  if (data.show.move && data.move) {
    const h = data.move.horizons.find((x) => x.label === data.horizon)
    const last = m.last ?? m.to
    const bx0 = Math.max(x0, m.x(last))
    if (h && fin(bx0) && bx0 < x1) {
      const band = (b: TmBand | null, alpha: number, tag: string) => {
        if (!bandOk(b)) return
        const yh = m.y(b.high)
        const yl = m.y(b.low)
        if (!fin(yh) || !fin(yl)) return
        const t = Math.max(Math.min(yh, yl), top)
        const bt = Math.min(Math.max(yh, yl), bottom)
        if (bt <= t) return // fully outside the visible price range
        ops.push({ kind: 'rect', x: bx0, y: t, w: x1 - bx0, h: bt - t, color: c.range, alpha })
        chips.push({ text: `EM ${tag} ${fmtLevel(b.low)}-${fmtLevel(b.high)}`, y: t + CHIP_H / 2 + 1, color: c.range })
      }
      band(h.band95, 0.06, '95%')
      band(h.band68, 0.12, '68%')
    }
  }

  // ---- gamma flip and apex lines ----
  const apex = data.apex
  if (apex) {
    if (data.show.flip && fin(apex.gamma_flip)) {
      const y = m.y(apex.gamma_flip)
      if (inside(y)) {
        ops.push({ kind: 'hline', y, color: c.flip, width: 1.5, dash: [6, 4], x0, x1 })
        chips.push({ text: `γ FLIP ${apex.gamma_flip.toFixed(2)}`, y, color: c.flip })
      }
    }
    if (data.show.apex) {
      const usable = apex.levels
        .filter((l): l is ApexLevel & { strike: number; score: number } => fin(l.strike) && fin(l.score))
        .sort((a, b) => b.score - a.score || (a.rank ?? 99) - (b.rank ?? 99))
        .slice(0, MAX_LEVELS)
      for (const l of usable) {
        const y = m.y(l.strike)
        if (!inside(y)) continue
        const above = fin(spot) ? l.strike > spot : l.is_above_spot === true
        const color = above ? c.hot : c.support
        const width = 1 + 2 * Math.min(1, Math.max(0, l.score / 100))
        ops.push({ kind: 'hline', y, color, width, dash: [5, 4], x0, x1, alpha: 0.8 })
        chips.push({ text: `APEX ${fmtLevel(l.strike)} · ${fmtLevel(l.score)}`, y, color })
      }
    }
  }
  const ys = spreadLabels(chips.map((l) => l.y), MIN_LABEL_GAP, labTop, labBottom)
  chips.forEach((l, i) => {
    if (fin(ys[i]!)) ops.push({ kind: 'chip', text: l.text, x: x0 + LABEL_PAD, y: ys[i]!, color: l.color, ink: c.ink })
  })
  return ops.filter((op) => Object.values(op).every((v) => typeof v !== 'number' || Number.isFinite(v)))
}
