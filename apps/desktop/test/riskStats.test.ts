import { describe, expect, it } from 'vitest'
import { orderByClose, rStats, sqnText } from '../src/lib/riskStats'
import { heatReadout } from '../src/lib/riskHeat'

// M18 Task 2. Standard definitions only: expectancy = mean R, SQN = mean / sample stdev (n-1) x sqrt(n).

describe('rStats', () => {
  it('[2,-1,-1,3,-1] -> expectancy 0.4, win rate 0.4, avg win 2.5, avg loss -1', () => {
    const s = rStats([2, -1, -1, 3, -1])
    expect(s.n).toBe(5)
    expect(s.expectancy).toBeCloseTo(0.4, 10)
    expect(s.winRate).toBeCloseTo(0.4, 10)
    expect(s.avgWinR).toBeCloseTo(2.5, 10)
    expect(s.avgLossR).toBeCloseTo(-1, 10)
    expect(s.sqn).toBeNull()
  })
  it('n = 30, mean 0.4, sample stdev 1.2 -> SQN = 0.4/1.2 x sqrt(30) ~ 1.83', () => {
    const d = Math.sqrt((1.2 * 1.2 * 29) / 30)
    const rs = [...Array(15).fill(0.4 + d), ...Array(15).fill(0.4 - d)] as number[]
    const s = rStats(rs)
    expect(s.n).toBe(30)
    expect(s.expectancy).toBeCloseTo(0.4, 10)
    expect(s.sqn).not.toBeNull()
    expect(Math.abs((s.sqn as number) - 1.83)).toBeLessThan(0.01)
    expect(s.sqn).toBeCloseTo((0.4 / 1.2) * Math.sqrt(30), 8)
  })
  it('n = 29 -> null, n = 30 appears (Review Focus 3)', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? -1 : 2))
    expect(rStats(mk(29)).sqn).toBeNull()
    expect(rStats(mk(30)).sqn).not.toBeNull()
  })
  it('zero stdev -> null, never Infinity or NaN', () => {
    const s = rStats(Array(40).fill(1))
    expect(s.sqn).toBeNull()
    expect(rStats(Array(40).fill(0)).sqn).toBeNull()
  })
  it('empty and junk input: no NaN anywhere, non-finite entries are dropped and not counted', () => {
    const e = rStats([])
    expect(e.n).toBe(0)
    expect(e.expectancy).toBeNull()
    expect(e.winRate).toBeNull()
    expect(e.avgWinR).toBeNull()
    expect(e.avgLossR).toBeNull()
    expect(e.curve).toEqual([])
    const j = rStats([1, Number.NaN, Number.POSITIVE_INFINITY, -1])
    expect(j.n).toBe(2)
    expect(j.expectancy).toBe(0)
  })
  it('no wins -> avg win null; no losses -> avg loss null; breakeven counts in n only', () => {
    const a = rStats([-1, -2, 0])
    expect(a.avgWinR).toBeNull()
    expect(a.avgLossR).toBeCloseTo(-1.5, 10)
    expect(a.winRate).toBe(0)
    const b = rStats([1, 0])
    expect(b.avgLossR).toBeNull()
    expect(b.winRate).toBe(0.5)
  })
  it('curve = cumulative sum in the order given', () => {
    expect(rStats([2, -1, -1, 3, -1]).curve).toEqual([2, 1, 0, 3, 2])
  })
  it('orderByClose sorts by close time (ISO strings or ms) and keeps undated entries last, in their order', () => {
    const out = orderByClose([
      { r: 3, closedAt: '2026-11-05T15:30:00Z' },
      { r: 1, closedAt: '2026-11-01T15:30:00Z' },
      { r: 9 },
      { r: 2, closedAt: Date.parse('2026-11-03T00:00:00Z') },
    ])
    expect(out).toEqual([1, 2, 3, 9])
  })
})

describe('rStats histogram: 0.5R bins from -3R to +5R with outer buckets', () => {
  const h = rStats([-5, -3, -2.99, -0.5, -0.01, 0, 0.49, 0.5, 4.99, 5, 9]).histogram
  const at = (label: string) => h.find((b) => b.label === label)?.count
  it('has 16 inner bins plus two outer ones, counts add up to n', () => {
    expect(h).toHaveLength(18)
    expect(h.reduce((s, b) => s + b.count, 0)).toBe(11)
    expect(h[0]).toMatchObject({ lo: null, hi: -3 })
    expect(h[17]).toMatchObject({ lo: 5, hi: null })
  })
  it('lower edge inclusive, upper edge exclusive', () => {
    expect(at('< -3R')).toBe(1) // -5
    expect(at('-3R to -2.5R')).toBe(2) // -3 and -2.99
    expect(at('-0.5R to 0R')).toBe(2) // -0.5 and -0.01
    expect(at('0R to 0.5R')).toBe(2) // 0 and 0.49
    expect(at('0.5R to 1R')).toBe(1)
    expect(at('4.5R to 5R')).toBe(1) // 4.99
    expect(at('>= 5R')).toBe(2) // 5 and 9
  })
})

describe('sqnText', () => {
  it('under 30 trades: "n=12, too few to rank"; zero stdev at 30+: "-"; otherwise two decimals', () => {
    expect(sqnText(12, null)).toBe('n=12, too few to rank')
    expect(sqnText(40, null)).toBe('-')
    expect(sqnText(30, 1.8257)).toBe('1.83')
    expect(sqnText(0, null)).toBe('n=0, too few to rank')
  })
})

describe('heatReadout (informational only, Review Focus 4)', () => {
  it('two positions $250 and $400 on 25000 -> $650, 2.6%', () => {
    const h = heatReadout(25000, [
      { id: 'a', plannedRiskUsd: 250 },
      { id: 'b', plannedRiskUsd: 400 },
    ])
    expect(h.totalUsd).toBe(650)
    expect(h.pctOfEquity).toBeCloseTo(2.6, 10)
    expect(h.counted).toBe(2)
    expect(h.unknown).toEqual([])
  })
  it('a position with no recorded risk is listed as unknown and never counted as zero', () => {
    const h = heatReadout(25000, [
      { id: 'a', plannedRiskUsd: 250 },
      { id: 'b', plannedRiskUsd: 400 },
      { id: 'c', plannedRiskUsd: null },
      { id: 'd' },
      { id: 'e', plannedRiskUsd: 0 },
      { id: 'f', plannedRiskUsd: Number.NaN },
    ])
    expect(h.totalUsd).toBe(650)
    expect(h.counted).toBe(2)
    expect(h.unknown).toEqual(['c', 'd', 'e', 'f'])
  })
  it('equity unavailable or zero -> pct is null, dollars still shown; nothing open -> $0', () => {
    expect(heatReadout(null, [{ id: 'a', plannedRiskUsd: 10 }]).pctOfEquity).toBeNull()
    expect(heatReadout(0, [{ id: 'a', plannedRiskUsd: 10 }]).pctOfEquity).toBeNull()
    expect(heatReadout(25000, []).totalUsd).toBe(0)
  })
})
