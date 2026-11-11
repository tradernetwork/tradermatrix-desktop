import { describe, expect, it } from 'vitest'
import { fmtMoney, fmtNum, fmtPct, fmtPrice } from '../src/lib/format'
import { EQUITY_SYMBOL, isEquityTicker } from '../src/lib/symbols'
import { normalizeSymbol } from '../src/chart/useChartData'
import { isSymbol } from '../src/lib/orderValidation'
import { WATCH_SYMBOL } from '../src/lib/watchRules'

describe('F7 number formatting', () => {
  it('fmtPrice uses 4 decimals below $1 and 2 otherwise', () => {
    expect(fmtPrice(0.1234)).toBe('0.1234')
    expect(fmtPrice(-0.5)).toBe('-0.5000')
    expect(fmtPrice(0.99999)).toBe('1.0000')
    expect(fmtPrice(12.3456)).toBe('12.35')
    expect(fmtPrice(null)).toBe('-')
  })
  it('never prints negative zero', () => {
    expect(fmtMoney(-0.001)).toBe('$0.00')
    expect(fmtMoney(-0.004)).toBe('$0.00')
    expect(fmtMoney(-0.005)).toBe('-$0.01')
    expect(fmtPct(-0.001)).toBe('0.00%')
    expect(fmtPct(0.001)).toBe('0.00%')
    expect(fmtPct(-0.4)).toBe('-0.40%')
    expect(fmtPct(1.25)).toBe('+1.25%')
    expect(fmtNum(-0.0001)).toBe('0.00')
    expect(fmtNum(-1.5)).toBe('-1.50')
  })
})

describe('F7 one symbol rule', () => {
  it('equity tickers: ^[A-Z][A-Z0-9.-]{0,9}$', () => {
    expect(EQUITY_SYMBOL.source).toBe('^[A-Z][A-Z0-9.-]{0,9}$')
    for (const ok of ['A', 'AAPL', 'BRK.B', 'BF-B', 'ABCDEFGHIJ', 'A1']) expect(isEquityTicker(ok)).toBe(true)
    for (const bad of ['', '1ABC', 'aapl', 'ABCDEFGHIJK', 'BTC/USD', 'A B', '.X']) expect(isEquityTicker(bad)).toBe(false)
  })
  it('chart, order validation and watchlist writes use the same rule', () => {
    expect(normalizeSymbol(' brk.b ')).toBe('BRK.B')
    expect(normalizeSymbol('AAPL1')).toBe('AAPL1')
    expect(normalizeSymbol('BTC/USD')).toBeNull()
    expect(normalizeSymbol('ABCDEFGHIJK')).toBeNull()
    expect(isSymbol('BF-B')).toBe(true)
    expect(WATCH_SYMBOL.source).toBe(EQUITY_SYMBOL.source)
  })
})
