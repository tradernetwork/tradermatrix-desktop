import { beforeEach, describe, expect, it } from 'vitest'
import { rangeStart, timeframeById } from '../src/chart/bars'
import { chartOptionFromPosition, OPTION_ID_RE } from '../src/chart/optionChart'
import { loadCandles } from '../src/chart/useChartData'
import { api, fake, type RhOptionPosition } from '../src/lib/api'
import { useRhStore } from '../src/stores/rh'

const ID = '0f3c2a1e-5b7d-4c9a-8e21-3a4b5c6d7e8f'
const NOW = Date.UTC(2026, 10, 10, 15, 0, 0)
const pos = (o: Partial<RhOptionPosition> = {}): RhOptionPosition => ({
  option_id: ID, chain_symbol: 'AAPL', expiration_date: '2026-11-13', strike_price: 85, option_type: 'call', side: 'long', quantity: 1,
  average_price: 120, multiplier: 100, bid: 1, ask: 1.1, mark: 1.05, delta: 0.5, theta: -0.1, iv: 0.3, min_ticks: null, pending_buy: null, pending_sell: null, ...o,
})

describe('chart option mode state', () => {
  beforeEach(() => useRhStore.setState({ chartSymbol: 'SPY', chartOption: null }))
  it('chartOptionFromPosition builds id, label like "AAPL 2026-11-13 85 C" and the underlying', () => {
    expect(chartOptionFromPosition(pos())).toEqual({ id: ID, label: 'AAPL 2026-11-13 85 C', underlying: 'AAPL' })
    expect(chartOptionFromPosition(pos({ option_type: 'put', strike_price: 2.5 }))!.label).toBe('AAPL 2026-11-13 2.5 P')
  })
  it('refuses an option id that is not a uuid', () => {
    expect(chartOptionFromPosition(pos({ option_id: 'nope' }))).toBeNull()
    expect(OPTION_ID_RE.test(ID)).toBe(true)
    expect(OPTION_ID_RE.test(`${ID}; drop`)).toBe(false)
  })
  it('setChartOption sets the contract and moves the chart symbol to the underlying', () => {
    useRhStore.getState().setChartOption({ id: ID, label: 'AAPL 2026-11-13 85 C', underlying: 'aapl' })
    expect(useRhStore.getState().chartOption?.id).toBe(ID)
    expect(useRhStore.getState().chartSymbol).toBe('AAPL')
  })
  it('a bad option is ignored; setChartSymbol and setChartOption(null) go back to the equity', () => {
    useRhStore.getState().setChartOption({ id: 'bad', label: 'x', underlying: 'AAPL' })
    expect(useRhStore.getState().chartOption).toBeNull()
    useRhStore.getState().setChartOption({ id: ID, label: 'AAPL 2026-11-13 85 C', underlying: 'AAPL' })
    useRhStore.getState().setChartSymbol('MSFT')
    expect(useRhStore.getState().chartOption).toBeNull()
    expect(useRhStore.getState().chartSymbol).toBe('MSFT')
    useRhStore.getState().setChartOption({ id: ID, label: 'AAPL 2026-11-13 85 C', underlying: 'AAPL' })
    useRhStore.getState().setChartOption(null)
    expect(useRhStore.getState().chartOption).toBeNull()
    expect(useRhStore.getState().chartSymbol).toBe('AAPL')
  })
})

describe('fake option history (no volume, same rules as the Rust read)', () => {
  beforeEach(() => fake.reset())
  it('returns OHLC bars without volume and loadCandles maps them to candles with volume 0', async () => {
    const tf = timeframeById('1D')
    const r = await loadCandles((_s, i, st) => api.rhOptionHistoricals(ID, i, st).then((h) => [h]), 'AAPL 2026-11-13 85 C', tf, NOW)
    expect(r.error).toBeNull()
    expect(r.candles.length).toBeGreaterThan(5)
    expect(r.candles.every((x) => x.volume === 0 && x.high >= x.low)).toBe(true)
    expect(rangeStart(tf, NOW)).toMatch(/Z$/)
  })
  it('rejects a bad id, a bad interval and an unknown contract', async () => {
    await expect(api.rhOptionHistoricals('nope', 'day', '2026-01-01T00:00:00Z')).rejects.toThrow(/invalid argument/)
    await expect(api.rhOptionHistoricals(ID, 'bogus', '2026-01-01T00:00:00Z')).rejects.toThrow(/invalid argument/)
    await expect(api.rhOptionHistoricals('00000000-0000-0000-0000-000000000000', 'day', '2026-01-01T00:00:00Z')).rejects.toThrow(/not found/)
  })
  it('the chart load turns an unknown contract into a visible error, not a throw', async () => {
    const r = await loadCandles((_s, i, st) => api.rhOptionHistoricals('00000000-0000-0000-0000-000000000000', i, st).then((h) => [h]), 'AAPL 2026-11-13 85 C', timeframeById('1D'), NOW)
    expect(r.candles).toEqual([])
    expect(r.error).toMatch(/AAPL 2026-11-13 85 C/)
  })
})
