import { describe, it, expect } from 'vitest'
import { batch } from '../src/ta/kernel'
import { cumsum, diff, accdist, upTrend, downTrend } from '../src/ta/flow'

const col = (a: number[]) => a.map(v => [v])
describe('flow', () => {
  it('cumsum', () => expect(batch(cumsum, [], col([1, 2, 3]))).toEqual([1, 3, 6]))
  it('diff', () => {
    expect(batch(diff, [1], col([1, 3, 6]))).toEqual([NaN, 2, 3])
    expect(batch(diff, [2], col([1, 3, 6]))).toEqual([NaN, NaN, 5])
  })
  it('accdist', () => {
    expect(batch(accdist, [], [[10, 0, 10, 100]])).toEqual([100])
    expect(batch(accdist, [], [[10, 0, 10, 100], [5, 5, 5, 50]])).toEqual([100, 100])
  })
  it('upTrend/downTrend', () => {
    expect(batch(upTrend, [3], col([1, 2, 3, 4])).at(-1)).toBe(1)
    expect(batch(downTrend, [3], col([1, 2, 3, 4])).at(-1)).toBe(0)
    expect(batch(downTrend, [3], col([4, 3, 2, 1])).at(-1)).toBe(1)
    expect(batch(upTrend, [3], col([1, 2, 2, 3])).at(-1)).toBe(0)
    expect(batch(upTrend, [3], col([1, 2, 3]))[2]).toBeNaN()
  })
})
