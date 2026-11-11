import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RhQuote } from '../src/lib/api'
import { QuotePoller } from '../src/stores/quotePoller'

const q = (symbol: string): RhQuote => ({ symbol, bid_price: null, ask_price: null, last_trade_price: 1, previous_close: null })
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const make = (extra: Partial<ConstructorParameters<typeof QuotePoller>[0]> = {}) => {
  const fetch = vi.fn(async (s: string[]) => s.map(q))
  const onQuotes = vi.fn()
  const p = new QuotePoller({ fetch, onQuotes, isHidden: () => false, ...extra })
  return { p, fetch, onQuotes }
}

describe('F7 poller priority, filter, cap', () => {
  it('orders ticket, positions, chart, watchlist regardless of registration order', () => {
    const { p } = make()
    p.setOwner('watchlist', ['W1', 'W2'])
    p.setOwner('other', ['O1'])
    p.setOwner('chart', ['C1'])
    p.setOwner('positions', ['P1'])
    p.setOwner('ticket', ['T1'])
    expect(p.symbols()).toEqual(['T1', 'P1', 'C1', 'W1', 'W2', 'O1'])
    p.clear()
  })
  it('drops symbols that are not equity tickers', () => {
    const { p } = make()
    p.setOwner('w', ['AAA', 'BTC/USD', '1X', 'brk.b'])
    expect(p.symbols()).toEqual(['AAA', 'BRK.B'])
    p.clear()
  })
  it('caps the list and reports truncation; priority symbols survive the cut', () => {
    const { p } = make({ maxSymbols: 3 })
    p.setOwner('watchlist', ['W1', 'W2', 'W3'])
    p.setOwner('ticket', ['T1'])
    expect(p.symbols()).toEqual(['T1', 'W1', 'W2'])
    expect(p.truncated).toBe(true)
    p.setOwner('watchlist', ['W1'])
    expect(p.truncated).toBe(false)
    p.clear()
  })
})

describe('F5 poller epoch', () => {
  it('a response that lands after clear() is dropped', async () => {
    let release: (v: RhQuote[]) => void = () => undefined
    const fetch = vi.fn(() => new Promise<RhQuote[]>((r) => (release = r)))
    const onQuotes = vi.fn()
    const p = new QuotePoller({ fetch, onQuotes, isHidden: () => false })
    p.setOwner('w', ['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    p.clear()
    release([q('AAA')])
    await vi.advanceTimersByTimeAsync(0)
    expect(onQuotes).not.toHaveBeenCalled()
    expect(p.running).toBe(false)
  })
  it('after clear() a new owner can fetch even if an old request never finished', async () => {
    const fetch = vi.fn(() => new Promise<RhQuote[]>(() => undefined))
    const p = new QuotePoller({ fetch, onQuotes: vi.fn(), isHidden: () => false })
    p.setOwner('w', ['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    p.clear()
    p.setOwner('w', ['BBB'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    p.clear()
  })
})
