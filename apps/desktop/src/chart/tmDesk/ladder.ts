/**
 * Level ladder (M13): every point level in one collision-free right-gutter column. Pure data-space/pixel-space maths, no
 * React, no KLineChart types. The caller supplies `yOf` (price -> px in the candle pane).
 *
 * Rules: levels carry a source; priority is tm (Apex, gamma flip, expected-move edges) > atr > fib > fvg, then distance to the
 * current price, then rank. Only as many labels as fit (one per `minGap` px, "you are here" included) are drawn; the losers become
 * a thin tick at their true price, and ticks that would sit on top of another row are hidden. Labels are spread with the same
 * `spreadLabels` the chart overlays use. Filled chips are reserved for TraderMatrix-sourced levels (the M12 rule).
 * These are positioning/maths maps, not targets, and the ladder never touches the chart's y-axis range.
 */
import type { ApexLevels, ExpectedMove } from '../../lib/api'
import { fmtLevel, MIN_LABEL_GAP, spreadLabels } from '../tmOverlay'
import type { DeskSettings } from './deskSettings'
import type { OverlayOutput } from './overlay'
import { limitFvg } from './fvg'

export type LadderSource = 'tm' | 'fib' | 'atr' | 'fvg' | 'flip' | 'em'

export interface LadderLevel {
  price: number
  label: string
  source: LadderSource
  /** Lower wins within a source and breaks ties at the same price. */
  rank: number
}

export interface LadderRow {
  kind: 'level' | 'here' | 'tick'
  price: number
  label: string
  source: LadderSource | 'here'
  rank: number
  /** True price position (px). */
  y: number
  /** Label centre after the spread (px); equals `y` for ticks. */
  labelY: number
  /** Filled chip: TraderMatrix-sourced levels only. */
  chip: boolean
}

export interface LadderOpts {
  yOf: (price: number) => number
  /** Plot area in px; default 0..heightPx. */
  top?: number
  bottom?: number
  /** Least distance between two label centres. Default MIN_LABEL_GAP (15 px, above the 14 px floor). */
  minGap?: number
}

/** Below this pane height only TraderMatrix-sourced levels are listed. */
export const LADDER_MIN_FULL_HEIGHT = 400

const PRIORITY: Record<LadderSource, number> = { tm: 0, flip: 0, em: 0, atr: 1, fib: 2, fvg: 3 }
export const isTmSource = (s: LadderSource | 'here'): boolean => s === 'tm' || s === 'flip' || s === 'em'

const fin = Number.isFinite

export function buildLadder(levels: readonly LadderLevel[], price: number, heightPx: number, opts: LadderOpts): LadderRow[] {
  const top = opts.top ?? 0
  const bottom = opts.bottom ?? heightPx
  const gap = opts.minGap ?? MIN_LABEL_GAP
  if (!fin(top) || !fin(bottom) || bottom <= top || !fin(gap) || gap <= 0) return []
  const inPlot = (y: number) => fin(y) && y >= top && y <= bottom
  const tmOnly = heightPx < LADDER_MIN_FULL_HEIGHT

  // "you are here": always listed when the price is known (clamped into the plot so it is never lost off-screen)
  const yHereRaw = fin(price) ? opts.yOf(price) : NaN
  const hasHere = fin(price) && fin(yHereRaw)
  const yHere = hasHere ? Math.min(Math.max(yHereRaw, top), bottom) : (top + bottom) / 2

  const seen = new Set<string>()
  const cands: { l: LadderLevel; y: number; order: number }[] = []
  levels.forEach((l, order) => {
    if (!fin(l.price) || (tmOnly && !isTmSource(l.source))) return
    const k = `${l.source}|${l.label}|${l.price}`
    if (seen.has(k)) return
    seen.add(k)
    const y = opts.yOf(l.price)
    if (inPlot(y)) cands.push({ l, y, order })
  })

  const capacity = Math.floor((bottom - top) / gap)
  const slots = Math.max(0, capacity - (hasHere ? 1 : 0))
  const ranked = [...cands].sort(
    (a, b) => PRIORITY[a.l.source] - PRIORITY[b.l.source] || Math.abs(a.y - yHere) - Math.abs(b.y - yHere) || a.l.rank - b.l.rank || a.order - b.order,
  )
  const kept = ranked.slice(0, slots)
  const demoted = ranked.slice(slots)

  // labels: kept levels plus the "here" row, ordered by true position then rank, spread in one pass
  type Lab = { kind: 'level' | 'here'; l: LadderLevel | null; y: number; order: number }
  const labs: Lab[] = kept.map((c) => ({ kind: 'level', l: c.l, y: c.y, order: c.order }))
  if (hasHere) labs.push({ kind: 'here', l: null, y: yHere, order: -1 })
  labs.sort((a, b) => a.y - b.y || (a.l?.rank ?? -1) - (b.l?.rank ?? -1) || a.order - b.order)
  const lo = top + gap / 2
  const hi = Math.max(lo, bottom - gap / 2)
  const ys = spreadLabels(labs.map((x) => x.y), gap, lo, hi)
  const rows: LadderRow[] = labs.map((x, i) =>
    x.kind === 'here'
      ? { kind: 'here', price, label: fmtLevel(price), source: 'here', rank: -1, y: x.y, labelY: ys[i]!, chip: false }
      : { kind: 'level', price: x.l!.price, label: x.l!.label, source: x.l!.source, rank: x.l!.rank, y: x.y, labelY: ys[i]!, chip: isTmSource(x.l!.source) },
  )

  // ticks: demoted levels at their true price, hidden when another row (label or tick) already sits within 2 px
  const taken = rows.map((r) => r.y)
  for (const c of demoted) {
    if (taken.some((t) => Math.abs(t - c.y) < 2)) continue
    taken.push(c.y)
    rows.push({ kind: 'tick', price: c.l.price, label: c.l.label, source: c.l.source, rank: c.l.rank, y: c.y, labelY: c.y, chip: false })
  }
  return rows.sort((a, b) => a.labelY - b.labelY || a.rank - b.rank)
}

