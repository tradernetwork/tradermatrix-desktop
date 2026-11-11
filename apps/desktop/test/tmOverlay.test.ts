import { describe, expect, it } from 'vitest'
import type { DrawOp, Mapper } from '../src/chart/drawPlan'
import { paintOps } from '../src/chart/paint'
import { MIN_LABEL_GAP, planTmOverlay, spreadLabels, type TmOverlayData } from '../src/chart/tmOverlay'
import type { ApexLevel, ApexLevels, ExpectedMove, TmHorizon } from '../src/lib/api'

const lvl = (strike: number, score: number, above = true): ApexLevel => ({
  strike, score, rank: 1, net_gex: 1e6, total_oi: 100, is_above_spot: above,
})
const apex = (levels: ApexLevel[], flip: number | null = null): ApexLevels => ({
  symbol: 'AAPL', spot: 100, snapshot_time: null, gamma_flip: flip, net_gex: null, levels,
  expirations_used: [], available_expirations: [], open_url: null,
})
const hz = (label: string, l68: number, h68: number, l95: number, h95: number): TmHorizon => ({
  label, calendar_days: 7, through_date: null, trading_days: 5, expected_move_pct: 0.03,
  band68: { low: l68, high: h68 }, band95: { low: l95, high: h95 }, held68_pct: 0.6, held95_pct: 0.9, sample_days: 100, extrapolated: false,
})
const move = (hs: TmHorizon[]): ExpectedMove => ({ symbol: 'AAPL', spot: 100, as_of: null, horizons: hs, interpretation: null, open_url: null })

// price 0..200 maps to y 400..0 (2 px per unit); 100 bars, x = i * 10 + 5
const M: Mapper = { x: (i) => i * 10 + 5, y: (v) => 400 - v * 2, yBase: 400, from: 0, to: 99, left: 0, right: 1000, top: 0, bottom: 400, last: 99 }
const ALL = { apex: true, flip: true, move: true }
const run = (d: Partial<TmOverlayData>, m: Mapper = M, spot = 100) => planTmOverlay({ horizon: '1 week', show: ALL, ...d }, m, spot)
const hlines = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'hline' }> => o.kind === 'hline')
const labels = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'chip' }> => o.kind === 'chip')
const rects = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'rect' }> => o.kind === 'rect')

