import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RhQuote } from '../src/lib/api'
import { callsPerPoll, callsPerSecond, MAX_POLL_SYMBOLS, POLL_MS, QuotePoller } from '../src/stores/quotePoller'

const q = (symbol: string): RhQuote => ({ symbol, bid_price: null, ask_price: null, last_trade_price: 1, previous_close: null })

function make(hidden = { v: false }, extra: Partial<ConstructorParameters<typeof QuotePoller>[0]> = {}) {
  const fetch = vi.fn(async (s: string[]) => s.map(q))
  const onQuotes = vi.fn()
  const onError = vi.fn()
  const p = new QuotePoller({ fetch, onQuotes, onError, isHidden: () => hidden.v, ...extra })
  return { p, fetch, onQuotes, onError, hidden }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('QuotePoller', () => {
  it('fetches immediately, then every 5 s with all symbols in ONE batched call', async () => {
    const { p, fetch } = make()
    p.setOwner('watchlist', ['AAA', 'BBB'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toEqual(['AAA', 'BBB'])
    p.clear()
  })

  it('unions owners without duplicates and drops an owner cleanly', async () => {
    const { p, fetch } = make()
    p.setOwner('positions', ['AAA', 'BBB'])
    p.setOwner('watchlist', ['bbb', 'CCC'])
    expect(p.symbols()).toEqual(['AAA', 'BBB', 'CCC'])
    p.setOwner('positions', [])
    expect(p.symbols()).toEqual(['BBB', 'CCC'])
    p.setOwner('watchlist', [])
    expect(p.running).toBe(false)
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    const n = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(fetch.mock.calls.length).toBe(n)
  })

  it('pauses while the window is hidden and refreshes right away when it returns', async () => {
    const hidden = { v: false }
    const { p, fetch } = make(hidden)
    p.setOwner('w', ['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    hidden.v = true
    await vi.advanceTimersByTimeAsync(POLL_MS * 4)
    expect(fetch).toHaveBeenCalledTimes(1)
    hidden.v = false
    p.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    p.clear()
  })

  it('never overlaps requests', async () => {
    let release: () => void = () => undefined
    const fetch = vi.fn(() => new Promise<RhQuote[]>((r) => (release = () => r([]))))
    const p = new QuotePoller({ fetch, onQuotes: () => undefined, isHidden: () => false })
    p.setOwner('w', ['AAA'])
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(fetch).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    p.clear()
  })

  it('survives a failed fetch and reports it', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue([q('AAA')])
    const onError = vi.fn()
    const onQuotes = vi.fn()
    const p = new QuotePoller({ fetch, onQuotes, onError, isHidden: () => false })
    p.setOwner('w', ['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith('rate limited')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(onQuotes).toHaveBeenCalledTimes(1)
    p.clear()
  })

  it('stays under 4 Robinhood calls per second even at the symbol cap', () => {
    expect(callsPerPoll(1)).toBe(1)
    expect(callsPerPoll(20)).toBe(1)
    expect(callsPerPoll(45)).toBe(3)
    expect(callsPerSecond(MAX_POLL_SYMBOLS)).toBeLessThan(4)
    const { p } = make()
    p.setOwner('w', Array.from({ length: 500 }, (_, i) => `S${i}`))
    expect(p.symbols().length).toBe(MAX_POLL_SYMBOLS)
    p.clear()
  })
})
