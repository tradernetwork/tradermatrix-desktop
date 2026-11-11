import { describe, expect, it } from 'vitest'
import { aggregateCandles, mergeLast, rangeStart, TIMEFRAMES, toCandles, type Candle, type Timeframe } from '../src/chart/bars'

const row = (t: string, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown = 100, extra: Record<string, unknown> = {}) =>
  ({ begins_at: t, open_price: o, high_price: h, low_price: l, close_price: c, volume: v, ...extra }) as never

const MIN = 60_000
const c = (timestamp: number, open: number, high: number, low: number, close: number, volume = 10): Candle => ({
  timestamp,
  open,
  high,
  low,
  close,
  volume,
})
const tf = (id: string): Timeframe => TIMEFRAMES.find((t) => t.id === id)!

describe('TIMEFRAMES', () => {
  it('has the twelve ids and the Robinhood fixed intervals', () => {
    expect(TIMEFRAMES.map((t) => t.id)).toEqual(['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1D', '1W', '1M'])
    expect(tf('3m')).toMatchObject({ fetchInterval: 'minute', aggregate: 3, barMs: 3 * MIN })
    expect(tf('15m')).toMatchObject({ fetchInterval: '5minute', aggregate: 3, barMs: 15 * MIN })
    expect(tf('2h')).toMatchObject({ fetchInterval: 'hour', aggregate: 2 })
    expect(tf('1D')).toMatchObject({ fetchInterval: 'day', aggregate: 1 })
  })
})

describe('toCandles', () => {
  it('parses string numbers, sorts ascending and dedupes by timestamp (last wins)', () => {
    const out = toCandles([
      row('2026-11-09T15:00:00Z', '3', '4', '2', '3.5'),
      row('2026-11-09T14:00:00Z', '1', '2', '0.5', '1.5'),
      row('2026-11-09T15:00:00Z', 30, 40, 20, 35),
    ])
    expect(out.map((x) => x.timestamp)).toEqual([Date.UTC(2026, 10, 9, 14), Date.UTC(2026, 10, 9, 15)])
    expect(out[0]).toMatchObject({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 })
    expect(out[1]).toMatchObject({ open: 30, close: 35 })
  })
  it('drops null / non-finite OHLC and rows with no usable time', () => {
    const out = toCandles([
      row('2026-11-09T14:00:00Z', null, 2, 1, 1.5),
      row('2026-11-09T14:01:00Z', 1, 'abc', 1, 1.5),
      row('2026-11-09T14:02:00Z', 1, Infinity, 1, 1.5),
      row('', 1, 2, 1, 1.5),
      row('garbage', 1, 2, 1, 1.5),
      row('2026-11-09T14:03:00Z', 1, 2, 1, 1.5),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.timestamp).toBe(Date.UTC(2026, 10, 9, 14, 3))
  })
  it('drops interpolated rows only when volume is 0', () => {
    const out = toCandles([
      row('2026-11-09T14:00:00Z', 1, 1, 1, 1, 0, { interpolated: true }),
      row('2026-11-09T14:01:00Z', 1, 1, 1, 1, null, { interpolated: true }),
      row('2026-11-09T14:02:00Z', 1, 1, 1, 1, 50, { interpolated: true }),
      row('2026-11-09T14:03:00Z', 1, 1, 1, 1, 0, { interpolated: false }),
    ])
    expect(out.map((x) => x.timestamp)).toEqual([Date.UTC(2026, 10, 9, 14, 2), Date.UTC(2026, 10, 9, 14, 3)])
  })
  it('treats a missing volume as 0 and handles 0, 1 and 2 rows', () => {
    expect(toCandles([])).toEqual([])
    expect(toCandles([row('2026-11-09T14:00:00Z', 1, 2, 1, 2, null)])[0]!.volume).toBe(0)
    expect(toCandles([row('2026-11-09T14:00:00Z', 1, 2, 1, 2), row('2026-11-09T14:01:00Z', 2, 3, 2, 3)])).toHaveLength(2)
  })
})

describe('aggregateCandles', () => {
  const t0 = Date.UTC(2026, 10, 9, 14, 30)
  const mins = (n: number, start = t0) => Array.from({ length: n }, (_, i) => c(start + i * MIN, 10 + i, 12 + i, 9 + i, 11 + i, 5))

  it('3m from 7 minute bars gives 3 candles with correct OHLCV, last partial', () => {
    const out = aggregateCandles(mins(7), 3, MIN)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ timestamp: t0, open: 10, high: 14, low: 9, close: 13, volume: 15 })
    expect(out[1]).toEqual({ timestamp: t0 + 3 * MIN, open: 13, high: 17, low: 12, close: 16, volume: 15 })
    expect(out[2]).toEqual({ timestamp: t0 + 6 * MIN, open: 16, high: 18, low: 15, close: 17, volume: 5, partial: true })
    expect(out[0]!.partial).toBeUndefined()
  })
  it('aligns to the epoch grid, not to array index (14:31 start into 15m buckets)', () => {
    const out = aggregateCandles(mins(20, t0 + MIN), 15, MIN)
    expect(out.map((x) => x.timestamp)).toEqual([t0, t0 + 15 * MIN])
    expect(out[0]!.volume).toBe(5 * 14) // 14:31..14:44
    expect(out[1]!.partial).toBe(true) // 14:45..14:50 = 6 bars of 15
  })
  it('factor 1 returns the input unchanged and tiny inputs do not throw', () => {
    const m = mins(2)
    expect(aggregateCandles(m, 1, MIN)).toEqual(m)
    expect(aggregateCandles([], 3, MIN)).toEqual([])
    expect(aggregateCandles(mins(1), 3, MIN)).toHaveLength(1)
    expect(aggregateCandles(mins(1), 3, MIN)[0]!.partial).toBe(true)
    expect(aggregateCandles(mins(2), 3, MIN)).toHaveLength(1)
  })
  it('a full last bucket is not flagged partial', () => {
    const out = aggregateCandles(mins(3), 3, MIN)
    expect(out).toHaveLength(1)
    expect(out[0]!.partial).toBeUndefined()
  })
})

