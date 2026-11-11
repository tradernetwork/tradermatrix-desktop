import { describe, expect, it } from 'vitest'
import { rma, sma, tr } from '../../src/chart/tmDesk/ta'

const bar = (high: number, low: number, close: number) => ({ high, low, close })

describe('ta', () => {
  it('tr and rma', () => {
    const t = tr([bar(10, 8, 9.5), bar(11, 9, 10), bar(13, 9, 11)])
    expect(t).toEqual([2, 2, 4])
    const a = rma(t, 2)
    expect(a[0]).toBeNaN()
    expect(a[1]).toBe(2)
    expect(a[2]).toBe(3)
  })
  it('tr uses the previous close for gaps', () => {
    expect(tr([bar(10, 9, 9.5), bar(15, 14, 14.5)])[1]).toBe(5.5)
  })
  it('sma by prefix sums; shorter than n is all NaN', () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([NaN, 1.5, 2.5, 3.5])
    expect(sma([1, 2], 5).every(Number.isNaN)).toBe(true)
    expect(rma([1, 2], 5).every(Number.isNaN)).toBe(true)
  })
  it('a NaN input only poisons the windows that contain it', () => {
    const s = sma([1, 2, NaN, 4, 5, 6], 2)
    expect(s[2]).toBeNaN()
    expect(s[3]).toBeNaN()
    expect(s[4]).toBe(4.5)
    expect(s[5]).toBe(5.5)
  })
})
