import { beforeEach, describe, expect, it, vi } from 'vitest'
import { timeframeById, type Candle } from '../src/chart/bars'
import { backfillFromStore, fromStored, mergeBefore, needsBackfill, SRC_EQUITY, SRC_OPTION, storeCandlesQuiet, storeStatusText, toStored } from '../src/chart/candleStore'
import { api, fake, type StoredCandle } from '../src/lib/api'
import { MAX_SNAPSHOT_JSON, snapshotJson, SnapshotSampler } from '../src/lib/snapshots'

const T0 = Date.UTC(2026, 10, 2, 14, 30)
const c = (ts: number, close = 10): Candle => ({ timestamp: ts, open: close - 1, high: close + 1, low: close - 2, close, volume: 5 })
const DAY = 86_400_000

describe('stored candle mapping', () => {
  it('round-trips and drops the partial flag', () => {
    const s = toStored({ ...c(T0), partial: true })
    expect(s).toEqual({ ts: T0, open: 9, high: 11, low: 8, close: 10, volume: 5 })
    expect(fromStored(s)).toEqual(c(T0))
  })
})

describe('storeCandlesQuiet', () => {
  it('chunks at 5000 rows per call and tags source/instrument/interval', async () => {
    const calls: Array<[string, string, string, number]> = []
    const sink = { candlesStore: vi.fn(async (s: string, i: string, v: string, bars: StoredCandle[]) => (calls.push([s, i, v, bars.length]), bars.length)), candlesLoad: vi.fn() }
    const many = Array.from({ length: 12_001 }, (_, i) => c(T0 + i * 60_000))
    await storeCandlesQuiet(sink, SRC_EQUITY, 'AAPL', '1m', many)
    expect(calls).toEqual([[SRC_EQUITY, 'AAPL', '1m', 5000], [SRC_EQUITY, 'AAPL', '1m', 5000], [SRC_EQUITY, 'AAPL', '1m', 2001]])
  })
  it('never throws: a failing sink becomes one warning', async () => {
    const warn = vi.fn()
    const sink = { candlesStore: vi.fn(async () => { throw new Error('db locked') }), candlesLoad: vi.fn() }
    await expect(storeCandlesQuiet(sink, SRC_OPTION, 'x', '1D', [c(T0)], warn)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/candle/i)
  })
  it('sends nothing for no candles and filters non-finite rows', async () => {
    const sink = { candlesStore: vi.fn(async (_s: string, _i: string, _v: string, b: StoredCandle[]) => b.length), candlesLoad: vi.fn() }
    await storeCandlesQuiet(sink, SRC_EQUITY, 'AAPL', '1D', [])
    expect(sink.candlesStore).not.toHaveBeenCalled()
    await storeCandlesQuiet(sink, SRC_EQUITY, 'AAPL', '1D', [c(T0), { ...c(T0 + DAY), close: NaN }])
    expect(sink.candlesStore.mock.calls[0]![3]).toHaveLength(1)
  })
})

describe('older-history backfill', () => {
  const tf = timeframeById('1D')
  const now = Date.UTC(2026, 10, 10)
  it('mergeBefore prepends only stored bars strictly before the first returned bar, sorted, de-duplicated', () => {
    const got = [c(T0 + 2 * DAY, 1), c(T0 + 3 * DAY, 2)]
    const stored = [c(T0 + 2 * DAY, 99), c(T0, 3), c(T0 + DAY, 4), c(T0, 3)]
    const m = mergeBefore(got, stored)
    expect(m.map((x) => x.timestamp)).toEqual([T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY])
    expect(m[2]!.close).toBe(1)
    expect(mergeBefore([], stored)).toEqual([])
  })
  it('needsBackfill: only when the first bar starts well after the requested range start', () => {
    const start = now - tf.lookbackMs
    expect(needsBackfill([c(start + DAY)], tf, now)).toBe(false)
    expect(needsBackfill([c(start + 30 * DAY)], tf, now)).toBe(true)
    expect(needsBackfill([], tf, now)).toBe(false)
  })
  it('backfillFromStore loads [rangeStart, firstBar) from storage and merges; storage errors keep the live bars', async () => {
    const start = now - tf.lookbackMs
    const first = start + 30 * DAY
    const live = [c(first, 7)]
    const older = [c(start + 10 * DAY, 5), c(start + 11 * DAY, 6)]
    const load = vi.fn(async () => older.map(toStored))
    const out = await backfillFromStore({ candlesStore: vi.fn(), candlesLoad: load }, SRC_EQUITY, 'AAPL', tf, live, now)
    expect(load).toHaveBeenCalledWith(SRC_EQUITY, 'AAPL', '1D', start, first - 1, 20000)
    expect(out.map((x) => x.close)).toEqual([5, 6, 7])
    const bad = await backfillFromStore({ candlesStore: vi.fn(), candlesLoad: vi.fn(async () => { throw new Error('x') }) }, SRC_EQUITY, 'AAPL', tf, live, now, () => undefined)
    expect(bad).toBe(live)
    const none = await backfillFromStore({ candlesStore: vi.fn(), candlesLoad: vi.fn() }, SRC_EQUITY, 'AAPL', tf, [c(start + DAY)], now)
    expect(none).toHaveLength(1)
  })
})

