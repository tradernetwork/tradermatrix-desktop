import { compile, run, type FillOut, type HLineOut, type PlotOut, type PlotType, type ScriptOutput } from '@rebull/script'
import { describe, expect, it } from 'vitest'
import { planDraw, type DrawOp, type Mapper } from '../src/chart/drawPlan'
import { paintOps } from '../src/chart/paint'
import ribbon from '../src/chart/scripts/tm_ema_ribbon.webull?raw'
import { walk } from './fixtures/walk'

const NaNv = NaN
const plot = (id: number, values: number[], o: Partial<PlotOut> = {}): PlotOut => ({
  id,
  name: `p${id}`,
  values: Float64Array.from(values),
  color: values.map(() => '#112233'),
  lineWidth: 2,
  type: 'line' as PlotType,
  opacity: 100,
  display: 'all',
  ...o,
})
const out = (plots: PlotOut[], hlines: HLineOut[] = [], fills: FillOut[] = []): ScriptOutput => ({ inputs: [], plots, hlines, fills })
const mapper = (n: number): Mapper => ({ x: (i) => i * 10 + 5, y: (v) => 500 - v * 2, yBase: 500, from: 0, to: n - 1 })
const kinds = (ops: DrawOp[]) => ops.map((o) => o.kind)
const polys = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'polygon' }> => o.kind === 'polygon')
const lines = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'polyline' }> => o.kind === 'polyline')

describe('polylines', () => {
  it('splits at NaN (line, linebr)', () => {
    for (const type of ['line', 'linebr'] as PlotType[]) {
      const ops = planDraw(out([plot(0, [1, 2, NaNv, 4, 5], { type })]), mapper(5), 8)
      const ls = lines(ops)
      expect(ls).toHaveLength(2)
      expect(ls[0]!.points).toEqual([[5, 498], [15, 496]])
      expect(ls[1]!.points).toEqual([[35, 492], [45, 490]])
      expect(ls[0]).toMatchObject({ color: '#112233', width: 2 })
    }
  })
  it('stepline goes horizontal then vertical', () => {
    const ops = planDraw(out([plot(0, [1, 3, 2], { type: 'stepline' })]), mapper(3), 8)
    const l = lines(ops)[0]!
    expect(l.step).toBe(true)
    expect(l.points).toEqual([[5, 498], [15, 498], [15, 494], [25, 494], [25, 496]])
  })
  it('skips display none plots and null-colored bars', () => {
    expect(lines(planDraw(out([plot(0, [1, 2, 3], { display: 'none' })]), mapper(3), 8))).toHaveLength(0)
    const p = plot(0, [1, 2, 3, 4])
    p.color[2] = null
    expect(lines(planDraw(out([p]), mapper(4), 8))).toHaveLength(1) // [0,1]; bar 3 alone is dropped
  })
  it('only emits bars inside the visible range (plus a neighbour for continuity)', () => {
    const vals = Array.from({ length: 100 }, (_, i) => i)
    const ops = planDraw(out([plot(0, vals)]), { ...mapper(100), from: 40, to: 60 }, 8)
    const xs = lines(ops)[0]!.points.map((p) => p[0])
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(39 * 10 + 5)
    expect(Math.max(...xs)).toBeLessThanOrEqual(61 * 10 + 5)
  })
})

