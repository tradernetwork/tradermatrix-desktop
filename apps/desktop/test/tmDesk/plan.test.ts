import { describe, expect, it } from 'vitest'
import { paintOps } from '../../src/chart/paint'
import type { DrawOp } from '../../src/chart/drawPlan'
import { computeOverlay } from '../../src/chart/tmDesk/overlay'
import { clipRect, planDesk, DESK_COLORS, type DeskMapper, type DeskView } from '../../src/chart/tmDesk/plan'
import { DEFAULT_DESK_SETTINGS } from '../../src/chart/tmDesk/deskSettings'

describe('clipRect', () => {
  const m = { left: 0, right: 500, top: 0, bottom: 300 }
  it('clips the top', () => {
    expect(clipRect(10, -50, 100, 80, m)).toEqual({ x: 10, y: 0, w: 100, h: 30 })
  })
  it('clips x and bottom', () => {
    expect(clipRect(-20, 280, 600, 100, m)).toEqual({ x: 0, y: 280, w: 500, h: 20 })
  })
  it('fully outside is null', () => {
    expect(clipRect(10, -90, 100, 80, m)).toBeNull()
    expect(clipRect(600, 10, 10, 10, m)).toBeNull()
    expect(clipRect(10, 10, NaN, 10, m)).toBeNull()
  })
})

const bars = Array.from({ length: 260 }, (_, i) => {
  const c = 100 + Math.sin(i / 6) * 12 + i * 0.1
  return { timestamp: i * 86_400_000, open: c - 0.4, high: c + 1.5, low: c - 1.5, close: c, volume: 10 }
})
const out = computeOverlay(bars, '1D', { lookbackOverride: null, narrow: false, side: 'long', fvg: true })
// 8 px per bar, price 60..160 -> y 400..0 (4 px per $)
const mapper = (over: Partial<DeskMapper> = {}): DeskMapper => ({
  x: (i) => 700 - (259 - i) * 8,
  y: (v) => 400 - (v - 60) * 4,
  from: 200, to: 259, last: 259, left: 0, right: 800, top: 0, bottom: 400, barSpace: 8,
  ...over,
})
const view = (over: Partial<DeskView> = {}): DeskView => ({ ...DEFAULT_DESK_SETTINGS, fib: 'all', fvg: true, atrOn: true, ...over })

describe('planDesk', () => {
  it('only emits finite numbers and stays inside the plot rect', () => {
    const ops = planDesk(out, mapper(), DESK_COLORS, view())
    expect(ops.length).toBeGreaterThan(0)
    for (const op of ops) for (const v of Object.values(op)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
    for (const op of ops) if (op.kind === 'rect') {
      expect(op.y).toBeGreaterThanOrEqual(0)
      expect(op.y + op.h).toBeLessThanOrEqual(400.0001)
      expect(op.x).toBeGreaterThanOrEqual(0)
      expect(op.x + op.w).toBeLessThanOrEqual(800.0001)
    }
  })
  it('spreads two labels 5 px apart to at least 15 px', () => {
    const fake = { ...out, fib: { ...out.fib!, levels: [
      { ratio: 0.5, price: 120, kind: 'major' as const },
      { ratio: 0.618, price: 118.75, kind: 'golden' as const }, // 5 px below at 4 px/$
    ] } }
    const ops = planDesk(fake, mapper(), DESK_COLORS, view({ fib: 'key', atrOn: false, fvg: false, sma: { p20: false, p50: false, p200: false } }))
    const ys = ops.filter((o): o is Extract<DrawOp, { kind: 'label' }> => o.kind === 'label').map((o) => o.y).sort((a, b) => a - b)
    expect(ys).toHaveLength(2)
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(15 - 1e-9)
  })
  it('fib off draws no fib lines; key draws 0.382, 0.5, 0.618 only', () => {
    const only = { fvg: false, atrOn: false, sma: { p20: false, p50: false, p200: false } }
    expect(planDesk(out, mapper(), DESK_COLORS, view({ ...only, fib: 'off' }))).toEqual([])
    const labels = (f: 'key' | 'all') => planDesk(out, mapper(), DESK_COLORS, view({ ...only, fib: f })).filter((o) => o.kind === 'label').length
    expect(labels('key')).toBeLessThanOrEqual(3)
    expect(labels('all')).toBeGreaterThan(labels('key'))
  })
  it('zoomed out (bar < 3 px): no FVG, no SMA 20, no labels', () => {
    const ops = planDesk(out, mapper({ barSpace: 2 }), DESK_COLORS, view({ sma: { p20: true, p50: false, p200: false } }))
    expect(ops.filter((o) => o.kind === 'label' || o.kind === 'chip')).toEqual([])
    expect(ops.filter((o) => o.kind === 'polyline')).toEqual([])
  })
  it('pane under 400 px: only the golden zone', () => {
    const ops = planDesk(out, mapper({ bottom: 300 }), DESK_COLORS, view({ paneHeight: 300 }))
    expect(ops.every((o) => o.kind === 'rect')).toBe(true)
    expect(ops.length).toBeLessThanOrEqual(1)
  })
  it('SMA polylines split at NaN', () => {
    const o2 = { ...out, sma: { p20: [], p200: [], p50: out.sma.p50.map((v, i) => (i === 230 ? NaN : v)) } }
    const ops = planDesk(o2, mapper(), DESK_COLORS, view({ fib: 'off', fvg: false, atrOn: false, sma: { p20: false, p50: true, p200: false } }))
    expect(ops.filter((o) => o.kind === 'polyline')).toHaveLength(2)
  })
  it('ATR levels: stop in the bear color, three TPs, dotted, lines span last..last+25', () => {
    const ops = planDesk(out, mapper(), DESK_COLORS, view({ fib: 'off', fvg: false, sma: { p20: false, p50: false, p200: false } }))
    const lines = ops.filter((o): o is Extract<DrawOp, { kind: 'hline' }> => o.kind === 'hline')
    expect(lines).toHaveLength(4)
    expect(lines.filter((l) => l.color === DESK_COLORS.bear)).toHaveLength(1)
    for (const l of lines) expect(l.dash).toEqual([2, 3])
  })
  it('null fib / null atr draw nothing and never throw', () => {
    const empty = computeOverlay([], '1D', { lookbackOverride: null, narrow: false, side: 'long', fvg: true })
    expect(planDesk(empty, mapper(), DESK_COLORS, view())).toEqual([])
  })
})

describe('chip align', () => {
  it('right-aligned chip is painted ending at x', () => {
    const rects: number[] = []
    const ctx = { globalAlpha: 1, font: '', textAlign: '', textBaseline: '', fillStyle: '', measureText: () => ({ width: 40 }), fillRect: (x: number) => rects.push(x), fillText: () => undefined } as unknown as CanvasRenderingContext2D
    paintOps(ctx, [{ kind: 'chip', text: 'x', x: 300, y: 10, color: '#fff', ink: '#000', align: 'right' }])
    expect(rects[0]).toBe(300 - 50)
    paintOps(ctx, [{ kind: 'chip', text: 'x', x: 300, y: 10, color: '#fff', ink: '#000' }])
    expect(rects[1]).toBe(300)
  })
})
