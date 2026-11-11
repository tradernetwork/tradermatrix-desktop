import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REFRESH_MS, startRefresher } from '../src/lib/refresher'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('F3 auto refresh', () => {
  it('fires every 20 s while visible, skips while hidden, and stops', () => {
    const fn = vi.fn()
    const hidden = { v: false }
    const stop = startRefresher(fn, { isHidden: () => hidden.v })
    expect(REFRESH_MS).toBe(20_000)
    vi.advanceTimersByTime(20_000)
    expect(fn).toHaveBeenCalledTimes(1)
    hidden.v = true
    vi.advanceTimersByTime(60_000)
    expect(fn).toHaveBeenCalledTimes(1)
    hidden.v = false
    vi.advanceTimersByTime(20_000)
    expect(fn).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(100_000)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