describe('apex levels', () => {
  it('empty or undefined data yields no ops', () => {
    expect(run({})).toEqual([])
    expect(run({ apex: apex([]) })).toEqual([])
    expect(run({ move: move([]) })).toEqual([])
  })
  it('keeps the top 8 by score, each with a filled chip "APEX strike · score" at the left edge', () => {
    const ls = Array.from({ length: 10 }, (_, i) => lvl(90 + i, 10 + i * 5))
    const ops = run({ apex: apex(ls), show: { apex: true, flip: false, move: false } })
    expect(hlines(ops)).toHaveLength(8)
    const texts = labels(ops).map((l) => l.text)
    expect(texts).toContain('APEX 99 · 55')
    expect(texts).not.toContain('APEX 90 · 10')
    expect(labels(ops).every((l) => l.x === 4)).toBe(true) // M.left is 0, chip pad 4
  })
  it('width runs 1 to 3 px by score; side picks the tint (above spot hot orange, below spot support green) at alpha 0.8', () => {
    const ops = run({ apex: apex([lvl(120, 100, true), lvl(80, 0, false)]), show: { apex: true, flip: false, move: false } }, M, 100)
    const hs = hlines(ops)
    const top = hs.find((h) => h.y === M.y(120))!
    const low = hs.find((h) => h.y === M.y(80))!
    expect(top.width).toBe(3)
    expect(low.width).toBe(1)
    expect(top.color).toBe('#ff8000')
    expect(low.color).toBe('#00e070')
    expect(top.alpha).toBe(0.8)
    expect(low.dash).toEqual([5, 4]) // dashed, like the desk
  })
  it('lines span only the visible x-range', () => {
    const m: Mapper = { ...M, left: 20, right: 300 }
    const h = hlines(run({ apex: apex([lvl(120, 50)]), show: { apex: true, flip: false, move: false } }, m))[0]!
    expect([h.x0, h.x1]).toEqual([20, 300])
  })
  it('drops levels outside the visible price range and keeps one exactly on the edge', () => {
    // y(200)=0 is the top edge, y(0)=400 the bottom edge, y(250)=-100 is outside
    const ops = run({ apex: apex([lvl(250, 90), lvl(200, 80), lvl(0, 70), lvl(-10, 60), lvl(100, 50)]), show: { apex: true, flip: false, move: false } })
    expect(hlines(ops).map((h) => h.y).sort((a, b) => a - b)).toEqual([0, 200, 400])
  })
  it('eight levels within 5 px of each other get chips at least MIN_LABEL_GAP px apart and in order', () => {
    const ls = Array.from({ length: 8 }, (_, i) => lvl(100 + i * 2.5, 90 - i)) // 5 px apart
    const ls2 = labels(run({ apex: apex(ls), show: { apex: true, flip: false, move: false } }))
    expect(ls2).toHaveLength(8)
    const ys = ls2.map((l) => l.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(MIN_LABEL_GAP)
    // order follows the price order (higher strike = smaller y)
    const byStrike = [...ls2].sort((a, b) => Number(b.text.split(' ')[1]) - Number(a.text.split(' ')[1]))
    for (let i = 1; i < byStrike.length; i++) expect(byStrike[i]!.y).toBeGreaterThan(byStrike[i - 1]!.y)
  })
  it('nudged labels stay inside the pane at the bottom edge', () => {
    const ls = Array.from({ length: 6 }, (_, i) => lvl(1 + i * 0.5, 90 - i)) // all near the bottom (y ~ 396)
    const ys = labels(run({ apex: apex(ls), show: { apex: true, flip: false, move: false } })).map((l) => l.y)
    expect(Math.max(...ys)).toBeLessThanOrEqual(400)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
  })
  it('the apex toggle off removes the levels', () => {
    expect(run({ apex: apex([lvl(120, 50)]), show: { apex: false, flip: false, move: false } })).toEqual([])
  })
})

describe('gamma flip', () => {
  it('is a dashed purple line labelled with two decimals', () => {
    const ops = run({ apex: apex([], 343.59 / 3.4359) , show: { apex: false, flip: true, move: false } }) // flip = 100
    const h = hlines(ops)[0]!
    expect(h.dash.length).toBeGreaterThan(0)
    expect(h.color).toBe('#b45bff')
    expect(labels(ops)[0]!.text).toBe('γ FLIP 100.00')
  })
  it('shows "γ flip 343.59" for the real AAPL value', () => {
    const m: Mapper = { ...M, y: (v) => 800 - (v - 300) * 8, bottom: 800 }
    const ops = run({ apex: apex([], 343.59), show: { apex: false, flip: true, move: false } }, m, 348.51)
    expect(labels(ops)[0]!.text).toBe('γ FLIP 343.59')
  })
  it('is dropped when off, null or outside the range', () => {
    expect(run({ apex: apex([], 100), show: { apex: true, flip: false, move: false } })).toEqual([])
    expect(run({ apex: apex([], null), show: { apex: false, flip: true, move: false } })).toEqual([])
    expect(run({ apex: apex([], 500), show: { apex: false, flip: true, move: false } })).toEqual([])
  })
})

describe('expected move bands', () => {
  const data = { move: move([hz('tomorrow', 98, 102, 96, 104), hz('1 week', 90, 110, 80, 120)]), show: { apex: false, flip: false, move: true } }
  it('68% band (alpha 0.12) and wider 95% band (alpha 0.06) run from the last bar to the right edge', () => {
    const rs = rects(run(data))
    expect(rs).toHaveLength(2)
    const wide = rs.find((r) => r.alpha === 0.06)!
    const narrow = rs.find((r) => r.alpha === 0.12)!
    const x0 = M.x(99)
    expect([narrow.x, narrow.w]).toEqual([x0, 1000 - x0])
    expect([narrow.y, narrow.h]).toEqual([M.y(110), M.y(90) - M.y(110)])
    expect([wide.y, wide.h]).toEqual([M.y(120), M.y(80) - M.y(120)])
    expect(rs.indexOf(wide)).toBeLessThan(rs.indexOf(narrow))
  })
  it('edge chips read "EM 68% low-high"', () => {
    const t = labels(run(data)).map((l) => l.text)
    expect(t).toContain('EM 68% 90-110')
    expect(t).toContain('EM 95% 80-120')
  })
  it('the chosen horizon picks the band; an unknown horizon draws nothing', () => {
    const tomorrow = rects(run({ ...data, horizon: 'tomorrow' })).find((r) => r.alpha === 0.12)!
    expect(tomorrow.y).toBe(M.y(102))
    expect(rects(run({ ...data, horizon: 'nope' }))).toEqual([])
  })
  it('clips a band to the pane instead of stretching it, and drops one fully outside', () => {
    const big = rects(run({ move: move([hz('1 week', 90, 250, 80, 300)]), show: { apex: false, flip: false, move: true } }))
    const narrow = big.find((r) => r.alpha === 0.12)!
    expect(narrow.y).toBe(0)
    expect(narrow.y + narrow.h).toBe(M.y(90))
    expect(rects(run({ move: move([hz('1 week', 500, 520, 480, 540)]), show: { apex: false, flip: false, move: true } }))).toEqual([])
  })
  it('draws nothing when the last bar is scrolled off to the right', () => {
    expect(rects(run(data, { ...M, to: 50, last: 99, right: 400 }))).toEqual([])
  })
  it('a band with a missing edge is skipped', () => {
    const h = hz('1 week', 90, 110, 80, 120)
    h.band95 = null
    expect(rects(run({ move: move([h]), show: { apex: false, flip: false, move: true } })).map((r) => r.alpha)).toEqual([0.12])
  })
})

describe('robustness', () => {
  it('never emits a NaN or Infinity coordinate', () => {
    const bad = apex([lvl(NaN, 50), lvl(100, NaN), { ...lvl(120, 40), strike: null }, lvl(Infinity, 30), lvl(110, 60)], NaN)
    const h = hz('1 week', NaN, 110, 80, Infinity)
    const ops = run({ apex: bad, move: move([h]) })
    for (const op of ops) {
      const nums = Object.entries(op).filter(([, v]) => typeof v === 'number').map(([, v]) => v as number)
      expect(nums.every(Number.isFinite)).toBe(true)
    }
    // a mapper that returns NaN for everything yields no ops
    expect(run({ apex: apex([lvl(100, 50)], 100) }, { ...M, y: () => NaN })).toEqual([])
  })
  it('spreadLabels keeps order, min gap, and pane bounds', () => {
    const out = spreadLabels([5, 6, 7, 8, 396, 397, 398], 12, 0, 400)
    for (let i = 1; i < out.length; i++) expect(out[i]! - out[i - 1]!).toBeGreaterThanOrEqual(12)
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...out)).toBeLessThanOrEqual(400)
  })
})

