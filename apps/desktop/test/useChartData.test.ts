import type { Chart, DataLoaderGetBarsParams, KLineData } from 'klinecharts'
import { describe, expect, it, vi } from 'vitest'
import { rangeStart, timeframeById, DEFAULT_TIMEFRAME, type Candle } from '../src/chart/bars'
import { ChartFeed, loadCandles, nextBars, normalizeSymbol, periodOf, pushData, RequestGuard, shouldPoll } from '../src/chart/useChartData'
import { api, fakeRh, type RhHistorical, type RhQuote } from '../src/lib/api'

const NOW = Date.UTC(2026, 10, 10, 15, 0, 0)
const hist = (symbol: string, bars: RhHistorical['bars']): RhHistorical => ({ symbol, interval: 'day', bounds: 'regular', bars })
const bar = (t: string, o: number, h: number, l: number, c: number, v = 100) => ({ begins_at: t, open_price: o, high_price: h, low_price: l, close_price: c, volume: v })
const quote = (symbol: string, last: number | null): RhQuote => ({ symbol, bid_price: null, ask_price: null, last_trade_price: last, previous_close: null })

describe('symbol validation', () => {
  it('uppercases, trims, accepts 1-6 chars of A-Z and dot', () => {
    expect(normalizeSymbol(' aapl ')).toBe('AAPL')
    expect(normalizeSymbol('brk.b')).toBe('BRK.B')
    expect(normalizeSymbol('A')).toBe('A')
    expect(normalizeSymbol('ABCDEF')).toBe('ABCDEF')
    // F7 (deliberate change): the chart takes the one equity rule ^[A-Z][A-Z0-9.-]{0,9}$ (digits, '-' and up to 10 chars)
    expect(normalizeSymbol('ABCDEFG')).toBe('ABCDEFG')
    expect(normalizeSymbol('A1')).toBe('A1')
    expect(normalizeSymbol('BF-B')).toBe('BF-B')
  })
  it('rejects empty, too long, leading digit and punctuation', () => {
    for (const bad of ['', '   ', 'ABCDEFGHIJK', '1A', 'A B', '$', '../x', 'ＡＢ', 'BTC/USD']) expect(normalizeSymbol(bad)).toBeNull()
  })
})

describe('RequestGuard', () => {
  it('only the newest ticket is current', () => {
    const g = new RequestGuard()
    const a = g.next()
    expect(g.isCurrent(a)).toBe(true)
    const b = g.next()
    expect(g.isCurrent(a)).toBe(false)
    expect(g.isCurrent(b)).toBe(true)
  })
})

describe('loadCandles', () => {
  it('requests the fixed interval and rangeStart, parses and aggregates', async () => {
    const tf = timeframeById('15m')
    const fetcher = vi.fn(async () => [
      hist('SPY', [
        bar('2026-11-09T14:30:00Z', 1, 2, 0.5, 1.5),
        bar('2026-11-09T14:35:00Z', 1.5, 3, 1, 2),
        bar('2026-11-09T14:40:00Z', 2, 2.5, 1.8, 2.2),
        bar('2026-11-09T14:45:00Z', 2.2, 2.4, 2, 2.1),
      ]),
    ])
    const r = await loadCandles(fetcher, 'SPY', tf, NOW)
    expect(fetcher).toHaveBeenCalledWith('SPY', '5minute', rangeStart(tf, NOW))
    expect(r.error).toBeNull()
    expect(r.candles).toHaveLength(2)
    expect(r.candles[0]).toMatchObject({ timestamp: Date.UTC(2026, 10, 9, 14, 30), open: 1, high: 3, low: 0.5, close: 2.2 })
    expect(r.candles[1]!.partial).toBe(true)
  })
  it('empty results, empty bars and not_found all say no data for SYMBOL', async () => {
    const tf = timeframeById('1D')
    expect((await loadCandles(async () => [], 'ZZZ', tf, NOW)).error).toBe('no data for ZZZ')
    expect((await loadCandles(async () => [hist('ZZZ', [])], 'ZZZ', tf, NOW)).error).toBe('no data for ZZZ')
    const nf = await loadCandles(async () => Promise.reject(new Error('tool error: not_found: no such symbol')), 'ZZZ', tf, NOW)
    expect(nf).toEqual({ candles: [], error: 'no data for ZZZ' })
  })
  it('other errors surface their message and never throw', async () => {
    const r = await loadCandles(async () => Promise.reject(new Error('not connected to Robinhood')), 'SPY', timeframeById('1D'), NOW)
    expect(r.candles).toEqual([])
    expect(r.error).toBe('not connected to Robinhood')
    const s = await loadCandles(async () => Promise.reject('boom'), 'SPY', timeframeById('1D'), NOW)
    expect(s.error).toBe('boom')
  })
  it('picks the matching symbol when several come back, defaulting to the first', async () => {
    const r = await loadCandles(async () => [hist('QQQ', [bar('2026-11-09T00:00:00Z', 9, 9, 9, 9)]), hist('SPY', [bar('2026-11-09T00:00:00Z', 1, 1, 1, 1)])], 'SPY', timeframeById('1D'), NOW)
    expect(r.candles[0]!.open).toBe(1)
  })
  it('one-bar data is returned as is', async () => {
    const r = await loadCandles(async () => [hist('SPY', [bar('2026-11-09T00:00:00Z', 1, 1, 1, 1)])], 'SPY', timeframeById('1D'), NOW)
    expect(r.candles).toHaveLength(1)
    expect(r.error).toBeNull()
  })
})

