import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { armedAlerts, hasArmedAlerts, isActive, isTracked, snoozeUntil } from '../src/alerts/active'
import { runAlertTick, type EngineDeps } from '../src/alerts/engine'
import type { FireOutcome } from '../src/alerts/types'
import type { RhQuote } from '../src/lib/api'
import { POLL_MS, QuotePoller } from '../src/stores/quotePoller'
import { mkAlert } from './alertsHelpers'

const quote = (symbol: string, px: number | null): RhQuote => ({ symbol, bid_price: null, ask_price: null, last_trade_price: px, previous_close: null })
const NOW = 1_800_000_000_000
const skipped: FireOutcome = { outcome: 'skipped', reason: 'cooldown' }

function deps(over: Partial<EngineDeps> = {}): EngineDeps & { fire: ReturnType<typeof vi.fn>; setSide: ReturnType<typeof vi.fn> } {
  return {
    now: () => NOW,
    session: () => ({ open: true, extendedOnly: false }),
    fire: vi.fn(async () => skipped),
    setSide: vi.fn(),
    ...over,
  } as never
}

describe('runAlertTick (task 4)', () => {
  it('a batch of 3 symbols with 1 alert makes exactly 1 evaluate call', async () => {
    const evaluate = vi.fn((..._a: unknown[]) => ({ fire: false, side: 1 as const, observed: true }))
    const d = deps({ evaluate })
    await runAlertTick([mkAlert({ symbol: 'BBB', last_side: 1 })], [quote('AAA', 10), quote('BBB', 101), quote('CCC', 30)], { startedAt: NOW }, d)
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(evaluate.mock.calls[0]).toMatchObject([{ symbol: 'BBB' }, { px: 101, prevSide: 1 }])
  })

  it('no armed alert, or none for the batch: nothing is evaluated', async () => {
    const evaluate = vi.fn()
    const d = deps({ evaluate })
    await runAlertTick([], [quote('AAA', 10)], { startedAt: NOW }, d)
    await runAlertTick([mkAlert({ symbol: 'ZZZ' }), mkAlert({ id: 2, enabled: false })], [quote('AAA', 10)], { startedAt: NOW }, d)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('a crossing calls fire once with the side, price and age; the local side is recorded before the call returns', async () => {
    const d = deps()
    const a = mkAlert({ last_side: -1 })
    const rep = await runAlertTick([a], [quote('AAA', 101)], { startedAt: NOW - 3000 }, d)
    expect(d.fire).toHaveBeenCalledTimes(1)
    expect(d.fire).toHaveBeenCalledWith(1, 1, 101, 3)
    expect(rep.fired).toEqual([])
    expect(d.setSide).toHaveBeenCalledWith(1, 1)
  })

  it('records a changed side without firing, and a first observation records only', async () => {
    const d = deps()
    await runAlertTick([mkAlert({ id: 1, last_side: null }), mkAlert({ id: 2, last_side: 1, dir: 'down', symbol: 'AAA' })], [quote('AAA', 101)], { startedAt: NOW }, d)
    expect(d.fire).not.toHaveBeenCalled()
    expect(d.setSide).toHaveBeenCalledWith(1, 1)
    expect(d.setSide).toHaveBeenCalledTimes(1) // alert 2 stayed on its side
  })

  it('a quote with no usable price is skipped; mid of bid/ask is used when there is no last trade', async () => {
    const evaluate = vi.fn((..._a: unknown[]) => ({ fire: false, side: 1 as const, observed: true }))
    const d = deps({ evaluate })
    await runAlertTick([mkAlert()], [quote('AAA', null)], { startedAt: NOW }, d)
    expect(evaluate).not.toHaveBeenCalled()
    await runAlertTick([mkAlert()], [{ symbol: 'AAA', bid_price: 100, ask_price: 102, last_trade_price: null, previous_close: null }], { startedAt: NOW }, d)
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({ px: 101 })
  })

  it('a fired outcome is returned for the toast layer, and the stale guard reaches evaluate', async () => {
    const ev = { id: 9, alert_id: 1, fired_at: NOW, symbol: 'AAA', label: 'AAA above 100.00', trigger_px: 101, ref_px: 100, quote_age_s: 0, kind: 'fire', seen: false, missed: false }
    const d = deps({ fire: vi.fn(async () => ({ outcome: 'fired', event: ev }) as FireOutcome) })
    const rep = await runAlertTick([mkAlert({ last_side: -1 })], [quote('AAA', 101)], { startedAt: NOW }, d)
    expect(rep.fired).toEqual([ev])
    const stale = deps()
    await runAlertTick([mkAlert({ last_side: -1 })], [quote('AAA', 101)], { startedAt: NOW - 25_000 }, stale)
    expect(stale.fire).not.toHaveBeenCalled()
  })

  it('a snoozed alert is still watched (its side is tracked) but never fires', async () => {
    const d = deps()
    const a = mkAlert({ last_side: -1, snooze_until: NOW + 60_000 })
    await runAlertTick([a], [quote('AAA', 101)], { startedAt: NOW }, d)
    expect(d.fire).not.toHaveBeenCalled()
    expect(d.setSide).toHaveBeenCalledWith(1, 1)
    // a session snooze behaves the same
    const d2 = deps({ sessionSnoozed: new Set([1]) })
    await runAlertTick([mkAlert({ last_side: -1 })], [quote('AAA', 101)], { startedAt: NOW }, d2)
    expect(d2.fire).not.toHaveBeenCalled()
    expect(d2.setSide).toHaveBeenCalledWith(1, 1)
    expect(isTracked(a, NOW)).toBe(true)
    expect(isTracked(mkAlert({ enabled: false }), NOW)).toBe(false)
  })

  it('a fire call that throws does not break the batch', async () => {
    const d = deps({ fire: vi.fn(async () => { throw new Error('db busy') }) })
    const rep = await runAlertTick([mkAlert({ last_side: -1 }), mkAlert({ id: 2, symbol: 'BBB', last_side: -1 })], [quote('AAA', 101), quote('BBB', 101)], { startedAt: NOW }, d)
    expect(d.fire).toHaveBeenCalledTimes(2)
    expect(rep.errors).toBe(2)
  })
})

describe('which alerts are armed (snooze, session snooze, expiry)', () => {
  it('snooze 15 m suppresses, then resumes exactly at the end', () => {
    const until = snoozeUntil('15m', NOW)
    expect(until).toBe(NOW + 15 * 60_000)
    const a = mkAlert({ snooze_until: until })
    expect(isActive(a, NOW + 1)).toBe(false)
    expect(isActive(a, NOW + 15 * 60_000 - 1)).toBe(false)
    expect(isActive(a, NOW + 15 * 60_000)).toBe(true)
    expect(snoozeUntil('1h', NOW)).toBe(NOW + 3_600_000)
    expect(snoozeUntil('off', NOW)).toBe(0)
    expect(snoozeUntil('session', NOW)).toBeNull()
  })

  it('session snooze lives in memory only; disabled, disarmed and expired alerts are not armed', () => {
    const a = mkAlert({ id: 5 })
    expect(isActive(a, NOW, new Set([5]))).toBe(false)
    expect(isActive(a, NOW, new Set([6]))).toBe(true)
    expect(isActive(mkAlert({ enabled: false }), NOW)).toBe(false)
    expect(isActive(mkAlert({ armed: false }), NOW)).toBe(false)
    expect(isActive(mkAlert({ expires_at: NOW }), NOW)).toBe(false)
    expect(isActive(mkAlert({ expires_at: NOW + 1 }), NOW)).toBe(true)
    expect(armedAlerts([a, mkAlert({ id: 6, enabled: false })], NOW).map((x) => x.id)).toEqual([5])
    expect(hasArmedAlerts([], NOW)).toBe(false)
    expect(hasArmedAlerts([a], NOW)).toBe(true)
  })
})

describe('QuotePoller hidden mode (task 4)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const make = (hidden: boolean, armed: boolean) => {
    const fetch = vi.fn(async (s: string[]) => s.map((x) => quote(x, 1)))
    const p = new QuotePoller({ fetch, onQuotes: vi.fn(), isHidden: () => hidden, hasArmedAlerts: () => armed })
    return { p, fetch }
  }

  it('hidden with an armed alert: the interval is 15000 ms and the poller keeps fetching at that pace', async () => {
    const { p, fetch } = make(true, true)
    expect(p.currentIntervalMs()).toBe(15_000)
    p.setOwner('w', ['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetch).toHaveBeenCalledTimes(3)
    p.clear()
  })

  it('visible, or hidden with no armed alert: existing behaviour (5 s visible, no fetch while hidden)', async () => {
    const vis = make(false, true)
    expect(vis.p.currentIntervalMs()).toBe(POLL_MS)
    vis.p.setOwner('w', ['AAA'])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(vis.fetch).toHaveBeenCalledTimes(2)
    vis.p.clear()
    const hid = make(true, false)
    expect(hid.p.currentIntervalMs()).toBe(POLL_MS)
    hid.p.setOwner('w', ['AAA'])
    await vi.advanceTimersByTimeAsync(POLL_MS * 4)
    expect(hid.fetch).not.toHaveBeenCalled()
    hid.p.clear()
  })

  it('the quote meta carries when the fetch started', async () => {
    const onQuotes = vi.fn()
    const p = new QuotePoller({ fetch: async (s) => s.map((x) => quote(x, 1)), onQuotes, isHidden: () => false })
    p.setOwner('w', ['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    expect(onQuotes).toHaveBeenCalledTimes(1)
    expect(typeof onQuotes.mock.calls[0]?.[1]?.startedAt).toBe('number')
    p.clear()
  })
})