describe('fills', () => {
  const fillOf = (a: number, b: number, color: (string | null)[], opacity = 30): FillOut => ({
    a: { kind: 'plot', id: a },
    b: { kind: 'plot', id: b },
    color,
    opacity,
    name: 'f',
  })
  it('a NaN in the middle gives two polygons and never bridges the gap', () => {
    const a = plot(0, [10, 11, NaNv, 13, 14, 15], { display: 'none' })
    const b = plot(1, [5, 6, 7, 8, 9, 10], { display: 'none' })
    const ps = polys(planDraw(out([a, b], [], [fillOf(0, 1, Array(6).fill('#00ff00'))]), mapper(6), 8))
    expect(ps).toHaveLength(2)
    const maxX0 = Math.max(...ps[0]!.points.map((p) => p[0]))
    const minX1 = Math.min(...ps[1]!.points.map((p) => p[0]))
    expect(maxX0).toBeLessThanOrEqual(15) // bar 1
    expect(minX1).toBeGreaterThanOrEqual(35) // bar 3
  })
  it('a color change splits into two polygons that share no area', () => {
    const a = plot(0, [10, 11, 12, 13], { display: 'none' })
    const b = plot(1, [5, 6, 7, 8], { display: 'none' })
    const ps = polys(planDraw(out([a, b], [], [fillOf(0, 1, ['#00ff00', '#00ff00', '#ff0000', '#ff0000'])]), mapper(4), 8))
    expect(ps).toHaveLength(2)
    expect(ps[0]!.color).toBe('#00ff00')
    expect(ps[1]!.color).toBe('#ff0000')
    expect(Math.max(...ps[0]!.points.map((p) => p[0]))).toBeLessThanOrEqual(Math.min(...ps[1]!.points.map((p) => p[0])))
  })
  it('null colors are not filled', () => {
    const a = plot(0, [10, 11, 12], { display: 'none' })
    const b = plot(1, [5, 6, 7], { display: 'none' })
    expect(polys(planDraw(out([a, b], [], [fillOf(0, 1, [null, null, null])]), mapper(3), 8))).toHaveLength(0)
  })
  it('hline refs as edges give a rectangular band', () => {
    const hl: HLineOut[] = [
      { id: 0, value: 20, color: '#fff', style: 'solid', lineWidth: 1 },
      { id: 1, value: 80, color: '#fff', style: 'dashed', lineWidth: 1 },
    ]
    const f: FillOut = { a: { kind: 'hline', id: 0 }, b: { kind: 'hline', id: 1 }, color: Array(4).fill('#0000ff'), opacity: 10, name: 'band' }
    const ps = polys(planDraw(out([plot(9, [1, 2, 3, 4], { display: 'none' })], hl, [f]), mapper(4), 8))
    expect(ps).toHaveLength(1)
    const ys = new Set(ps[0]!.points.map((p) => p[1]))
    expect([...ys].sort((x, y) => x - y)).toEqual([500 - 80 * 2, 500 - 20 * 2])
  })
  it('a lone bar still gets a visible quad, and opacity 30 maps to alpha 0.3', () => {
    const a = plot(0, [NaNv, 10, NaNv], { display: 'none' })
    const b = plot(1, [NaNv, 5, NaNv], { display: 'none' })
    const ps = polys(planDraw(out([a, b], [], [fillOf(0, 1, ['#00ff00', '#00ff00', '#00ff00'])]), mapper(3), 8))
    expect(ps).toHaveLength(1)
    expect(ps[0]!.alpha).toBeCloseTo(0.3)
    const xs = ps[0]!.points.map((p) => p[0])
    expect(Math.max(...xs)).toBeGreaterThan(Math.min(...xs))
  })
  it('a fill whose plot is display none is still drawn, the plot is not', () => {
    const a = plot(0, [10, 11, 12], { display: 'none' })
    const b = plot(1, [5, 6, 7], { display: 'none' })
    const ops = planDraw(out([a, b], [], [fillOf(0, 1, Array(3).fill('#00ff00'))]), mapper(3), 8)
    expect(kinds(ops)).toEqual(['polygon'])
  })
})

describe('columns, histogram, circles, hlines, order', () => {
  it('histogram and columns rects start at yBase', () => {
    for (const type of ['histogram', 'columns'] as PlotType[]) {
      const ops = planDraw(out([plot(0, [10, -10, 0], { type })]), mapper(3), 8)
      const rs = ops.filter((o): o is Extract<DrawOp, { kind: 'rect' }> => o.kind === 'rect')
      expect(rs).toHaveLength(3)
      expect(rs[0]).toMatchObject({ y: 480, h: 20 }) // value 10 -> y 480, base 500
      expect(rs[1]).toMatchObject({ y: 500, h: 20 }) // value -10 -> y 520
      expect(rs[2]!.h).toBe(0)
      expect(rs[0]!.w).toBeGreaterThan(0)
    }
  })
  it('opacity lands on rects and lines as alpha', () => {
    const ops = planDraw(out([plot(0, [1, 2], { opacity: 40 }), plot(1, [1, 2], { type: 'columns', opacity: 40 })]), mapper(2), 8)
    expect(lines(ops)[0]!.alpha).toBeCloseTo(0.4)
    expect(ops.find((o) => o.kind === 'rect')).toMatchObject({ alpha: 0.4 })
  })
  it('area draws a polygon down to yBase plus its line', () => {
    const ops = planDraw(out([plot(0, [1, 2, 3], { type: 'area', opacity: 50 })]), mapper(3), 8)
    expect(polys(ops)).toHaveLength(1)
    expect(polys(ops)[0]!.alpha).toBeCloseTo(0.5)
    expect(polys(ops)[0]!.points.some((p) => p[1] === 500)).toBe(true)
    expect(lines(ops)).toHaveLength(1)
  })
  it('circles radius is 3 for small bars and grows to at most 5; cross draws crosses', () => {
    const small = planDraw(out([plot(0, [1, NaNv, 3], { type: 'circles' })]), mapper(3), 4)
    const big = planDraw(out([plot(0, [1, 2], { type: 'circles' })]), mapper(2), 40)
    const sc = small.filter((o) => o.kind === 'circle') as Extract<DrawOp, { kind: 'circle' }>[]
    expect(sc).toHaveLength(2)
    expect(sc[0]!.r).toBe(3)
    expect((big[0] as Extract<DrawOp, { kind: 'circle' }>).r).toBe(5)
    expect(kinds(planDraw(out([plot(0, [1], { type: 'cross' })]), mapper(1), 8))).toEqual(['cross'])
  })
  it('hlines carry color, width and a dash pattern', () => {
    const hl: HLineOut[] = [
      { id: 0, value: 20, color: '#abc', style: 'dashed', lineWidth: 2 },
      { id: 1, value: 30, color: '#abc', style: 'solid', lineWidth: 1 },
    ]
    const h = planDraw(out([], hl), mapper(3), 8).filter((o) => o.kind === 'hline') as Extract<DrawOp, { kind: 'hline' }>[]
    expect(h[0]).toMatchObject({ y: 460, color: '#abc', width: 2 })
    expect(h[0]!.dash.length).toBeGreaterThan(0)
    expect(h[1]!.dash).toEqual([])
  })
  it('orders fills, area/columns/histogram, lines, hlines, circles/crosses', () => {
    const plots = [
      plot(0, [1, 2, 3], { display: 'none' }),
      plot(1, [3, 4, 5], { display: 'none' }),
      plot(2, [1, 2, 3], { type: 'circles' }),
      plot(3, [1, 2, 3], { type: 'histogram' }),
      plot(4, [1, 2, 3]),
    ]
    const hl: HLineOut[] = [{ id: 0, value: 2, color: '#fff', style: 'solid', lineWidth: 1 }]
    const f: FillOut = { a: { kind: 'plot', id: 0 }, b: { kind: 'plot', id: 1 }, color: Array(3).fill('#0f0'), opacity: 30, name: 'f' }
    const ops = planDraw(out(plots, hl, [f]), mapper(3), 8)
    const rank: Record<string, number> = { polygon: 0, rect: 1, polyline: 2, hline: 3, circle: 4, cross: 4 }
    const r = kinds(ops).map((k) => rank[k]!)
    expect(r).toEqual([...r].sort((a, b) => a - b))
    expect(new Set(r).size).toBe(5)
  })
  it('empty output and 0-1 bars do not throw', () => {
    expect(planDraw(out([]), mapper(0), 8)).toEqual([])
    expect(() => planDraw(out([plot(0, [])]), mapper(0), 8)).not.toThrow()
    expect(() => planDraw(out([plot(0, [1])]), mapper(1), 8)).not.toThrow()
  })
})

