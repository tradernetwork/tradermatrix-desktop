import { describe, expect, it } from 'vitest'
import { actionsFor, chunk, computeSyncPlan, parseSyncPair, rhSymbolsOf, tmFreeSlots, tmTickersOf, SYNC_PAIR_KEY } from '../src/lib/watchSync'

const rh = (symbols: string[], skipped: { symbol: string; reason: string }[] = []) => ({ symbols, skipped })
const items = (...xs: [string, string?][]) => xs.map(([symbol, object_type]) => ({ symbol, object_type }))

describe('tmTickersOf', () => {
  it('uppercases, trims, dedupes and keeps only TM-shaped tickers', () => {
    expect(tmTickersOf({ tickers: [' aapl', 'AAPL', 'brk.b', 'msft ', '', 'BF-B', 'ABCDEFG', 'A1'] })).toEqual(['AAPL', 'BRK.B', 'MSFT'])
  })
  it('empty list', () => {
    expect(tmTickersOf({ tickers: [] })).toEqual([])
  })
})

describe('rhSymbolsOf', () => {
  it('keeps instrument and missing object types, normalizes and dedupes', () => {
    const r = rhSymbolsOf(items([' aapl', 'instrument'], ['AAPL', 'instrument'], ['msft'], ['tsla', null as unknown as string], ['nvda', '']))
    expect(r.symbols).toEqual(['AAPL', 'MSFT', 'TSLA', 'NVDA'])
    expect(r.skipped).toEqual([])
  })
  it('skips crypto, index and futures with the object type in the reason', () => {
    const r = rhSymbolsOf(items(['BTC', 'currency_pair'], ['SPX', 'index'], ['ESZ6', 'future'], ['AAPL', 'instrument']))
    expect(r.symbols).toEqual(['AAPL'])
    expect(r.skipped.map((s) => s.symbol)).toEqual(['BTC', 'SPX', 'ESZ6'])
    expect(r.skipped[0].reason).toContain('currency_pair')
    expect(r.skipped[1].reason).toContain('index')
    expect(r.skipped[2].reason).toContain('future')
  })
  it('skips symbols that fail the equity rule and drops blanks', () => {
    const r = rhSymbolsOf(items(['  ', 'instrument'], ['1ABC', 'instrument'], ['A B', 'instrument'], ['OK', 'instrument']))
    expect(r.symbols).toEqual(['OK'])
    expect(r.skipped.map((s) => s.symbol)).toEqual(['1ABC', 'A B'])
  })
})

describe('computeSyncPlan', () => {
  it('splits into onlyTm, onlyRh, both; sorted and disjoint', () => {
    const p = computeSyncPlan(['MSFT', 'AAPL', 'GOOG', 'BRK.B'], rh(['TSLA', 'AAPL', 'NVDA', 'BRK.B']))
    expect(p.onlyTm).toEqual(['GOOG', 'MSFT'])
    expect(p.onlyRh).toEqual(['NVDA', 'TSLA'])
    expect(p.both).toEqual(['AAPL', 'BRK.B'])
    const all = [...p.onlyTm, ...p.onlyRh, ...p.both]
    expect(new Set(all).size).toBe(all.length)
    expect(p.skippedForTm).toEqual([])
    expect(p.skippedForRh).toEqual([])
  })
  it('normalizes TM input (case, dupes, whitespace)', () => {
    const p = computeSyncPlan([' aapl', 'AAPL', 'msft '], rh(['AAPL']))
    expect(p.both).toEqual(['AAPL'])
    expect(p.onlyTm).toEqual(['MSFT'])
  })
  it('RH symbols TM cannot hold are skipped for TM with a reason, not sent', () => {
    const p = computeSyncPlan([], rh(['BF-B', 'ABCDEFG', 'A1', 'AAPL', 'BRK.B']))
    expect(p.onlyRh).toEqual(['AAPL', 'BRK.B'])
    expect(p.skippedForTm.map((s) => s.symbol)).toEqual(['A1', 'ABCDEFG', 'BF-B'])
    for (const s of p.skippedForTm) expect(s.reason.length).toBeGreaterThan(10)
    expect(p.skippedForTm.find((s) => s.symbol === 'BF-B')!.reason).toMatch(/digit|-|letters/i)
    expect(p.skippedForTm.find((s) => s.symbol === 'ABCDEFG')!.reason).toMatch(/6/)
  })
  it('carries non-instrument RH skips into skippedForTm', () => {
    const r = rhSymbolsOf(items(['BTC', 'currency_pair'], ['AAPL', 'instrument']))
    const p = computeSyncPlan([], r)
    expect(p.onlyRh).toEqual(['AAPL'])
    expect(p.skippedForTm).toEqual([{ symbol: 'BTC', reason: expect.stringContaining('currency_pair') }])
  })
  it('TM entries that Robinhood cannot hold are skipped for RH', () => {
    const p = computeSyncPlan(['AAPL', '9BAD', 'X Y'], rh([]))
    expect(p.onlyTm).toEqual(['AAPL'])
    expect(p.skippedForRh.map((s) => s.symbol)).toEqual(['9BAD', 'X Y'])
  })
  it('capacity: tmFree=2 with 5 onlyRh allows 2 and reports 3', () => {
    const p = computeSyncPlan([], rh(['EEE', 'AAA', 'DDD', 'BBB', 'CCC']), { tmFree: 2 })
    expect(p.onlyRh).toEqual(['AAA', 'BBB'])
    expect(p.skippedForTm.map((s) => s.symbol)).toEqual(['CCC', 'DDD', 'EEE'])
    expect(p.skippedForTm[0].reason).toMatch(/full|room|capacity|150|limit/i)
  })
  it('capacity 0 and no capacity given', () => {
    expect(computeSyncPlan([], rh(['AAA', 'BBB']), { tmFree: 0 }).onlyRh).toEqual([])
    expect(computeSyncPlan([], rh(['AAA', 'BBB'])).onlyRh).toEqual(['AAA', 'BBB'])
    expect(computeSyncPlan([], rh(['AAA']), { tmFree: -5 }).onlyRh).toEqual([])
  })
  it('capacity does not touch symbols already skipped as un-holdable twice', () => {
    const p = computeSyncPlan([], rh(['A1', 'AAA', 'BBB']), { tmFree: 1 })
    expect(p.onlyRh).toEqual(['AAA'])
    expect(p.skippedForTm.map((s) => s.symbol).sort()).toEqual(['A1', 'BBB'])
  })
  it('empty inputs', () => {
    expect(computeSyncPlan([], rh([]))).toEqual({ onlyTm: [], onlyRh: [], both: [], skippedForTm: [], skippedForRh: [] })
  })
  it('1000 symbols per side is instant', () => {
    const a = Array.from({ length: 1000 }, (_, i) => `A${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + Math.floor(i / 676))}`)
    const b = Array.from({ length: 1000 }, (_, i) => `B${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + Math.floor(i / 676))}`)
    const t0 = performance.now()
    const p = computeSyncPlan(a, rh([...b, ...a.slice(0, 500)]))
    expect(performance.now() - t0).toBeLessThan(200)
    expect(p.both.length).toBe(500)
    expect(p.onlyTm.length).toBe(500)
    expect(p.onlyRh.length).toBe(1000)
  })
})

