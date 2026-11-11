/** Robinhood bars to KLineChart candles: lenient parsing, client-side aggregation, range and live-merge helpers. */

/** One Robinhood bar row. The app's RhBar fits; `interpolated` is read when the server sends it. */
export interface RhBarRow {
  begins_at: string
  open_price?: unknown
  high_price?: unknown
  low_price?: unknown
  close_price?: unknown
  volume?: unknown
  interpolated?: unknown
}

/** timestamp = ms epoch UTC (the KLineChart data shape). */
export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  partial?: boolean
}

export type TimeframeId = '1m' | '3m' | '5m' | '10m' | '15m' | '30m' | '1h' | '2h' | '4h' | '1D' | '1W' | '1M'

export interface Timeframe {
  id: TimeframeId
  label: string
  /** Robinhood fixed interval to request. */
  fetchInterval: string
  /** Number of fetched bars folded into one displayed bar (1 = none). */
  aggregate: number
  /** Duration of one DISPLAYED bar in ms. */
  barMs: number
  /** How far back to request, in ms. Chosen to keep a request under about 2,500 fetched bars. */
  lookbackMs: number
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const tfDef = (id: TimeframeId, fetchInterval: string, aggregate: number, baseMs: number, lookbackDays: number): Timeframe => ({
  id,
  label: id,
  fetchInterval,
  aggregate,
  barMs: baseMs * aggregate,
  lookbackMs: lookbackDays * DAY,
})

export const TIMEFRAMES: Timeframe[] = [
  tfDef('1m', 'minute', 1, MIN, 5),
  tfDef('3m', 'minute', 3, MIN, 6),
  tfDef('5m', '5minute', 1, 5 * MIN, 30),
  tfDef('10m', '10minute', 1, 10 * MIN, 60),
  tfDef('15m', '5minute', 3, 5 * MIN, 30),
  tfDef('30m', '30minute', 1, 30 * MIN, 180),
  tfDef('1h', 'hour', 1, HOUR, 365),
  tfDef('2h', 'hour', 2, HOUR, 365),
  tfDef('4h', '4hour', 1, 4 * HOUR, 730),
  tfDef('1D', 'day', 1, DAY, 5 * 365),
  tfDef('1W', 'week', 1, 7 * DAY, 10 * 365),
  tfDef('1M', 'month', 1, 30 * DAY, 20 * 365),
]

export const DEFAULT_TIMEFRAME: TimeframeId = '1D'

export function timeframeById(id: string): Timeframe {
  return TIMEFRAMES.find((t) => t.id === id) ?? TIMEFRAMES.find((t) => t.id === DEFAULT_TIMEFRAME)!
}

function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return NaN
}

export function toCandles(rows: RhBarRow[]): Candle[] {
  const byTime = new Map<number, Candle>()
  for (const r of rows) {
    if (!r || typeof r.begins_at !== 'string' || r.begins_at === '') continue
    const timestamp = Date.parse(r.begins_at)
    const open = num(r.open_price)
    const high = num(r.high_price)
    const low = num(r.low_price)
    const close = num(r.close_price)
    if (!Number.isFinite(timestamp) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue
    const v = num(r.volume)
    const volume = Number.isFinite(v) ? v : 0
    if (r.interpolated === true && volume === 0) continue
    byTime.set(timestamp, { timestamp, open, high, low, close, volume })
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Fold `factor` source bars of `baseMs` each into one. Buckets are aligned to the epoch grid of
 * factor*baseMs, never to array index. The last bucket is flagged `partial` when it holds fewer than
 * `factor` source bars. Input must be sorted ascending (toCandles guarantees it).
 */
export function aggregateCandles(cs: Candle[], factor: number, baseMs: number): Candle[] {
  if (factor <= 1 || cs.length === 0) return cs
  const span = factor * baseMs
  const out: Candle[] = []
  const counts: number[] = []
  for (const x of cs) {
    const start = Math.floor(x.timestamp / span) * span
    const cur = out[out.length - 1]
    if (cur && cur.timestamp === start) {
      cur.high = Math.max(cur.high, x.high)
      cur.low = Math.min(cur.low, x.low)
      cur.close = x.close
      cur.volume += x.volume
      counts[counts.length - 1]! += 1
    } else {
      out.push({ timestamp: start, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume })
      counts.push(1)
    }
  }
  const last = out[out.length - 1]
  if (last && counts[counts.length - 1]! < factor) last.partial = true
  return out
}

/** RFC3339 UTC start_time = now - lookbackMs, whole seconds. */
export function rangeStart(tf: Timeframe, now: number): string {
  return new Date(Math.floor((now - tf.lookbackMs) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function isIntraday(tf: Timeframe): boolean {
  return tf.barMs < DAY
}

/** Daily and longer bars begin at midnight UTC; intraday bars are shown in exchange time. */
export function timezoneFor(tf: Timeframe): string {
  return isIntraday(tf) ? 'America/New_York' : 'UTC'
}

/**
 * Polled update from a quote price: only ever updates the CURRENT last bar (its window still open). It never
 * creates a bar: past the window (after hours, weekends, a gap between history fetches) the bars come back
 * unchanged and the periodic history re-fetch brings the real bar. Never reorders.
 */
export function mergeLast(cs: Candle[], price: number, volume: number | null, now: number, tf: Timeframe): Candle[] {
  const last = cs[cs.length - 1]
  if (!last || !Number.isFinite(price)) return cs
  const vol = volume !== null && Number.isFinite(volume) ? volume : null
  const pastWindow = now >= last.timestamp + tf.barMs
  if (!pastWindow) {
    const next: Candle = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
      volume: vol !== null ? Math.max(last.volume, vol) : last.volume,
    }
    return [...cs.slice(0, -1), next]
  }
  return cs
}
