import { describe, it, expect } from 'vitest'
import { batch } from '../src/ta/kernel'
import { highest, lowest, sum, std, variance, dev, highestOffset, lowestOffset, correlation } from '../src/ta/stat'

const col = (a: number[]) => a.map(v => [v])
describe('stats', () => {
  const X = col([3, 1, 4, 1, 5])
  it('highest/lowest/sum', () => {
    expect(batch(highest, [3], X).at(-1)).toBe(5)
    expect(batch(lowest, [3], X).at(-1)).toBe(1)
    expect(batch(sum, [3], X).at(-1)).toBe(10)
    expect(batch(sum, [3], X)[1]).toBeNaN()
  })
  it('variance/std population', () => {
    expect(batch(variance, [3], col([1, 2, 3])).at(-1)).toBeCloseTo(2 / 3, 9)
    expect(batch(std, [3], col([1, 2, 3])).at(-1)).toBeCloseTo(Math.sqrt(2 / 3), 9)
  })
  it('dev is mean absolute deviation', () => {
    expect(batch(dev, [3], col([1, 2, 6])).at(-1)).toBeCloseTo(2, 9)
  })
  it('highestOffset/lowestOffset: bars back as Pine (<=0), ties -> most recent', () => {
    expect(batch(highestOffset, [3], col([5, 1, 2])).at(-1)).toBe(-2)
    expect(batch(highestOffset, [3], col([5, 1, 5])).at(-1)).toBe(0)
    expect(batch(lowestOffset, [3], col([1, 2, 3])).at(-1)).toBe(-2)
  })
  it('correlation', () => {
    const x = [1, 2, 3, 4, 5, 6]
    expect(batch(correlation, [5], x.map(v => [v, v])).at(-1)).toBeCloseTo(1, 9)
    expect(batch(correlation, [5], x.map(v => [v, -v])).at(-1)).toBeCloseTo(-1, 9)
    expect(batch(correlation, [5], x.map(v => [v, 7])).at(-1)).toBeNaN()
  })
})
