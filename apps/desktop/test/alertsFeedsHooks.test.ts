import { describe, expect, it, vi } from 'vitest'
import { createSound, type AudioLike } from '../src/alerts/sound'
import { alertItemsFor, dirForPrice, hitAlert } from '../src/chart/alertChartHooks'
import type { RhOptionPosition, RhPosition } from '../src/lib/api'
import { buildHoldings } from '../src/stores/alertFeeds'
import { mkAlert } from './alertsHelpers'

describe('chart hooks', () => {
  it('only this symbol\'s enabled price alerts become lines; snoozed and disarmed states are marked; a ref alert carries its tag', () => {
    const now = 1000
    const items = alertItemsFor(
      [mkAlert({ id: 1 }), mkAlert({ id: 2, symbol: 'ZZZ' }), mkAlert({ id: 3, kind: 'iv' }), mkAlert({ id: 4, snooze_until: 5000 }), mkAlert({ id: 5, armed: false }), mkAlert({ id: 6, enabled: false }), mkAlert({ id: 7, ref_kind: 'apex', ref_param: 'rank:2' })],
      'AAA', now, new Set(), new Set([1]),
    )
    expect(items.map((i) => [i.id, i.state, i.flash, i.tag])).toEqual([[1, 'armed', true, ''], [4, 'snoozed', false, ''], [5, 'off', false, ''], [7, 'armed', false, 'APEX #2']])
  })
  it('direction follows the last price, and a hit test picks the nearest line within tolerance', () => {
    expect(dirForPrice(101, 100)).toBe('up')
    expect(dirForPrice(99, 100)).toBe('down')
    expect(dirForPrice(100, 100)).toBe('either')
    expect(dirForPrice(100, null)).toBe('either')
    const items = alertItemsFor([mkAlert({ id: 1, price: 100 }), mkAlert({ id: 2, price: 101 })], 'AAA', 0, new Set(), new Set())
    const yOf = (p: number) => 400 - p * 2
    expect(hitAlert(items, 199, yOf)).toBe(1)
    expect(hitAlert(items, 120, yOf)).toBeNull()
  })
})

describe('sound', () => {
  const el = (): AudioLike & { plays: number } => {
    const a = { plays: 0, currentTime: 5, volume: 1, muted: false, pause: vi.fn(), play: vi.fn(async () => { a.plays += 1 }) }
    return a
  }
  it('unlock primes the element muted and play restarts it audibly', async () => {
    const a = el()
    const s = createSound(() => a)
    s.unlock()
    await Promise.resolve()
    await Promise.resolve()
    expect(a.plays).toBe(1)
    s.play()
    expect(a.plays).toBe(2)
    expect(a.muted).toBe(false)
    expect(a.currentTime).toBe(0)
  })
  it('a blocked play never throws', () => {
    const a = el()
    a.play = vi.fn(async () => { throw new Error('NotAllowedError') })
    expect(() => createSound(() => a).play()).not.toThrow()
  })
})

describe('buildHoldings', () => {
  const opt = { option_id: 'o1', chain_symbol: 'AAA', expiration_date: '2026-12-18', strike_price: 90, option_type: 'put', side: 'short', quantity: 1, average_price: -200, multiplier: 100, bid: 1, ask: 1.2, mark: 1.1, delta: -0.2, theta: null, iv: null, min_ticks: null, pending_buy: null, pending_sell: null } as RhOptionPosition
  const eq = { symbol: 'AAA', quantity: 10, average_buy_price: 100, shares_available_for_sells: 10, shares_held_for_sells: 0 } as RhPosition
  const q = { AAA: { symbol: 'AAA', bid_price: null, ask_price: null, last_trade_price: 95, previous_close: null } }
  it('P&L per position, a verdict for each short option, and the earnings flag', () => {
    const h = buildHoldings({ options: [opt], equities: [eq], quotes: q, tmBits: () => ({ apex: null, move: null, iv: null }), earnings: () => ({ next: { date: '2026-12-01' } as never, last: null }), today: '2026-11-12' })
    expect(h.pnl.AAA).toBe(-50)
    expect(h.pnl.o1).toBeCloseTo(90, 6)
    expect(h.verdict.o1).toBe('event')
    expect(h.earningsInside.o1).toBe(true)
  })
  it('unknown earnings stay unknown, never "no earnings"', () => {
    const h = buildHoldings({ options: [opt], equities: [], quotes: q, tmBits: () => ({ apex: null, move: null, iv: null }), earnings: () => null, today: '2026-11-12' })
    expect(h.earningsInside.o1).toBeNull()
  })
})
