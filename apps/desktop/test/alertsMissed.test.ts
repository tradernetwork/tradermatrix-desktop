import { describe, expect, it, vi } from 'vitest'
import { missedCross, runMissedPass, type MissedDeps } from '../src/alerts/missed'
import type { StoredCandle } from '../src/lib/api'
import { mkAlert } from './alertsHelpers'

const c = (ts: number, low: number, high: number, close: number): StoredCandle => ({ ts, open: close, high, low, close, volume: 1 })

describe('missedCross (task 9)', () => {
  it('stored candles that cross 100 upward after the app closed give one crossing', () => {
    const a = mkAlert({ last_side: -1, dir: 'up' })
    const r = missedCross(a, [c(1000, 98, 99.5, 99), c(2000, 99, 101.2, 101), c(3000, 100.5, 102, 101.5)], 500)
    expect(r).toMatchObject({ side: 1, px: 101.2 })
  })
  it('candles from before the app closed are ignored', () => {
    const a = mkAlert({ last_side: -1, dir: 'up' })
    expect(missedCross(a, [c(100, 99, 105, 104)], 500)).toBeNull()
  })
  it('touching without crossing, the wrong direction and a never-observed alert give nothing', () => {
    expect(missedCross(mkAlert({ last_side: -1 }), [c(1000, 98, 100, 99)], 500)).toBeNull()
    expect(missedCross(mkAlert({ last_side: -1, dir: 'down' }), [c(1000, 98, 103, 102)], 500)).toBeNull()
    expect(missedCross(mkAlert({ last_side: null }), [c(1000, 98, 103, 102)], 500)).toBeNull()
  })
  it('a downward cross for a down alert reports the low', () => {
    expect(missedCross(mkAlert({ last_side: 1, dir: 'down' }), [c(1000, 98.7, 101, 99)], 500)).toMatchObject({ side: -1, px: 98.7 })
  })
})

describe('runMissedPass', () => {
  const base = (over: Partial<MissedDeps> = {}) => ({
    loadCandles: vi.fn(async () => [c(1000, 99, 101.2, 101)]),
    quotes: vi.fn(async () => []),
    fire: vi.fn(async () => ({ outcome: 'fired', event: { id: 1, missed: true } }) as never),
    since: 500,
    ...over,
  }) as unknown as MissedDeps & { fire: ReturnType<typeof vi.fn> }
  it('stored candles cross 100 while closed: ONE event with missed=1, and the notify path is never touched', async () => {
    const d = base()
    const notify = vi.fn()
    const r = await runMissedPass([mkAlert({ last_side: -1 })], d)
    expect(d.fire).toHaveBeenCalledTimes(1)
    expect(d.fire.mock.calls[0]).toMatchObject([1, 1, 101.2, expect.any(Number), { kind: 'missed', missed: true }])
    expect(r.events).toHaveLength(1)
    expect(notify).not.toHaveBeenCalled()
  })
  it('a fresh quote past the level counts when the candles show nothing; no second event for the same alert', async () => {
    const d = base({ loadCandles: vi.fn(async () => []), quotes: vi.fn(async () => [{ symbol: 'AAA', bid_price: null, ask_price: null, last_trade_price: 101.5, previous_close: null }]) })
    const r = await runMissedPass([mkAlert({ last_side: -1 })], d)
    expect(d.fire).toHaveBeenCalledTimes(1)
    expect(r.events).toHaveLength(1)
  })
  it('disabled, snoozed and non-price alerts are not part of the pass', async () => {
    const d = base()
    await runMissedPass([mkAlert({ enabled: false, last_side: -1 }), mkAlert({ id: 2, kind: 'iv', last_side: -1 }), mkAlert({ id: 3, snooze_until: 9e15, last_side: -1 })], d)
    expect(d.fire).not.toHaveBeenCalled()
  })
})
