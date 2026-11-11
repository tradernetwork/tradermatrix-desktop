import { beforeEach, describe, expect, it } from 'vitest'
import { deskStatChips } from '../../src/lib/deskUi'
import { useDeskStatsStore } from '../../src/stores/deskStats'

describe('deskStatChips', () => {
  it('prints ATR(len) and the range position, "-" when unknown', () => {
    const c = deskStatChips({ symbol: 'AAPL', atrLen: 34, atr: 2.4137, rangePos: 0.6249 }, 'AAPL')
    expect(c.map((x) => x.key)).toEqual(['atr', 'rangepos'])
    expect(c[0]!.text).toBe('ATR(34) 2.41')
    expect(c[1]!.text).toBe('range pos 0.62')
    const u = deskStatChips(null, 'AAPL')
    expect(u[0]!.text).toBe('ATR -')
    expect(u[1]!.text).toBe('range pos -')
  })
  it('stats of another symbol are not shown', () => {
    expect(deskStatChips({ symbol: 'MSFT', atrLen: 34, atr: 2, rangePos: 0.5 }, 'AAPL')[0]!.text).toBe('ATR -')
  })
  it('NaN and null fields print "-"', () => {
    const c = deskStatChips({ symbol: 'AAPL', atrLen: 34, atr: NaN, rangePos: null }, 'AAPL')
    expect(c[0]!.text).toBe('ATR(34) -')
    expect(c[1]!.text).toBe('range pos -')
  })
})

describe('desk stats store', () => {
  beforeEach(() => useDeskStatsStore.getState().clear())
  it('set and clear', () => {
    useDeskStatsStore.getState().set({ symbol: 'AAPL', atrLen: 34, atr: 1, rangePos: 0.5 })
    expect(useDeskStatsStore.getState().stats?.symbol).toBe('AAPL')
    useDeskStatsStore.getState().clear()
    expect(useDeskStatsStore.getState().stats).toBeNull()
  })
})
