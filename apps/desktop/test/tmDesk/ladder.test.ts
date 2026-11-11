import { describe, expect, it } from 'vitest'
import { buildLadder, collectLadderLevels, isTmSource, type LadderLevel } from '../../src/chart/tmDesk/ladder'
import type { ApexLevels, ExpectedMove } from '../../src/lib/api'
import { computeOverlay } from '../../src/chart/tmDesk/overlay'

// 300 px pane for prices 200..100 (linear): y = (200 - p) * 3
const H = 300
const yOf = (p: number) => (200 - p) * 3
const lvl = (price: number, source: LadderLevel['source'] = 'tm', rank = 1, label = `L${price}`): LadderLevel => ({ price, label, source, rank })
const drawn = (rows: ReturnType<typeof buildLadder>) => rows.filter((r) => r.kind !== 'tick')

describe('buildLadder', () => {
  it('40 levels in 300 px: every drawn label is at least 14 px from its neighbours, all inside the pane', () => {
    const levels = Array.from({ length: 40 }, (_, i) => lvl(101 + i * 2.4, 'tm', i))
    const rows = drawn(buildLadder(levels, 150, H, { yOf }))
    const ys = rows.map((r) => r.labelY).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(14 - 1e-9)
    expect(ys[0]!).toBeGreaterThanOrEqual(0)
    expect(ys[ys.length - 1]!).toBeLessThanOrEqual(H)
    expect(rows.length).toBeLessThan(40)
    expect(rows.length).toBeGreaterThan(10)
  })
  it('nearest-to-price levels survive demotion; far ones become ticks', () => {
    const levels = Array.from({ length: 40 }, (_, i) => lvl(101 + i * 2.4, 'tm', i))
    const rows = buildLadder(levels, 150, H, { yOf })
    const kept = rows.filter((r) => r.kind === 'level')
    const ticks = rows.filter((r) => r.kind === 'tick')
    expect(ticks.length).toBeGreaterThan(0)
    const nearestKept = Math.max(...kept.map((r) => Math.abs(r.price - 150)))
    const nearestTick = Math.min(...ticks.map((r) => Math.abs(r.price - 150)))
    expect(nearestTick).toBeGreaterThanOrEqual(nearestKept - 1e-9)
    // the level closest to the price is always kept
    const closest = levels.reduce((a, b) => (Math.abs(b.price - 150) < Math.abs(a.price - 150) ? b : a))
    expect(kept.some((r) => r.price === closest.price)).toBe(true)
  })
  it('"you are here" row is present, labelled with the price, and never a chip', () => {
    const rows = buildLadder([lvl(120), lvl(180)], 150, H, { yOf })
    const here = rows.filter((r) => r.kind === 'here')
    expect(here).toHaveLength(1)
    expect(here[0]).toMatchObject({ price: 150, label: '150', chip: false, source: 'here' })
    expect(here[0]!.y).toBe(150)
    // even with 40 levels competing for slots
    const many = buildLadder(Array.from({ length: 40 }, (_, i) => lvl(101 + i * 2.4)), 150, H, { yOf })
    expect(many.filter((r) => r.kind === 'here')).toHaveLength(1)
  })
  it('a price outside the plot is clamped, not lost', () => {
    const rows = buildLadder([lvl(150)], 250, H, { yOf })
    expect(rows.find((r) => r.kind === 'here')!.y).toBe(0)
  })
  it('two levels at the same price are both listed, once each, in order of rank', () => {
    const rows = buildLadder([lvl(140, 'tm', 5, 'B'), lvl(140, 'tm', 2, 'A'), lvl(140, 'tm', 2, 'A'), lvl(170, 'tm', 1, 'C')], 150, H, { yOf })
    const same = rows.filter((r) => r.price === 140)
    expect(same.map((r) => r.label)).toEqual(['A', 'B'])
    expect(same[1]!.labelY - same[0]!.labelY).toBeGreaterThanOrEqual(14 - 1e-9)
  })
  it('rank winners: tm > atr > fib > fvg when slots run out', () => {
    // 10 slots in 150 px: put 5 of each of four sources at the same distance
    const levels: LadderLevel[] = []
    ;(['fvg', 'fib', 'atr', 'tm'] as const).forEach((src, k) => {
      for (let i = 0; i < 5; i++) levels.push(lvl(120 + k * 0.01 + i * 10, src, i, `${src}${i}`))
    })
    const rows = buildLadder(levels, 150, 150, { yOf: (p) => (200 - p) * 1.5 })
    const kept = rows.filter((r) => r.kind === 'level')
    expect(kept.filter((r) => r.source === 'tm')).toHaveLength(5)
    expect(kept.some((r) => r.source === 'fvg')).toBe(false)
    expect(kept.length).toBeLessThanOrEqual(9)
    expect(rows.filter((r) => r.kind === 'tick').every((r) => r.source === 'fvg' || r.source === 'fib' || r.source === 'atr')).toBe(true)
  })
  it('chips are filled only for TraderMatrix-sourced levels', () => {
    const rows = buildLadder([lvl(120, 'tm'), lvl(125, 'flip'), lvl(130, 'em'), lvl(135, 'fib'), lvl(140, 'atr'), lvl(145, 'fvg')], 100, H, { yOf })
    const chipSources = rows.filter((r) => r.chip).map((r) => r.source).sort()
    expect(chipSources).toEqual(['em', 'flip', 'tm'])
    expect(isTmSource('fib')).toBe(false)
  })
  it('a pane under 400 px tall lists TraderMatrix levels only; 400 px lists all', () => {
    const levels = [lvl(120, 'tm'), lvl(130, 'fib'), lvl(140, 'atr'), lvl(160, 'flip')]
    const small = buildLadder(levels, 150, 399, { yOf: (p) => (200 - p) * 3.99 })
    expect(small.filter((r) => r.kind !== 'here').map((r) => r.source).sort()).toEqual(['flip', 'tm'])
    const full = buildLadder(levels, 150, 400, { yOf: (p) => (200 - p) * 4 })
    expect(full.filter((r) => r.kind !== 'here')).toHaveLength(4)
  })
  it('levels outside the plot or not finite are dropped; ticks never sit on another row', () => {
    const rows = buildLadder([lvl(50), lvl(500), lvl(NaN), lvl(130)], 150, H, { yOf })
    expect(rows.filter((r) => r.kind === 'level').map((r) => r.price)).toEqual([130])
    const crowded = Array.from({ length: 60 }, (_, i) => lvl(120 + i * 0.1))
    const r2 = buildLadder(crowded, 150, H, { yOf })
    const ticks = r2.filter((r) => r.kind === 'tick')
    expect(ticks.length).toBeGreaterThan(0)
    for (const t of ticks) for (const o of r2) if (o !== t) expect(Math.abs(o.y - t.y)).toBeGreaterThanOrEqual(2 - 1e-9)
  })
  it('degenerate plots return nothing', () => {
    expect(buildLadder([lvl(120)], 150, 0, { yOf })).toEqual([])
    expect(buildLadder([lvl(120)], 150, 300, { yOf, top: 200, bottom: 100 })).toEqual([])
  })
})

