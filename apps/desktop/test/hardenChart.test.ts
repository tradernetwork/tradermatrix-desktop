import { describe, expect, it } from 'vitest'
import { isIntraday, mergeLast, timeframeById, timezoneFor, type Candle } from '../src/chart/bars'
import { parseNumberDraft } from '../src/chart/indicatorInput'
import { overlayReady } from '../src/chart/useChartData'

const MIN = 60_000
const c = (timestamp: number, o: number, h: number, l: number, cl: number, v = 10): Candle => ({ timestamp, open: o, high: h, low: l, close: cl, volume: v })

describe('F6 mergeLast never opens a bar', () => {
  const t5 = timeframeById('5m')
  const base = Date.UTC(2026, 10, 9, 14, 30)
  const last = c(base, 10, 11, 9, 10.5, 100)
  it('past the window the bars come back unchanged (history refetch brings the real bar)', () => {
    expect(mergeLast([last], 10.8, null, base + 5 * MIN + 1000, t5)).toEqual([last])
    expect(mergeLast([last], 13, null, base + 600 * MIN, t5)).toHaveLength(1)
  })
  it('inside the window it still updates the last bar', () => {
    const out = mergeLast([last], 12, null, base + MIN, t5)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ high: 12, close: 12 })
  })
})

describe('F6 timezone and refetch helpers', () => {
  it('daily and longer use UTC, intraday keeps New York', () => {
    for (const id of ['1D', '1W', '1M'] as const) expect(timezoneFor(timeframeById(id))).toBe('UTC')
    for (const id of ['1m', '5m', '15m', '1h', '4h'] as const) expect(timezoneFor(timeframeById(id))).toBe('America/New_York')
    expect(isIntraday(timeframeById('4h'))).toBe(true)
    expect(isIntraday(timeframeById('1D'))).toBe(false)
  })
})

describe('F6 TM overlay gate', () => {
  const base = { phase: 'ready' as const, symbol: 'AAPL', loadedSymbol: 'AAPL', apexSymbol: 'AAPL', moveSymbol: null as string | null }
  it('attaches only when ready for that symbol and the data belongs to it', () => {
    expect(overlayReady(base)).toBe(true)
    expect(overlayReady({ ...base, phase: 'loading' })).toBe(false)
    expect(overlayReady({ ...base, phase: 'error' })).toBe(false)
    expect(overlayReady({ ...base, loadedSymbol: 'MSFT' })).toBe(false)
    expect(overlayReady({ ...base, apexSymbol: 'MSFT' })).toBe(false)
    expect(overlayReady({ ...base, apexSymbol: null, moveSymbol: 'MSFT' })).toBe(false)
    expect(overlayReady({ ...base, apexSymbol: null, moveSymbol: 'AAPL' })).toBe(true)
  })
})

describe('F6 indicator number input', () => {
  const d = { key: 'len', name: 'Length', type: 'integer', default: 14, min: 2, max: 200 } as never
  it('keeps partial text out of the committed value', () => {
    expect(parseNumberDraft('', d)).toBeNull()
    expect(parseNumberDraft('-', d)).toBeNull()
    expect(parseNumberDraft('1e', d)).toBeNull()
    expect(parseNumberDraft('.', d)).toBeNull()
  })
  it('clamps and rounds integers, passes floats', () => {
    expect(parseNumberDraft('1', d)).toBe(2)
    expect(parseNumberDraft('500', d)).toBe(200)
    expect(parseNumberDraft('14.6', d)).toBe(15)
    expect(parseNumberDraft('2.5', { ...(d as object), type: 'float' } as never)).toBe(2.5)
  })
})
