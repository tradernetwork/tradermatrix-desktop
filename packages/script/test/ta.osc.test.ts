import { describe, it, expect } from 'vitest'
import { batch } from '../src/ta/kernel'
import { rsi, cmo, cci, cog, mfi, tsi, macd, stoch } from '../src/ta/osc'

const col = (a: number[]) => a.map(v => [v])
describe('oscillators', () => {
  it('cmo', () => expect(batch(cmo, [3], col([1, 2, 3, 2])).at(-1)).toBeCloseTo(100 / 3, 9))
  it('cog', () => expect(batch(cog, [3], col([1, 2, 3])).at(-1)).toBeCloseTo(-10 / 6, 9))
  it('tsi strictly +1 steps -> 1', () => {
    const o = batch(tsi, [3, 5], col(Array.from({ length: 30 }, (_, i) => i)))
    expect(o.at(-1)).toBeCloseTo(1, 9)
    expect(o[0]).toBeNaN()
  })
  it('rsi monotone up is 100, down is 0', () => {
    expect(batch(rsi, [5], col([1, 2, 3, 4, 5, 6, 7])).at(-1)).toBe(100)
    expect(batch(rsi, [5], col([7, 6, 5, 4, 3, 2, 1])).at(-1)).toBe(0)
    expect(batch(rsi, [5], col([1, 2, 3, 4, 5, 6, 7]))[4]).toBeNaN()
  })
  it('rsi flat is NaN, not Infinity', () => {
    expect(batch(rsi, [3], col(Array(10).fill(5))).every(Number.isNaN)).toBe(true)
  })
  it('rsi known value (len 2: gains 1,0 -> ag .5, al .5 -> 50)', () => {
    expect(batch(rsi, [2], col([1, 2, 1])).at(-1)).toBeCloseTo(50, 9)
  })
  it('cci with mean deviation', () => {
    // window [1,2,6]: mean 3, meandev (2+1+3)/3=2, cci=(6-3)/(0.015*2)=100
    expect(batch(cci, [3], col([1, 2, 6])).at(-1)).toBeCloseTo(100, 9)
    expect(batch(cci, [3], col(Array(6).fill(4))).every(Number.isNaN)).toBe(true)
  })
  it('mfi', () => {
    // all up -> 100; len 2
    expect(batch(mfi, [2], [[1, 10], [2, 10], [3, 10]]).at(-1)).toBe(100)
    // up then down equal flow: pos 20, neg 20 -> 50
    expect(batch(mfi, [2], [[2, 10], [4, 5], [2, 10]]).at(-1)).toBeCloseTo(50, 9)
  })
  it('macd tuple', () => {
    const o = batch(macd, [2, 3, 2], col([1, 2, 3, 4, 5, 6, 7, 8]))
    const last = o.at(-1)!
    expect(last.length).toBe(3)
    expect(last[2]).toBeCloseTo(last[0] - last[1], 9)
    expect(o[0].every(Number.isNaN)).toBe(true)
  })
  it('stoch raw %K', () => {
    const o = batch(stoch, [3], [[1, 2, 0], [2, 3, 1], [2, 4, 1]])
    expect(o.at(-1)).toBeCloseTo(((2 - 0) / (4 - 0)) * 100, 9)
  })
  it('stoch flat range -> NaN (review focus 1)', () => {
    const o = batch(stoch, [5], Array(20).fill([10, 10, 10]))
    expect(o.every(Number.isNaN)).toBe(true)
    expect(o.some(v => v === Infinity || v === -Infinity)).toBe(false)
  })
})
