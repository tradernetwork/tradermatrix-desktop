import { describe, it, expect } from 'vitest'
import { batch } from '../src/ta/kernel'
import { sma, ema, wma, rma, hma, vwma, alma, swma } from '../src/ta/ma'

const X = [1, 2, 3, 4, 5].map(v => [v])
function close(a: number[], b: number[]) {
  expect(a.length).toBe(b.length)
  a.forEach((v, i) => (Number.isNaN(b[i]) ? expect(v).toBeNaN() : expect(v).toBeCloseTo(b[i], 9)))
}
describe('moving averages', () => {
  it('sma', () => close(batch(sma, [3], X), [NaN, NaN, 2, 3, 4]))
  it('ema seeds with sma', () => close(batch(ema, [3], X), [NaN, NaN, 2, 3, 4]))
  it('wma', () => close(batch(wma, [3], X), [NaN, NaN, 14 / 6, 20 / 6, 26 / 6]))
  it('rma', () => close(batch(rma, [3], X), [NaN, NaN, 2, 8 / 3, (5 + 16 / 3) / 3]))
  it('swma', () => expect(batch(swma, [], [[1], [2], [3], [4]]).at(-1)).toBeCloseTo(2.5, 9))
  it('alma constant', () => {
    const o = batch(alma, [9, 0.85, 6], Array(20).fill([7]))
    expect(o.slice(0, 8).every(Number.isNaN)).toBe(true)
    expect(o.slice(8).every(v => Math.abs(v - 7) < 1e-9)).toBe(true)
  })
  it('vwma', () => close(batch(vwma, [2], [[1, 1], [3, 3], [5, 0], [6, 0]]), [NaN, 2.5, 3, NaN]))
  it('hma on a line stays on the line (lag removed)', () => {
    const o = batch(hma, [4], Array.from({ length: 20 }, (_, i) => [i + 1]))
    expect(o.at(-1)).toBeCloseTo(20, 9)
    expect(o[0]).toBeNaN()
  })
  it('short history is all NaN, no throw', () => {
    const o = batch(sma, [200], Array.from({ length: 50 }, (_, i) => [i]))
    expect(o.length).toBe(50)
    expect(o.every(Number.isNaN)).toBe(true)
  })
  it('NaN input gives NaN and does not advance the window', () => {
    close(batch(sma, [2], [[1], [NaN], [3]]), [NaN, NaN, 2])
  })
})