describe('polling decision and merge', () => {
  const tf = timeframeById('5m')
  const last: Candle = { timestamp: NOW - 60_000, open: 10, high: 11, low: 9, close: 10.5, volume: 5 }
  it('shouldPoll skips when hidden, without data, or without a symbol', () => {
    expect(shouldPoll({ hidden: false, haveData: true, symbol: 'SPY' })).toBe(true)
    expect(shouldPoll({ hidden: true, haveData: true, symbol: 'SPY' })).toBe(false)
    expect(shouldPoll({ hidden: false, haveData: false, symbol: 'SPY' })).toBe(false)
    expect(shouldPoll({ hidden: false, haveData: true, symbol: null })).toBe(false)
  })
  it('nextBars merges the quote price and reports a change', () => {
    const r = nextBars([last], quote('SPY', 12), NOW - 30_000, tf)
    expect(r.changed).toBe(true)
    expect(r.bars[0]).toMatchObject({ high: 12, close: 12 })
  })
  it('nextBars ignores missing quotes, null prices and an unchanged price', () => {
    expect(nextBars([last], undefined, NOW, tf).changed).toBe(false)
    expect(nextBars([last], quote('SPY', null), NOW, tf).changed).toBe(false)
    expect(nextBars([last], quote('SPY', 10.5), NOW - 30_000, tf).changed).toBe(false)
    expect(nextBars([], quote('SPY', 10), NOW, tf).changed).toBe(false)
  })
  // F6 (deliberate change): nextBars never opens a candle from a quote.
  it('nextBars does not open a new candle across the bucket edge', () => {
    const old = { ...last, timestamp: Math.floor(NOW / 300_000) * 300_000 - 300_000 }
    const r = nextBars([old], quote('SPY', 11), NOW, tf)
    expect(r.bars).toHaveLength(1)
    expect(r.changed).toBe(false)
  })
})

describe('default timeframe', () => {
  it('is 1D', () => {
    expect(DEFAULT_TIMEFRAME).toBe('1D')
    expect(timeframeById('nonsense').id).toBe('1D')
  })
})

describe('periodOf', () => {
  it('maps every timeframe to a KLineChart period', () => {
    expect(periodOf(timeframeById('1m'))).toEqual({ type: 'minute', span: 1 })
    expect(periodOf(timeframeById('15m'))).toEqual({ type: 'minute', span: 15 })
    expect(periodOf(timeframeById('2h'))).toEqual({ type: 'hour', span: 2 })
    expect(periodOf(timeframeById('1D'))).toEqual({ type: 'day', span: 1 })
    expect(periodOf(timeframeById('1W'))).toEqual({ type: 'week', span: 1 })
    expect(periodOf(timeframeById('1M'))).toEqual({ type: 'month', span: 1 })
  })
})

