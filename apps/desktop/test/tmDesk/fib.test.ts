import { describe, expect, it } from 'vitest'
import { computeFib, rangePosition } from '../../src/chart/tmDesk/fib'

const at = (f: NonNullable<ReturnType<typeof computeFib>>, r: number) => f.levels.find((l) => l.ratio === r)!.price

describe('computeFib', () => {
  it('uptrend: close 190 in 100..200', () => {
    const f = computeFib(200, 100, 190, false)!
    expect(f.up).toBe(true)
    expect(at(f, 0.618)).toBeCloseTo(161.8, 6)
    expect(at(f, 1.272)).toBeCloseTo(227.2, 6)
    expect(f.zone.lo).toBeCloseTo(123.6, 6)
    expect(f.zone.hi).toBeCloseTo(138.2, 6)
    expect(f.levels.some((l) => l.ratio === 0.886)).toBe(false)
  })
  it('downtrend: close 110, extensions go beyond the swing low', () => {
    const f = computeFib(200, 100, 110, false)!
    expect(f.up).toBe(false)
    expect(at(f, 0.618)).toBeCloseTo(138.2, 6)
    expect(at(f, 1.618)).toBeCloseTo(38.2, 6)
    expect(f.zone.hi).toBeCloseTo(138.2, 6)
    expect(f.zone.lo).toBeCloseTo(121.4, 6)
  })
  it('position exactly 0.55 is NOT an uptrend (strict)', () => {
    expect(computeFib(200, 100, 155, false)!.up).toBe(false)
  })
  it('0.886 only when asked', () => {
    expect(computeFib(200, 100, 190, true)!.levels.some((l) => l.ratio === 0.886)).toBe(true)
  })
  it('flat or non-finite swing gives null, never Infinity lines', () => {
    expect(computeFib(100, 100, 100, false)).toBeNull()
    expect(computeFib(NaN, 100, 100, false)).toBeNull()
    expect(computeFib(200, 100, NaN, false)).toBeNull()
  })
  it('rangePosition', () => {
    expect(rangePosition(150, 200, 100)).toBe(0.5)
    expect(rangePosition(150, 100, 100)).toBeNaN()
  })
})
