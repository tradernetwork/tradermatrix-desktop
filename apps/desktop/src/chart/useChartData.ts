/**
 * Data layer for the chart pane. The parts here are pure or take their collaborators as arguments so
 * they run in node tests; ChartPane.tsx does the React and DOM wiring.
 *
 * KLineChart v10 has no applyNewData/updateData. Data comes from a DataLoader: setSymbol/setPeriod
 * (and setDataLoader/resetData) call loader.getBars({type: 'init'}), we answer with the held bars, and
 * after the init answer the chart calls loader.subscribeBar, whose callback takes ONE KLineData: same
 * timestamp as the last bar replaces it, a later timestamp appends. That callback is the live update path.
 */
import type { Chart, DataLoader, KLineData, Period, SymbolInfo } from 'klinecharts'
import type { RhHistorical, RhQuote } from '../lib/api'
import { isEquityTicker } from '../lib/symbols'
import { aggregateCandles, mergeLast, rangeStart, toCandles, type Candle, type Timeframe } from './bars'

export const POLL_MS = 5000
/** Trim and uppercase; null unless it matches the one equity-symbol rule (lib/symbols.ts). */
export function normalizeSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase()
  return isEquityTicker(s) ? s : null
}

/** Stale-response guard: take a ticket before an async call, apply the result only if it is still current. */
export class RequestGuard {
  private n = 0
  next(): number {
    return ++this.n
  }
  isCurrent(ticket: number): boolean {
    return ticket === this.n
  }
}

export type Fetcher = (symbol: string, interval: string, start: string) => Promise<RhHistorical[]>

export interface LoadResult {
  candles: Candle[]
  error: string | null
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Fetch, parse and (for 3m/15m/2h) aggregate. Never throws: failures come back as `error`. */
export async function loadCandles(fetcher: Fetcher, symbol: string, tf: Timeframe, now: number): Promise<LoadResult> {
  const none = { candles: [] as Candle[], error: `no data for ${symbol}` }
  let list: RhHistorical[]
  try {
    list = await fetcher(symbol, tf.fetchInterval, rangeStart(tf, now))
  } catch (e) {
    const m = errMsg(e)
    return /not[_ ]found/i.test(m) ? none : { candles: [], error: m }
  }
  const h = list.find((x) => x.symbol?.toUpperCase() === symbol) ?? list[0]
  let candles = toCandles(h?.bars ?? [])
  if (tf.aggregate > 1) candles = aggregateCandles(candles, tf.aggregate, tf.barMs / tf.aggregate)
  return candles.length === 0 ? none : { candles, error: null }
}

/** TM overlays attach only when the chart is ready for THIS symbol and the TM data belongs to it. */
export function overlayReady(a: {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  symbol: string
  loadedSymbol: string | null
  apexSymbol: string | null
  moveSymbol: string | null
}): boolean {
  const same = (x: string | null) => x !== null && x.toUpperCase() === a.symbol.toUpperCase()
  if (a.phase !== 'ready' || !same(a.loadedSymbol)) return false
  const have = [a.apexSymbol, a.moveSymbol].filter((s): s is string => s !== null)
  return have.length > 0 && have.every((s) => same(s))
}

/** Replace the data in place for a same-symbol, same-period refresh (the chart re-requests 'init' from the feed). */
export function refreshData(chart: Chart, feed: ChartFeed, candles: Candle[]): void {
  feed.setData(candles)
  chart.resetData()
}

export function shouldPoll(s: { hidden: boolean; haveData: boolean; symbol: string | null }): boolean {
  return !s.hidden && s.haveData && s.symbol !== null
}

/** Apply a polled quote to the bars. `changed` is false when there is nothing to push to the chart. */
export function nextBars(bars: Candle[], q: RhQuote | undefined, now: number, tf: Timeframe): { bars: Candle[]; changed: boolean } {
  const price = q?.last_trade_price
  if (bars.length === 0 || price === null || price === undefined || !Number.isFinite(price)) return { bars, changed: false }
  const merged = mergeLast(bars, price, null, now, tf)
  const a = bars[bars.length - 1]!
  const b = merged[merged.length - 1]!
  const changed = merged.length !== bars.length || a.close !== b.close || a.high !== b.high || a.low !== b.low
  return changed ? { bars: merged, changed } : { bars, changed }
}

export function periodOf(tf: Timeframe): Period {
  switch (tf.id) {
    case '1m':
    case '3m':
    case '5m':
    case '10m':
    case '15m':
    case '30m':
      return { type: 'minute', span: tf.barMs / 60_000 }
    case '1h':
    case '2h':
    case '4h':
      return { type: 'hour', span: tf.barMs / 3_600_000 }
    case '1D':
      return { type: 'day', span: 1 }
    case '1W':
      return { type: 'week', span: 1 }
    case '1M':
      return { type: 'month', span: 1 }
  }
}

const toK = (c: Candle): KLineData => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })

/** Holds the bars KLineChart asks for and the live-update callback it hands back. */
export class ChartFeed {
  private data: KLineData[] = []
  private sub: ((d: KLineData) => void) | null = null

  readonly loader: DataLoader = {
    getBars: ({ type, callback }) => {
      callback(type === 'init' ? this.data : [], false)
    },
    subscribeBar: ({ callback }) => {
      this.sub = callback
    },
    unsubscribeBar: () => {
      this.sub = null
    },
  }

  setData(c: Candle[]): void {
    this.data = c.map(toK)
  }
  pushLast(c: Candle): void {
    this.sub?.(toK(c))
  }
}

function precisionOf(c: Candle[]): number {
  const last = c[c.length - 1]
  return last !== undefined && last.close < 1 ? 4 : 2
}

/** Replace the chart's data: load the feed, then set symbol and period (each call makes the chart re-request 'init'). */
export function pushData(chart: Chart, feed: ChartFeed, symbol: string, tf: Timeframe, candles: Candle[], pricePrecision?: number): void {
  feed.setData(candles)
  const info: Pick<SymbolInfo, 'ticker' | 'pricePrecision' | 'volumePrecision'> = {
    ticker: symbol,
    pricePrecision: pricePrecision ?? precisionOf(candles),
    volumePrecision: 0,
  }
  chart.setSymbol(info)
  chart.setPeriod(periodOf(tf))
}