describe('collectLadderLevels', () => {
  const apex: ApexLevels = {
    symbol: 'AAA', spot: 100, snapshot_time: null, gamma_flip: 98.5, net_gex: null, expirations_used: [], available_expirations: [], open_url: null,
    levels: [{ strike: 105, score: 100, rank: 1, net_gex: null, total_oi: null, is_above_spot: true }, { strike: 95, score: 50, rank: 2, net_gex: null, total_oi: null, is_above_spot: false }],
  }
  const band = { low: 96, high: 104 }
  const move: ExpectedMove = {
    symbol: 'AAA', spot: 100, as_of: null, interpretation: null, open_url: null,
    horizons: [{ label: '1 week', calendar_days: 7, through_date: '2026-11-18', trading_days: 5, expected_move_pct: 0.04, band68: band, band95: { low: 92, high: 108 }, held68_pct: null, held95_pct: null, sample_days: null, extrapolated: false }],
  }
  const on = { apex: true, flip: true, move: true, horizon: '1 week' }
  const bars = Array.from({ length: 260 }, (_, i) => {
    const c = 100 + Math.sin(i / 6) * 12 + i * 0.1
    return { timestamp: i * 86_400_000, open: c - 0.4, high: c + 1.5, low: c - 1.5, close: c, volume: 10 }
  })
  const overlay = computeOverlay(bars, '1D', { lookbackOverride: null, narrow: false, side: 'long', fvg: false })

  it('apex, flip and EM edges honor their toggles', () => {
    const all = collectLadderLevels({ apex, move, tm: on, desk: { fib: 'off', fvg: false }, atrOn: false, overlay: null })
    expect(all.map((l) => `${l.source}:${l.label}`)).toEqual([
      'tm:APEX 105', 'tm:APEX 95', 'flip:FLIP 98.50', 'em:EM68 104', 'em:EM68 96', 'em:EM95 108', 'em:EM95 92',
    ])
    const none = collectLadderLevels({ apex, move, tm: { ...on, apex: false, flip: false, move: false }, desk: { fib: 'off', fvg: false }, atrOn: false, overlay: null })
    expect(none).toEqual([])
    const unknownHorizon = collectLadderLevels({ apex: null, move, tm: { ...on, horizon: 'nope' }, desk: { fib: 'off', fvg: false }, atrOn: false, overlay: null })
    expect(unknownHorizon).toEqual([])
  })
  it('fib key shows only 0.382 / 0.5 / 0.618, "all" shows more, ATR levels only while shown', () => {
    const key = collectLadderLevels({ apex: null, move: null, tm: { ...on, apex: false, flip: false, move: false }, desk: { fib: 'key', fvg: false }, atrOn: false, overlay })
    expect(key.every((l) => l.source === 'fib')).toBe(true)
    expect(key.map((l) => l.rank).sort()).toEqual([0.382, 0.5, 0.618])
    const all = collectLadderLevels({ apex: null, move: null, tm: { ...on, apex: false, flip: false, move: false }, desk: { fib: 'all', fvg: false }, atrOn: true, overlay })
    expect(all.filter((l) => l.source === 'fib').length).toBeGreaterThan(3)
    expect(all.filter((l) => l.source === 'atr').map((l) => l.label.split(' ')[0])).toEqual(['SL', 'TP1', 'TP2', 'TP3'])
    expect(collectLadderLevels({ apex: null, move: null, tm: on, desk: { fib: 'off', fvg: false }, atrOn: false, overlay }).filter((l) => l.source === 'atr')).toEqual([])
  })
})
