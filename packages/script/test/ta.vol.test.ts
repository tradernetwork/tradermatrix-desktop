import { describe, it, expect } from 'vitest'
import { batch } from '../src/ta/kernel'
import { tr, atr, bb, kc, dmi } from '../src/ta/vol'

describe('volatility', () => {
  it('tr first bar is high-low, then true range', () => {
    const o = batch(tr, [], [[11, 9, 10], [15, 12, 14]])
    expect(o[0]).toBe(2)
    expect(o[1]).toBe(5) // max(3, |15-10|, |12-10|)
  })
  it('atr seeds with mean of first len tr', () => {
    const o = batch(atr, [2], [[11, 9, 10], [13, 10, 12], [14, 12, 13]])
    expect(o[0]).toBeNaN()
    expect(o[1]).toBeCloseTo(2.5, 9) // tr 2, 3
    expect(o[2]).toBeCloseTo((2.5 + 2) / 2, 9) // tr3 = max(2,2,0)=2
  })
  it('bb population stdev', () => {
    const o = batch(bb, [3, 2], [[1], [2], [3]])
    const sd = Math.sqrt(2 / 3)
    expect(o[2][0]).toBeCloseTo(2, 9)
    expect(o[2][1]).toBeCloseTo(2 + 2 * sd, 9)
    expect(o[2][2]).toBeCloseTo(2 - 2 * sd, 9)
    expect(o[1].every(Number.isNaN)).toBe(true)
  })
  it('kc: ema mid, atr bands', () => {
    const o = batch(kc, [5, 2], Array(20).fill([50, 51, 49, 50]))
    const [m, u, l] = o.at(-1)!
    expect(m).toBeCloseTo(50, 9)
    expect(u).toBeCloseTo(54, 9)
    expect(l).toBeCloseTo(46, 9)
  })
  it('dmi trend up', () => {
    const bars = Array.from({ length: 40 }, (_, i) => [i + 1, i, i + 1])
    const o = batch(dmi, [5, 5], bars)
    const [p, m, a] = o.at(-1)!
    expect(p).toBeCloseTo(100, 6)
    expect(m).toBeCloseTo(0, 6)
    expect(a).toBeCloseTo(100, 6)
    expect(o[0].every(Number.isNaN)).toBe(true)
  })
  it('dmi flat bars -> NaN not Infinity', () => {
    const o = batch(dmi, [5, 5], Array(30).fill([10, 10, 10])).flat()
    expect(o.every(v => !Number.isFinite(v) ? Number.isNaN(v) : true)).toBe(true)
  })
})
