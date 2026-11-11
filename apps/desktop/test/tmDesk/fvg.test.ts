import { describe, expect, it } from 'vitest'
import { computeFvg, limitFvg, type FvgBox } from '../../src/chart/tmDesk/fvg'

const b = (open: number, close: number, high: number, low: number, volume = 5) => ({ timestamp: 0, open, close, high, low, volume })
// bodies .1, 2, 1: bar 2 gaps up over bar 0 (low 11 > high 10)
const base = () => [b(9.9, 10, 10, 9.9, 7), b(10, 12, 12.1, 10), b(11.5, 12.5, 13, 11)]

describe('computeFvg', () => {
  it('one bull box with rgap 2/1.05 > 1', () => {
    const r = computeFvg(base(), { vgN: 2, vgF: 1 })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ left: 0, right: 3, top: 11, bottom: 10, bull: true, vol: 7 })
  })
  it('a higher noise factor finds nothing', () => {
    expect(computeFvg(base(), { vgN: 2, vgF: 2 })).toHaveLength(0)
  })
  it('mitigation is strict at the midpoint (10.5)', () => {
    expect(computeFvg([...base(), b(11, 11.2, 11.5, 10.5)], { vgN: 2, vgF: 1 })).toHaveLength(1)
    expect(computeFvg([...base(), b(11, 11.2, 11.5, 10.4)], { vgN: 2, vgF: 1 })).toHaveLength(0)
  })
  it('survivors extend to last+1', () => {
    const r = computeFvg([...base(), b(11, 11.2, 11.5, 10.6)], { vgN: 2, vgF: 1 })
    expect(r[0]!.right).toBe(4)
  })
  it('bear gap mirrors (removed when high > mid)', () => {
    const bear = [b(10.1, 10, 10.1, 10), b(10, 8, 10, 7.9), b(8.5, 7.5, 9, 7)]
    const r = computeFvg(bear, { vgN: 2, vgF: 1 })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ bull: false, top: 10, bottom: 9, left: 0, right: 3 })
    expect(computeFvg([...bear, b(9, 9.3, 9.6, 8.5)], { vgN: 2, vgF: 1 })).toHaveLength(0) // high 9.6 > mid 9.5
    expect(computeFvg([...bear, b(9, 9.3, 9.5, 8.5)], { vgN: 2, vgF: 1 })).toHaveLength(1) // high 9.5 == mid, kept
  })
  it('caps at maxBoxes (500), dropping the oldest', () => {
    const bars = Array.from({ length: 503 }, (_, i) => b(10 * i, 10 * i + 8, 10 * i + 8, 10 * i))
    const r = computeFvg(bars, { vgN: 2, vgF: 0.5 })
    expect(r).toHaveLength(500)
    expect(r[0]!.left).toBe(1) // 503 bars make 501 boxes (i = 2..502, left = i-2); the oldest (left 0) is shifted out
  })
  it('short input and NaN bars do not throw', () => {
    expect(computeFvg([], { vgN: 2, vgF: 1 })).toEqual([])
    expect(computeFvg([b(NaN, NaN, NaN, NaN), b(1, 2, 3, 0), b(1, 2, 3, 0)], { vgN: 2, vgF: 1 })).toEqual([])
  })
})

describe('limitFvg', () => {
  const box = (bottom: number, top: number, bull = true): FvgBox => ({ left: 0, right: 10, top, bottom, bull, vol: 1 })
  it('keeps at most 6: 3 above and 3 below, nearest first', () => {
    const boxes = [
      ...[1, 2, 3, 4, 5].map((k) => box(100 + k * 10, 101 + k * 10)),
      ...[1, 2, 3, 4, 5].map((k) => box(100 - k * 10 - 1, 100 - k * 10)),
    ]
    const r = limitFvg(boxes, { price: 100, atr: 0.5 })
    expect(r).toHaveLength(6)
    expect(r.filter((x) => x.bottom > 100)).toHaveLength(3)
    expect(Math.min(...r.filter((x) => x.bottom > 100).map((x) => x.bottom))).toBe(110)
    expect(Math.max(...r.map((x) => x.top))).toBe(131)
  })
  it('drops gaps smaller than 0.25 ATR', () => {
    const r = limitFvg([box(110, 110.4), box(120, 121)], { price: 100, atr: 2 }) // min 0.5
    expect(r).toHaveLength(1)
    expect(r[0]!.bottom).toBe(120)
  })
  it('unknown ATR skips the size filter', () => {
    expect(limitFvg([box(110, 110.01)], { price: 100, atr: NaN })).toHaveLength(1)
  })
})