describe('built-in EMA ribbon output over the seeded walk', () => {
  it('produces polygons for fills and no NaN or Infinity coordinate', () => {
    const o = run(compile(ribbon), walk(300))
    const n = 300
    const m: Mapper = { x: (i) => i * 6 + 3, y: (v) => 600 - v * 3, yBase: 600, from: 0, to: n - 1 }
    const ops = planDraw(o, m, 5)
    expect(polys(ops).length).toBeGreaterThanOrEqual(o.fills.length)
    const bad = (v: number) => !Number.isFinite(v)
    for (const op of ops) {
      const nums =
        op.kind === 'polyline' || op.kind === 'polygon'
          ? op.points.flat()
          : op.kind === 'circle' || op.kind === 'cross'
            ? [op.x, op.y]
            : op.kind === 'rect'
              ? [op.x, op.y, op.w, op.h]
              : [op.y]
      expect(nums.some(bad)).toBe(false)
    }
  })
})

describe('paintOps', () => {
  function recorder() {
    const calls: string[] = []
    const ctx: Record<string, unknown> = { globalAlpha: 1, canvas: { width: 800, height: 400 } }
    for (const fn of ['beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'fillRect', 'arc', 'setLineDash', 'save', 'restore'])
      ctx[fn] = (...a: unknown[]) => calls.push(`${fn}(${a.join(',')})`)
    return { ctx: ctx as unknown as CanvasRenderingContext2D, raw: ctx, calls }
  }
  it('paints each op kind in order and restores globalAlpha', () => {
    const { ctx, raw, calls } = recorder()
    const alphas: number[] = []
    let ga = 1
    Object.defineProperty(raw, 'globalAlpha', { get: () => ga, set: (v: number) => ((ga = v), alphas.push(v)) })
    const ops: DrawOp[] = [
      { kind: 'polygon', points: [[0, 0], [10, 0], [10, 10]], color: '#0f0', alpha: 0.3 },
      { kind: 'rect', x: 1, y: 2, w: 3, h: 4, color: '#f00' },
      { kind: 'polyline', points: [[0, 0], [5, 5]], color: '#00f', width: 2 },
      { kind: 'hline', y: 7, color: '#fff', width: 1, dash: [4, 2] },
      { kind: 'circle', x: 3, y: 4, r: 3, color: '#ff0' },
      { kind: 'cross', x: 3, y: 4, size: 4, color: '#ff0' },
    ]
    paintOps(ctx, ops)
    expect(calls.indexOf('closePath()')).toBeLessThan(calls.indexOf('fillRect(1,2,3,4)'))
    expect(calls.indexOf('fillRect(1,2,3,4)')).toBeLessThan(calls.findIndex((c) => c.startsWith('stroke')))
    expect(calls.some((c) => c.startsWith('arc(3,4,3'))).toBe(true)
    expect(calls).toContain('setLineDash(4,2)')
    expect(alphas).toContain(0.3)
    expect(ga).toBe(1)
  })
  it('uses the op color and tolerates an empty list', () => {
    const { ctx, raw } = recorder()
    paintOps(ctx, [])
    paintOps(ctx, [{ kind: 'polygon', points: [[0, 0], [1, 1], [2, 0]], color: '#123456', alpha: 1 }])
    expect(raw.fillStyle).toBe('#123456')
  })
})
