import { describe, expect, it } from 'vitest'
import { htfSwing } from '../../src/chart/tmDesk/htf'

const MIN = 60_000
const mk = (ts: number, high: number, low = high - 1, close = high - 0.5) => ({ timestamp: ts, open: close, high, low, close, volume: 1 })

describe('htfSwing', () => {
  it('uses the stepped developing HTF series, not a raw window max', () => {
    const highs = [9, 3, 2, 5, 4, 4]
    const bars = highs.map((h, i) => mk(i * MIN, h))
    const r = htfSwing(bars, '1m', 4)
    expect(r.swingHigh).toBe(9) // a raw max over the last 4 chart bars would be 5
    expect(r.htfFallback).toBe(false)
  })
  it('swing low and HTF close come from the developing bucket', () => {
    const bars = [mk(0, 10, 5, 7), mk(MIN, 12, 4, 11), mk(3 * MIN, 8, 6, 6.5)]
    const r = htfSwing(bars, '1m', 3)
    expect(r.swingLow).toBe(4)
    expect(r.htfClose).toBe(6.5)
  })
  it('fewer bars than the lookback gives NaN, no throw', () => {
    const r = htfSwing([mk(0, 5), mk(MIN, 6)], '1D', 100)
    expect(r.swingHigh).toBeNaN()
    expect(r.swingLow).toBeNaN()
  })
  it('empty input', () => {
    expect(htfSwing([], '1D', 100).swingHigh).toBeNaN()
  })
  it('chart coarser than the selected HTF falls back to chart high/low', () => {
    const bars = [mk(0, 10, 1), mk(5 * MIN, 20, 2), mk(10 * MIN, 15, 3)]
    const r = htfSwing(bars, '1h', 3, '3') // a 1h chart cannot request a 3m HTF
    expect(r.htfFallback).toBe(true)
    expect(r.swingHigh).toBe(20)
    expect(r.swingLow).toBe(1)
  })
})