// ---------------------------------------------------------------------------------------------------------------------------
// Which levels the ladder lists: the same sources the chart layers draw, honoring the same toggles.

const KEY_RATIOS = new Set([0.382, 0.5, 0.618])
const fmt2 = (n: number) => n.toFixed(2)

export interface LadderSources {
  apex: ApexLevels | null
  move: ExpectedMove | null
  /** TM toggles (settings). */
  tm: { apex: boolean; flip: boolean; move: boolean; horizon: string }
  desk: Pick<DeskSettings, 'fib' | 'fvg'>
  /** ATR levels shown (resolved from off/auto/on). */
  atrOn: boolean
  /** Desk overlay output for the chart's bars; null when there are no bars yet. */
  overlay: OverlayOutput | null
}

export function collectLadderLevels(s: LadderSources): LadderLevel[] {
  const out: LadderLevel[] = []
  const a = s.apex
  if (a && s.tm.apex) {
    const usable = a.levels
      .filter((l): l is typeof l & { strike: number; score: number } => fin(l.strike as number) && fin(l.score as number))
      .sort((x, y) => y.score - x.score || (x.rank ?? 99) - (y.rank ?? 99))
      .slice(0, 8)
    usable.forEach((l, i) => out.push({ price: l.strike, label: `APEX ${fmtLevel(l.strike)}`, source: 'tm', rank: l.rank ?? i + 1 }))
  }
  if (a && s.tm.flip && a.gamma_flip !== null && fin(a.gamma_flip)) out.push({ price: a.gamma_flip, label: `FLIP ${fmt2(a.gamma_flip)}`, source: 'flip', rank: 0 })
  if (s.move && s.tm.move) {
    const h = s.move.horizons.find((x) => x.label === s.tm.horizon)
    const edge = (b: { low: number | null; high: number | null } | null, tag: string, rank: number) => {
      if (!b || b.low === null || b.high === null || !fin(b.low) || !fin(b.high)) return
      out.push({ price: b.high, label: `EM${tag} ${fmtLevel(b.high)}`, source: 'em', rank })
      out.push({ price: b.low, label: `EM${tag} ${fmtLevel(b.low)}`, source: 'em', rank })
    }
    if (h) {
      edge(h.band68, '68', 1)
      edge(h.band95, '95', 2)
    }
  }
  const o = s.overlay
  if (o) {
    if (s.desk.fib !== 'off' && o.fib) {
      for (const l of o.fib.levels) {
        if (s.desk.fib === 'key' && !KEY_RATIOS.has(l.ratio)) continue
        out.push({ price: l.price, label: `${l.ratio} ${fmt2(l.price)}`, source: 'fib', rank: l.ratio })
      }
    }
    if (s.atrOn && o.atr) {
      const t = o.atr.levels
      out.push({ price: t.sl, label: `SL ${fmt2(t.sl)}`, source: 'atr', rank: 0 })
      out.push({ price: t.tp1, label: `TP1 ${fmt2(t.tp1)}`, source: 'atr', rank: 1 })
      out.push({ price: t.tp2, label: `TP2 ${fmt2(t.tp2)}`, source: 'atr', rank: 2 })
      out.push({ price: t.tp3, label: `TP3 ${fmt2(t.tp3)}`, source: 'atr', rank: 3 })
    }
    if (s.desk.fvg) {
      limitFvg(o.fvg, { price: o.close, atr: o.atrValue }).forEach((b, i) => {
        // the edge facing the price is the one that matters
        const p = Math.abs(b.top - o.close) <= Math.abs(b.bottom - o.close) ? b.top : b.bottom
        out.push({ price: p, label: `FVG ${b.bull ? '+' : '-'} ${fmt2(p)}`, source: 'fvg', rank: i })
      })
    }
  }
  return out.filter((l) => fin(l.price))
}