describe('rangeStart', () => {
  it('is RFC3339 UTC and exactly now - lookbackMs', () => {
    const now = Date.UTC(2026, 10, 10, 12, 0, 0)
    const t = tf('5m')
    const s = rangeStart(t, now)
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Date.parse(s)).toBe(now - t.lookbackMs)
  })
})

describe('mergeLast', () => {
  const t5 = tf('5m')
  const base = Date.UTC(2026, 10, 9, 14, 30)
  const last = c(base, 10, 11, 9, 10.5, 100)

  it('raises high, lowers low, sets close inside the current bucket', () => {
    const up = mergeLast([last], 12, null, base + MIN, t5)
    expect(up).toHaveLength(1)
    expect(up[0]).toMatchObject({ open: 10, high: 12, low: 9, close: 12, volume: 100 })
    const dn = mergeLast([last], 8, null, base + 2 * MIN, t5)
    expect(dn[0]).toMatchObject({ high: 11, low: 8, close: 8 })
    expect(last.close).toBe(10.5) // input untouched
  })
  // F6 (deliberate change): a quote never creates a bar. Past the window the bars come back unchanged and the
  // periodic history re-fetch brings the real bar (this is what stopped phantom after-hours candles).
  it('does NOT append a candle when now crosses the bucket edge', () => {
    expect(mergeLast([last], 10.8, null, base + 5 * MIN + 1000, t5)).toEqual([last])
  })
  it('does not open a candle on a gap either', () => {
    expect(mergeLast([last], 13, null, base + 5 * MIN, t5)).toEqual([last])
  })
  it('never reorders: a clock earlier than the last candle extends it', () => {
    const out = mergeLast([last], 10.6, null, base - MIN, t5)
    expect(out).toHaveLength(1)
    expect(out[0]!.close).toBe(10.6)
  })
  it('ignores empty input, non-finite prices, and does not open phantom daily bars', () => {
    expect(mergeLast([], 10, null, base, t5)).toEqual([])
    expect(mergeLast([last], NaN, null, base, t5)).toEqual([last])
    const d = tf('1D')
    const day = c(base, 10, 11, 9, 10.5)
    expect(mergeLast([day], 12, null, base + 3 * 86_400_000, d)).toEqual([day])
    expect(mergeLast([day], 12, null, base + 3600_000, d)[0]!.close).toBe(12)
  })
  it('takes a larger volume when provided', () => {
    expect(mergeLast([last], 10.6, 250, base + MIN, t5)[0]!.volume).toBe(250)
    expect(mergeLast([last], 10.6, 50, base + MIN, t5)[0]!.volume).toBe(100)
  })
})