describe('actionsFor', () => {
  const plan = computeSyncPlan(['AAA', 'BBB'], rh(['BBB', 'CCC']))
  it('tm_to_rh adds only to Robinhood', () => expect(actionsFor(plan, 'tm_to_rh')).toEqual({ addToRh: ['AAA'], addToTm: [] }))
  it('rh_to_tm adds only to TM', () => expect(actionsFor(plan, 'rh_to_tm')).toEqual({ addToRh: [], addToTm: ['CCC'] }))
  it('both does both', () => expect(actionsFor(plan, 'both')).toEqual({ addToRh: ['AAA'], addToTm: ['CCC'] }))
})

describe('tmFreeSlots', () => {
  const lists = [
    { id: 1, ticker_count: 100 },
    { id: 2, ticker_count: 20 },
  ]
  it('per-list headroom for an existing target', () => expect(tmFreeSlots(lists, 1, { tickers_per_list: 150, tickers_across_all_lists: 500 })).toBe(50))
  it('a new list has the full per-list headroom', () => expect(tmFreeSlots(lists, null, { tickers_per_list: 150, tickers_across_all_lists: 500 })).toBe(150))
  it('the account-wide cap can bind', () => expect(tmFreeSlots(lists, 2, { tickers_per_list: 150, tickers_across_all_lists: 130 })).toBe(10))
  it('unknown limits mean no cap', () => expect(tmFreeSlots(lists, 1, { tickers_per_list: null, tickers_across_all_lists: null })).toBeUndefined())
  it('never negative', () => expect(tmFreeSlots(lists, 1, { tickers_per_list: 90, tickers_across_all_lists: null })).toBe(0))
})

describe('chunk', () => {
  it('splits into pieces of at most n', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 50)).toEqual([])
    expect(chunk(Array.from({ length: 120 }, (_, i) => i), 50).map((c) => c.length)).toEqual([50, 50, 20])
  })
})

describe('parseSyncPair', () => {
  it('round-trips a pair', () => {
    expect(SYNC_PAIR_KEY).toBe('watch.sync.pair')
    expect(parseSyncPair(JSON.stringify({ tm: '101', rh: 'abc-1' }))).toEqual({ tm: '101', rh: 'abc-1' })
    expect(parseSyncPair(JSON.stringify({ tm: 'new', rh: 'new' }))).toEqual({ tm: 'new', rh: 'new' })
  })
  it('garbage yields nulls', () => {
    for (const raw of [null, undefined, '', 'nope', '[]', '3', 'null', '{"tm":1,"rh":2}', '{"tm":"","rh":"x"}', '{"tm":"' + 'a'.repeat(100) + '","rh":"x"}']) {
      const p = parseSyncPair(raw as string | null)
      expect(p.tm === null || typeof p.tm === 'string').toBe(true)
    }
    expect(parseSyncPair('nope')).toEqual({ tm: null, rh: null })
    expect(parseSyncPair('{"tm":1,"rh":2}')).toEqual({ tm: null, rh: null })
    expect(parseSyncPair('{"tm":"101"}')).toEqual({ tm: '101', rh: null })
  })
})
