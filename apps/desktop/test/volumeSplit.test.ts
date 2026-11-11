import { describe, expect, it } from 'vitest'
import { aggregateCandles, type Candle } from '../src/chart/bars'
import { buyShare, splitVolume } from '../src/chart/volumeSplit'
import { DEFAULT_VOLUME_MODE, parseVolumeMode, volumeTitle, VOLUME_MODES } from '../src/chart/volumeMode'
import { planVolume, type VolColors, type VolGeometry } from '../src/chart/volumePlan'

const b = (o: number, h: number, l: number, c: number, v: number, t = 0): Candle => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v })

describe('buyShare / splitVolume (ESTIMATED from the close position in the range)', () => {
  it('close at the high is all buy, at the low all sell, mid is half', () => {
    expect(buyShare(b(1, 10, 0, 10, 100))).toBe(1)
    expect(buyShare(b(1, 10, 0, 0, 100))).toBe(0)
    expect(buyShare(b(1, 10, 0, 5, 100))).toBe(0.5)
    expect(buyShare(b(1, 10, 0, 7.5, 100))).toBe(0.75)
  })
  it('a flat bar (high == low) splits 50/50', () => {
    expect(splitVolume(b(5, 5, 5, 5, 200))).toEqual({ total: 200, buy: 100, sell: 100 })
  })
  it('clamps a close outside the range into 0..1', () => {
    expect(buyShare(b(1, 10, 0, 99, 1))).toBe(1)
    expect(buyShare(b(1, 10, 0, -99, 1))).toBe(0)
  })
  it('buy + sell always equals total', () => {
    const s = splitVolume(b(1, 3, 1, 2.2, 12345))
    expect(s.buy + s.sell).toBeCloseTo(12345, 9)
    expect(s.total).toBe(12345)
  })
  it('zero, negative and NaN volume are an empty split', () => {
    for (const v of [0, -5, NaN, Infinity]) expect(splitVolume(b(1, 2, 0, 1, v))).toEqual({ total: 0, buy: 0, sell: 0 })
  })
  it('NaN or infinite prices fall back to 50/50 (never NaN out)', () => {
    for (const bad of [b(1, NaN, 0, 1, 100), b(1, 2, NaN, 1, 100), b(1, 2, 0, NaN, 100), b(1, Infinity, 0, 1, 100)]) {
      const s = splitVolume(bad)
      expect(s).toEqual({ total: 100, buy: 50, sell: 50 })
    }
  })
  it('an inverted range (high < low) is treated as flat', () => {
    expect(buyShare(b(1, 0, 10, 5, 100))).toBe(0.5)
  })
  it('aggregated bars split from the AGGREGATED bar, not from the sum of the parts', () => {
    // two 5m bars: first closes at its high, second at its low; aggregate range 0..10, close 0 -> all sell
    const parts = [b(5, 10, 5, 10, 100, 0), b(10, 10, 0, 0, 100, 300_000)]
    const agg = aggregateCandles(parts, 2, 300_000)
    expect(agg).toHaveLength(1)
    expect(splitVolume(agg[0]!)).toEqual({ total: 200, buy: 0, sell: 200 })
    const naive = splitVolume(parts[0]!).buy + splitVolume(parts[1]!).buy
    expect(naive).toBe(100)
  })
})

describe('volume mode setting', () => {
  it('parses the three modes and falls back to the default', () => {
    expect(parseVolumeMode('vol')).toBe('vol')
    expect(parseVolumeMode('split')).toBe('split')
    expect(parseVolumeMode('off')).toBe('off')
    for (const bad of [null, undefined, '', 'VOL', 'on', '{"x":1}']) expect(parseVolumeMode(bad)).toBe(DEFAULT_VOLUME_MODE)
  })
  it('offers exactly Vol / Vol est. buy-sell / off, and the split pane title says est.', () => {
    expect(VOLUME_MODES.map((m) => m.id)).toEqual(['vol', 'split', 'off'])
    expect(VOLUME_MODES.find((m) => m.id === 'split')!.label).toMatch(/est\./)
    expect(volumeTitle('split')).toMatch(/est\./)
    expect(volumeTitle('off')).toBe('')
    expect(volumeTitle('vol')).not.toMatch(/est/)
  })
})

const colors: VolColors = { up: '#up', down: '#dn', buy: '#buy', sell: '#sell' }
const geo = (over: Partial<VolGeometry> = {}): VolGeometry => ({ x: (i) => 10 * i + 5, y: (v) => 100 - v, yBase: 100, barW: 6, from: 0, to: 9, ...over })

describe('planVolume', () => {
  it('plain mode: one column per bar, up color when close >= open, height from the y mapping', () => {
    const r = planVolume([b(1, 2, 0, 2, 40), b(2, 2, 0, 1, 30)], 'vol', geo(), colors)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ color: '#up', x: 2, w: 6, y: 60, h: 40 })
    expect(r[1]).toMatchObject({ color: '#dn', y: 70, h: 30 })
  })
  it('split mode: buy column from the base, sell stacked on top, together as tall as the total', () => {
    const r = planVolume([b(1, 10, 0, 7.5, 40)], 'split', geo(), colors)
    const buy = r.find((x) => x.color === '#buy')!
    const sell = r.find((x) => x.color === '#sell')!
    expect(buy.h).toBeCloseTo(30)
    expect(sell.h).toBeCloseTo(10)
    expect(buy.y + buy.h).toBeCloseTo(100)
    expect(sell.y + sell.h).toBeCloseTo(buy.y)
    expect(buy.h + sell.h).toBeCloseTo(40)
  })
  it('skips zero-volume bars, NaN volume and bars outside from..to; clamps the range to the data', () => {
    const bars = [b(1, 2, 0, 1, 0), b(1, 2, 0, 1, NaN), b(1, 2, 0, 2, 10), b(1, 2, 0, 2, 10)]
    expect(planVolume(bars, 'vol', geo(), colors)).toHaveLength(2)
    expect(planVolume(bars, 'vol', geo({ from: 3, to: 99 }), colors)).toHaveLength(1)
    expect(planVolume(bars, 'vol', geo({ from: -5, to: 1 }), colors)).toHaveLength(0)
  })
  it('never emits a negative height or a NaN coordinate', () => {
    const r = planVolume([b(1, 2, 0, 2, 40)], 'split', geo({ y: () => NaN }), colors)
    expect(r).toEqual([])
    const r2 = planVolume([b(1, 2, 0, 2, 400)], 'vol', geo({ y: (v) => 100 - v }), colors)
    for (const x of r2) expect(x.h).toBeGreaterThanOrEqual(0)
  })
})
