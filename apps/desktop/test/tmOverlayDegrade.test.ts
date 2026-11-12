import { describe, expect, it } from 'vitest'
import type { DrawOp, Mapper } from '../src/chart/drawPlan'
import { chipDetail, MIN_LABEL_GAP, NEAREST_APEX_CHIPS, planTmOverlay, type TmOverlayData } from '../src/chart/tmOverlay'
import type { ApexLevel, ApexLevels, ExpectedMove } from '../src/lib/api'

const lvl = (strike: number, score = 50): ApexLevel => ({ strike, score, rank: 1, net_gex: 1e6, total_oi: 100, is_above_spot: strike > 100 })
const apex = (levels: ApexLevel[], flip: number | null): ApexLevels => ({
  symbol: 'AAPL', spot: 100, snapshot_time: null, gamma_flip: flip, net_gex: null, levels, expirations_used: [], available_expirations: [], open_url: null,
})
const em: ExpectedMove = {
  symbol: 'AAPL', spot: 100, as_of: null, interpretation: null, open_url: null,
  horizons: [{ label: '1 week', calendar_days: 7, through_date: null, trading_days: 5, expected_move_pct: 0.03, band68: { low: 97, high: 103 }, band95: { low: 94, high: 106 }, held68_pct: 0.6, held95_pct: 0.9, sample_days: 100, extrapolated: false }],
}
/** price 80..120 over a plot of height h */
const mapper = (h: number): Mapper => ({ x: (i) => i * 10 + 5, y: (v) => h - ((v - 80) / 40) * h, yBase: h, from: 0, to: 99, left: 0, right: 1000, top: 0, bottom: h, last: 99 })
const ALL = { apex: true, flip: true, move: true }
const data: TmOverlayData = {
  horizon: '1 week',
  show: ALL,
  move: em,
  apex: apex([lvl(112), lvl(108), lvl(104), lvl(101), lvl(99), lvl(96), lvl(92), lvl(88)], 100.5),
}
const run = (h: number) => planTmOverlay(data, mapper(h), 100)
const chips = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: 'chip' }> => o.kind === 'chip')
const hlines = (ops: DrawOp[]) => ops.filter((o) => o.kind === 'hline')
const rects = (ops: DrawOp[]) => ops.filter((o) => o.kind === 'rect')

describe('M22 chipDetail thresholds', () => {
  it('full from 220 px up, reduced from 140 to 219, lines below 140', () => {
    expect(chipDetail(400)).toBe('full')
    expect(chipDetail(220)).toBe('full')
    expect(chipDetail(219)).toBe('reduced')
    expect(chipDetail(140)).toBe('reduced')
    expect(chipDetail(139)).toBe('lines')
    expect(chipDetail(0)).toBe('lines')
  })
  it('an unknown height (no bounds) keeps everything', () => {
    expect(chipDetail(Number.POSITIVE_INFINITY)).toBe('full')
    expect(chipDetail(Number.NaN)).toBe('full')
  })
})

describe('M22 overlay degradation by plot height', () => {
  it('full: EM labels, 3+ apex chips and the flip chip', () => {
    const c = chips(run(400)).map((x) => x.text)
    expect(c.some((t) => t.startsWith('EM '))).toBe(true)
    expect(c.filter((t) => t.startsWith('APEX')).length).toBeGreaterThan(NEAREST_APEX_CHIPS)
    expect(c.some((t) => t.startsWith('γ FLIP'))).toBe(true)
  })
  it('reduced (180 px): nearest 3 apex chips + flip, no EM labels; every line and band stays', () => {
    const ops = run(180)
    const c = chips(ops).map((x) => x.text)
    expect(c.filter((t) => t.startsWith('APEX'))).toHaveLength(3)
    expect(c.filter((t) => t.startsWith('APEX')).sort()).toEqual(['APEX 101 · 50', 'APEX 104 · 50', 'APEX 99 · 50'].sort())
    expect(c.some((t) => t.startsWith('γ FLIP'))).toBe(true)
    expect(c.some((t) => t.startsWith('EM '))).toBe(false)
    expect(hlines(ops)).toHaveLength(9) // 8 apex + flip
    expect(rects(ops).length).toBe(2) // both EM bands
  })
  it('lines only (100 px): just one count badge', () => {
    const ops = run(100)
    const c = chips(ops)
    expect(c).toHaveLength(1)
    expect(c[0]!.text).toMatch(/^\d+ levels?$/)
    expect(hlines(ops).length).toBe(9)
  })
  it('chips stay at least 14 px apart at every height', () => {
    for (const h of [100, 140, 180, 220, 260, 400, 700]) {
      const ys = chips(run(h)).map((x) => x.y).sort((a, b) => a - b)
      for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(14 - 1e-9)
      expect(MIN_LABEL_GAP).toBeGreaterThanOrEqual(14)
    }
  })
})