describe('chips', () => {
  const chipOps = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'chip' }> => o.kind === 'chip')
  it('chip background is the level color and the text is the dark ink', () => {
    const ops = run({ apex: apex([lvl(120, 50, true), lvl(80, 50, false)], 100), show: ALL })
    const cs = chipOps(ops)
    const by = (t: string) => cs.find((c) => c.text.startsWith(t))!
    expect(by('APEX 120').color).toBe('#ff8000')
    expect(by('APEX 80').color).toBe('#00e070')
    expect(by('γ FLIP').color).toBe('#b45bff')
    expect(cs.every((c) => c.ink === '#070E1F')).toBe(true)
  })
  it('the chip sits on its line: y is the line y when nothing crowds it', () => {
    const c = chipOps(run({ apex: apex([lvl(150, 50, true)]), show: { apex: true, flip: false, move: false } }))[0]!
    expect(c.y).toBe(M.y(150))
  })
  it('chips stay inside the pane and never carry NaN', () => {
    const ls = Array.from({ length: 8 }, (_, i) => lvl(198 - i * 0.5, 90 - i))
    for (const c of chipOps(run({ apex: apex(ls), show: { apex: true, flip: false, move: false } }))) {
      expect(c.y - 7).toBeGreaterThanOrEqual(0)
      expect(c.y + 7).toBeLessThanOrEqual(400)
      expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true)
    }
  })
  it('the 68% and 95% bands are range blue and their chips are range blue', () => {
    const ops = run({ move: move([hz('1 week', 90, 110, 80, 120)]), show: { apex: false, flip: false, move: true } })
    expect(rects(ops).every((r) => r.color === '#4f86ff')).toBe(true)
    expect(chipOps(ops).every((c) => c.color === '#4f86ff')).toBe(true)
  })
  it('chip text speaks of positioning, never targets', () => {
    const ops = run({ apex: apex([lvl(120, 50)], 100), move: move([hz('1 week', 90, 110, 80, 120)]) })
    expect(chipOps(ops).some((c) => /target|forecast|price target/i.test(c.text))).toBe(false)
  })
})

