import { beforeEach, describe, expect, it } from 'vitest'
import { useRhStore } from '../src/stores/rh'

describe('chartSymbol in the rh store', () => {
  beforeEach(() => useRhStore.setState({ chartSymbol: 'SPY' }))
  it('defaults to SPY, normalizes valid symbols and ignores invalid ones', () => {
    expect(useRhStore.getState().chartSymbol).toBe('SPY')
    useRhStore.getState().setChartSymbol(' aapl ')
    expect(useRhStore.getState().chartSymbol).toBe('AAPL')
    useRhStore.getState().setChartSymbol('BTC/USD')
    expect(useRhStore.getState().chartSymbol).toBe('AAPL')
    useRhStore.getState().setChartSymbol('')
    expect(useRhStore.getState().chartSymbol).toBe('AAPL')
  })
  it('survives disconnect resets of the Robinhood state', async () => {
    useRhStore.getState().setChartSymbol('TSLA')
    await useRhStore.getState().disconnect()
    expect(useRhStore.getState().chartSymbol).toBe('TSLA')
  })
})
