import { describe, expect, it } from 'vitest'
import { atrLevels } from '../../src/chart/tmDesk/atr'
import { computeOverlay, type OverlayOptions } from '../../src/chart/tmDesk/overlay'

const opts: OverlayOptions = { lookbackOverride: null, narrow: false, side: 'long', fvg: true }
const mk = (i: number, c = 100 + i) => ({ timestamp: i * 86_400_000, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 10 })

describe('atrLevels', () => {
  it('long wide', () => {
    const l = atrLevels(100, 2, 'long', false)!
    expect([l.sl, l.tp1, l.tp2, l.tp3]).toEqual([97, 104, 107, 111])
  })
  it('long narrow', () => {
    const l = atrLevels(100, 2, 'long', true)!
    expect([l.sl, l.tp1, l.tp2, l.tp3]).toEqual([98, 103, 105, 108])
  })
  it('short wide mirrors', () => {
    const l = atrLevels(100, 2, 'short', false)!
    expect([l.sl, l.tp1, l.tp2, l.tp3]).toEqual([103, 96, 93, 89])
  })
  it('bad input gives null', () => {
    expect(atrLevels(100, NaN, 'long', false)).toBeNull()
    expect(atrLevels(NaN, 2, 'long', false)).toBeNull()
  })
})

describe('computeOverlay', () => {
  it('fewer bars than lookback / ATR length / 200: NaN and null, no throw, no Infinity', () => {
    const bars = Array.from({ length: 10 }, (_, i) => mk(i))
    const o = computeOverlay(bars, '1D', opts)
    expect(o.fib).toBeNull()
    expect(o.atr).toBeNull()
    expect(o.sma.p200.every(Number.isNaN)).toBe(true)
    expect(o.sma.p20.every(Number.isNaN)).toBe(true)
    expect(o.rangePos).toBeNaN()
    expect(o.fvg).toEqual([])
  })
  it('empty bars', () => {
    const o = computeOverlay([], '15m', opts)
    expect(o.fib).toBeNull()
    expect(o.sma.p50).toEqual([])
  })
  it('enough bars: fib, atr and smas come out finite', () => {
    const bars = Array.from({ length: 260 }, (_, i) => mk(i, 100 + Math.sin(i / 5) * 10 + i * 0.1))
    const o = computeOverlay(bars, '1D', opts)
    expect(o.fib).not.toBeNull()
    expect(o.atr!.len).toBe(34)
    expect(Number.isFinite(o.atr!.value)).toBe(true)
    expect(o.atr!.levels.sl).toBeLessThan(bars[259]!.close)
    expect(Number.isFinite(o.sma.p200[259]!)).toBe(true)
    expect(Number.isFinite(o.rangePos)).toBe(true)
    expect(o.lookback).toBe(100)
  })
  it('flat bars: no fib', () => {
    const bars = Array.from({ length: 150 }, (_, i) => ({ timestamp: i * 86_400_000, open: 10, high: 10, low: 10, close: 10, volume: 1 }))
    const o = computeOverlay(bars, '1D', opts)
    expect(o.fib).toBeNull()
    expect(o.rangePos).toBeNaN()
  })
  it('fvg:false skips the engine', () => {
    const bars = Array.from({ length: 150 }, (_, i) => mk(i * 10))
    expect(computeOverlay(bars, '1D', { ...opts, fvg: false }).fvg).toEqual([])
  })
})