describe('paintOps chip', () => {
  const mk = () => {
    const calls: string[] = []
    let ga = 1
    const ctx = {
      font: '', textAlign: '', textBaseline: '', fillStyle: '' as string, strokeStyle: '', lineWidth: 0, canvas: { width: 100, height: 100 },
      get globalAlpha() { return ga },
      set globalAlpha(v: number) { ga = v },
      measureText: (t: string) => ({ width: t.length * 6 }),
      fillRect: (...a: number[]) => calls.push(`fillRect(${a.join(',')}) fill=${ctx.fillStyle}`),
      fillText: (...a: unknown[]) => calls.push(`fillText(${a.join(',')}) fill=${ctx.fillStyle}`),
      beginPath: () => undefined, closePath: () => undefined, moveTo: () => undefined, lineTo: () => undefined, arcTo: () => undefined,
      fill: () => calls.push(`fill fill=${ctx.fillStyle}`),
    }
    return { ctx, calls, ga: () => ga }
  }
  it('draws a filled rect in the level color, then the text in the ink color, in a mono font', () => {
    const { ctx, calls, ga } = mk()
    paintOps(ctx as unknown as CanvasRenderingContext2D, [{ kind: 'chip', text: 'APEX 355 · 100', x: 4, y: 50, color: '#ff8000', ink: '#070E1F' }])
    expect(ctx.font).toMatch(/JetBrains Mono/)
    const rect = calls.find((c) => c.startsWith('fillRect') || c.startsWith('fill '))!
    expect(rect).toContain('#ff8000')
    const text = calls.find((c) => c.startsWith('fillText'))!
    expect(text).toContain('APEX 355 · 100')
    expect(text).toContain('#070E1F')
    expect(calls.indexOf(rect)).toBeLessThan(calls.indexOf(text))
    expect(ga()).toBe(1)
  })
  it('the rect is as wide as the text plus padding and centred on y', () => {
    const { ctx, calls } = mk()
    paintOps(ctx as unknown as CanvasRenderingContext2D, [{ kind: 'chip', text: 'ABCD', x: 4, y: 50, color: '#fff', ink: '#000' }])
    const r = calls.find((c) => c.startsWith('fillRect'))!
    const [x, y, w, h] = r.slice(9, r.indexOf(')')).split(',').map(Number)
    expect(x).toBe(4)
    expect(w).toBeGreaterThan(24)
    expect(y! + h! / 2).toBe(50)
  })
})

describe('paintOps label', () => {
  it('sets font and alignment, paints the text, and restores globalAlpha', () => {
    const calls: string[] = []
    let ga = 1
    const alphas: number[] = []
    const ctx = {
      font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineWidth: 0, canvas: { width: 100, height: 100 },
      get globalAlpha() { return ga },
      set globalAlpha(v: number) { ga = v; alphas.push(v) },
      fillText: (...a: unknown[]) => calls.push(`fillText(${a.join(',')})`),
      strokeText: (...a: unknown[]) => calls.push(`strokeText(${a.join(',')})`),
    }
    paintOps(ctx as unknown as CanvasRenderingContext2D, [{ kind: 'label', text: '355 · 100', x: 50, y: 20, color: '#ef4444', align: 'right', alpha: 0.9, halo: '#000' }])
    expect(ctx.font).toMatch(/px/)
    expect(ctx.textAlign).toBe('right')
    expect(calls).toEqual(['strokeText(355 · 100,50,20)', 'fillText(355 · 100,50,20)'])
    expect(ctx.fillStyle).toBe('#ef4444')
    expect(alphas).toContain(0.9)
    expect(ga).toBe(1)
  })
})