describe('status text', () => {
  it('formats N candles stored (X MB)', () => {
    expect(storeStatusText({ candles: 12345, snapshots: 3, db_bytes: 5_452_595 })).toBe('12,345 candles stored (5.2 MB)')
    expect(storeStatusText({ candles: 1, snapshots: 0, db_bytes: 4096 })).toBe('1 candle stored (<0.1 MB)')
    expect(storeStatusText(null)).toBe('')
  })
})

describe('snapshots', () => {
  it('snapshotJson caps at 16 KB and refuses non-serializable values', () => {
    expect(snapshotJson({ a: 1 })).toBe('{"a":1}')
    expect(MAX_SNAPSHOT_JSON).toBe(16 * 1024)
    expect(snapshotJson({ a: 'x'.repeat(MAX_SNAPSHOT_JSON) })).toBeNull()
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(snapshotJson(cyc)).toBeNull()
    expect(snapshotJson(undefined)).toBeNull()
  })
  it('the sampler stores at most one snapshot per kind+key per 60 s and swallows errors', async () => {
    const sink = vi.fn(async () => undefined)
    const s = new SnapshotSampler(sink, 60_000, () => undefined)
    expect(s.offer('quote', 'AAPL', { last: 1 }, 1_000)).toBe(true)
    expect(s.offer('quote', 'AAPL', { last: 2 }, 30_000)).toBe(false)
    expect(s.offer('quote', 'MSFT', { last: 3 }, 30_000)).toBe(true)
    expect(s.offer('tm_iv', 'AAPL', { r: 1 }, 30_000)).toBe(true)
    expect(s.offer('quote', 'AAPL', { last: 4 }, 61_000)).toBe(true)
    expect(sink).toHaveBeenCalledTimes(4)
    expect(sink.mock.calls[0]).toEqual(['quote', 'AAPL', '{"last":1}'])
    const warn = vi.fn()
    const bad = new SnapshotSampler(async () => { throw new Error('boom') }, 60_000, warn)
    expect(bad.offer('quote', 'X', {}, 0)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledTimes(1)
  })
  it('the sampler skips bad keys and oversize payloads without calling the sink', () => {
    const sink = vi.fn(async () => undefined)
    const s = new SnapshotSampler(sink, 60_000, () => undefined)
    expect(s.offer('quote', 'a b', {}, 0)).toBe(false)
    expect(s.offer('Quote', 'AAPL', {}, 0)).toBe(false)
    expect(s.offer('quote', 'AAPL', { x: 'y'.repeat(20_000) }, 0)).toBe(false)
    expect(sink).not.toHaveBeenCalled()
  })
})

describe('fake backend candle commands (in-memory, same rules as Rust)', () => {
  beforeEach(() => fake.reset())
  const row = (ts: number, close = 10): StoredCandle => ({ ts, open: close - 1, high: close + 1, low: close - 2, close, volume: 5 })
  it('stores, upserts, loads a range, counts', async () => {
    expect(await api.candlesStore(SRC_EQUITY, 'AAPL', '1D', [row(T0), row(T0 + DAY)])).toBe(2)
    await api.candlesStore(SRC_EQUITY, 'AAPL', '1D', [row(T0, 11)])
    const all = await api.candlesLoad(SRC_EQUITY, 'AAPL', '1D', 0, Number.MAX_SAFE_INTEGER, 100)
    expect(all.map((x) => x.close)).toEqual([11, 10])
    expect((await api.candlesLoad(SRC_EQUITY, 'AAPL', '1D', T0 + 1, T0 + DAY, 100)).length).toBe(1)
    expect((await api.candlesStats()).candles).toBe(2)
  })
  it('rejects bad batches atomically and bad identifiers', async () => {
    await expect(api.candlesStore(SRC_EQUITY, 'AAPL', '1D', [row(T0), { ...row(T0 + 1), high: 1, low: 5 }])).rejects.toThrow(/invalid/)
    await expect(api.candlesStore('RH', 'AAPL', '1D', [row(T0)])).rejects.toThrow(/invalid/)
    await expect(api.candlesStore(SRC_EQUITY, 'A B', '1D', [row(T0)])).rejects.toThrow(/invalid/)
    await expect(api.candlesLoad(SRC_EQUITY, 'AAPL', '1D', 0, 10, 20_001)).rejects.toThrow(/invalid/)
    expect((await api.candlesStats()).candles).toBe(0)
  })
  it('snapshots are capped at 16 KB', async () => {
    await api.snapshotStore('quote', 'AAPL', '{"a":1}')
    await expect(api.snapshotStore('quote', 'AAPL', JSON.stringify({ a: 'x'.repeat(20_000) }))).rejects.toThrow(/invalid/)
    expect((await api.candlesStats()).snapshots).toBe(1)
  })
})
