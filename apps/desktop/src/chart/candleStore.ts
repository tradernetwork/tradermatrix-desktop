/**
 * Candle storage glue (M11): every successful bars load (equity and option) is written to the local SQLite file,
 * fire-and-forget. Nothing here ever throws into the chart: errors become one console.warn line.
 */
import type { CandleStats, StoredCandle } from '../lib/api'
import type { Candle, Timeframe } from './bars'
import { rangeStart } from './bars'

export const SRC_EQUITY = 'rh_equity'
export const SRC_OPTION = 'rh_option'
/** Rust cap per candles_store call. */
export const STORE_BATCH = 5000
export const LOAD_LIMIT = 20_000

/** The two storage calls the chart needs (api satisfies it; tests pass fakes). */
export interface CandleSink {
  candlesStore(source: string, instrument: string, interval: string, bars: StoredCandle[]): Promise<number>
  candlesLoad(source: string, instrument: string, interval: string, from: number, to: number, limit: number): Promise<StoredCandle[]>
}

type Warn = (m: string, e?: unknown) => void
const defaultWarn: Warn = (m, e) => console.warn(m, e)

export const toStored = (c: Candle): StoredCandle => ({ ts: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })
export const fromStored = (s: StoredCandle): Candle => ({ timestamp: s.ts, open: s.open, high: s.high, low: s.low, close: s.close, volume: s.volume })

const finiteRow = (s: StoredCandle) => [s.ts, s.open, s.high, s.low, s.close, s.volume].every(Number.isFinite)

/**
 * Store candles in chunks of 5000. Rows with a non-finite value are left out (Rust would reject the whole batch).
 * The still-forming last bar is stored too: the upsert overwrites it when newer data for the same bar arrives.
 */
export async function storeCandlesQuiet(sink: CandleSink, source: string, instrument: string, interval: string, candles: readonly Candle[], warn: Warn = defaultWarn): Promise<void> {
  try {
    const rows = candles.map(toStored).filter(finiteRow)
    for (let i = 0; i < rows.length; i += STORE_BATCH) await sink.candlesStore(source, instrument, interval, rows.slice(i, i + STORE_BATCH))
  } catch (e) {
    warn('candle storage failed (the chart is unaffected)', e)
  }
}

/** Stored bars strictly before the first returned bar, prepended; de-duplicated and sorted. Live bars always win. */
export function mergeBefore(candles: readonly Candle[], stored: readonly Candle[]): Candle[] {
  const first = candles[0]?.timestamp
  if (first === undefined) return []
  const byTs = new Map<number, Candle>()
  for (const s of stored) if (s.timestamp < first) byTs.set(s.timestamp, s)
  return [...[...byTs.values()].sort((a, b) => a.timestamp - b.timestamp), ...candles]
}

const DAY = 86_400_000

/** The first returned bar starts well after the requested start (more than a long weekend, or two bars): older rows may be stored. */
export function needsBackfill(candles: readonly Candle[], tf: Timeframe, now: number): boolean {
  const first = candles[0]?.timestamp
  if (first === undefined) return false
  return first - Date.parse(rangeStart(tf, now)) > Math.max(5 * DAY, 2 * tf.barMs)
}

/** "Load older history" fallback: merge stored candles for [range start, first bar). Returns `candles` itself when nothing applies or storage fails. */
export async function backfillFromStore(sink: CandleSink, source: string, instrument: string, tf: Timeframe, candles: Candle[], now: number, warn: Warn = defaultWarn): Promise<Candle[]> {
  if (!needsBackfill(candles, tf, now)) return candles
  try {
    const from = Date.parse(rangeStart(tf, now))
    const stored = await sink.candlesLoad(source, instrument, tf.id, from, candles[0]!.timestamp - 1, LOAD_LIMIT)
    return stored.length === 0 ? candles : mergeBefore(candles, stored.map(fromStored))
  } catch (e) {
    warn('stored candles could not be read (showing live bars only)', e)
    return candles
  }
}

/** "N candles stored (X MB)" for the chart toolbar; empty until the first read. */
export function storeStatusText(s: CandleStats | null): string {
  if (!s) return ''
  const mb = s.db_bytes / 1_048_576
  const size = mb < 0.05 ? '<0.1 MB' : `${mb.toFixed(1)} MB`
  return `${s.candles.toLocaleString('en-US')} candle${s.candles === 1 ? '' : 's'} stored (${size})`
}