describe('ChartFeed and pushData (KLineChart v10 data loader flow)', () => {
  const candles: Candle[] = [
    { timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { timestamp: 2000, open: 1.5, high: 2, low: 1, close: 1.8, volume: 20 },
  ]
  const params = (type: DataLoaderGetBarsParams['type'], cb: DataLoaderGetBarsParams['callback']): DataLoaderGetBarsParams =>
    ({ type, timestamp: null, symbol: { ticker: 'X', pricePrecision: 2, volumePrecision: 0 }, period: { type: 'day', span: 1 }, callback: cb })

  it('init returns the held data as KLineData with no more pages; other types return empty', () => {
    const feed = new ChartFeed()
    feed.setData(candles)
    const cb = vi.fn()
    void feed.loader.getBars(params('init', cb))
    expect(cb).toHaveBeenCalledWith([expect.objectContaining({ timestamp: 1000, open: 1, volume: 10 }), expect.objectContaining({ timestamp: 2000, close: 1.8 })], false)
    const cb2 = vi.fn()
    void feed.loader.getBars(params('forward', cb2))
    expect(cb2).toHaveBeenCalledWith([], false)
  })
  it('strips the partial flag from nothing it should keep and keeps timestamps untouched', () => {
    const feed = new ChartFeed()
    feed.setData([{ ...candles[0]!, partial: true }])
    const cb = vi.fn()
    void feed.loader.getBars(params('init', cb))
    const d = (cb.mock.calls[0]![0] as KLineData[])[0]!
    expect(d.timestamp).toBe(1000)
  })
  it('pushLast reaches the subscribed callback and stops after unsubscribe', () => {
    const feed = new ChartFeed()
    const sub = vi.fn()
    feed.loader.subscribeBar!({ symbol: { ticker: 'X', pricePrecision: 2, volumePrecision: 0 }, period: { type: 'day', span: 1 }, callback: sub })
    feed.pushLast(candles[1]!)
    expect(sub).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 2000, close: 1.8 }))
    feed.loader.unsubscribeBar!({ symbol: { ticker: 'X', pricePrecision: 2, volumePrecision: 0 }, period: { type: 'day', span: 1 } })
    feed.pushLast(candles[1]!)
    expect(sub).toHaveBeenCalledTimes(1)
  })
  it('pushData loads the feed first, then sets symbol and period (each of which triggers a data load)', () => {
    const feed = new ChartFeed()
    const order: string[] = []
    const chart = {
      setSymbol: vi.fn((s: { ticker: string }) => order.push(`symbol:${s.ticker}:${(feed as unknown as { data: unknown[] }).data.length}`)),
      setPeriod: vi.fn((p: { type: string; span: number }) => order.push(`period:${p.type}${p.span}`)),
    } as unknown as Chart
    pushData(chart, feed, 'SPY', timeframeById('15m'), candles)
    expect(order).toEqual(['symbol:SPY:2', 'period:minute15'])
  })
  it('pushData picks a price precision from the data', () => {
    const feed = new ChartFeed()
    const setSymbol = vi.fn()
    const chart = { setSymbol, setPeriod: vi.fn() } as unknown as Chart
    pushData(chart, feed, 'PENNY', timeframeById('1D'), [{ timestamp: 1, open: 0.05, high: 0.06, low: 0.04, close: 0.05, volume: 1 }])
    expect(setSymbol.mock.calls[0]![0].pricePrecision).toBe(4)
    pushData(chart, feed, 'SPY', timeframeById('1D'), candles)
    expect(setSymbol.mock.calls[1]![0].pricePrecision).toBe(2)
  })
})

describe('fake historicals backend', () => {
  it('returns ascending, deterministic, capped bars honoring the interval, and no bars for NOPE', async () => {
    fakeRh.reset()
    const start = rangeStart(timeframeById('5m'), NOW)
    const a = await api.rhHistoricals('AAA', '5minute', start)
    const b = await api.rhHistoricals('AAA', '5minute', start)
    expect(a).toEqual(b)
    expect(a[0]!.symbol).toBe('AAA')
    expect(a[0]!.interval).toBe('5minute')
    const bars = a[0]!.bars
    expect(bars.length).toBeGreaterThan(10)
    expect(bars.length).toBeLessThanOrEqual(2500)
    const ts = bars.map((x) => Date.parse(x.begins_at))
    expect(ts).toEqual([...ts].sort((x, y) => x - y))
    expect(ts[1]! - ts[0]!).toBe(300_000)
    for (const x of bars) expect(x.high_price!).toBeGreaterThanOrEqual(Math.max(x.open_price!, x.close_price!))
    const day = await api.rhHistoricals('AAA', 'day', start)
    expect(Date.parse(day[0]!.bars[1]!.begins_at) - Date.parse(day[0]!.bars[0]!.begins_at)).toBeGreaterThanOrEqual(86_400_000)
    expect((await api.rhHistoricals('NOPE', 'day', start))[0]!.bars).toEqual([])
  })
  it('rejects bad symbols, intervals and start like the Rust core', async () => {
    await expect(api.rhHistoricals('bad symbol', 'day', '2026-01-01T00:00:00Z')).rejects.toThrow(/invalid argument/)
    await expect(api.rhHistoricals('AAA', 'fortnight', '2026-01-01T00:00:00Z')).rejects.toThrow(/invalid argument/)
    await expect(api.rhHistoricals('AAA', 'day', 'yesterday')).rejects.toThrow(/invalid argument/)
  })
})
