import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeAlerts } from '../src/lib/alertsFake'
import type { RhQuote } from '../src/lib/api'
import { useAlertsStore } from '../src/stores/alerts'

const S = () => useAlertsStore.getState()
const quote = (symbol: string, px: number): RhQuote => ({ symbol, bid_price: null, ask_price: null, last_trade_price: px, previous_close: null })
const NEW = { symbol: 'AAA', kind: 'price', ref_kind: 'price', price: 100, dir: 'up', mode: 'cross', repeat: 'once' } as const
const feed = (px: number, symbol = 'AAA') => S().onQuotes([quote(symbol, px)], { startedAt: Date.now() })
// 2026-11-12 10:30 ET (a Thursday, regular session)
const OPEN = Date.UTC(2026, 10, 12, 15, 30)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(OPEN)
  fakeAlerts.reset()
  S().reset()
})
afterEach(() => vi.useRealTimers())

describe('alerts store', () => {
  it('loads, creates, updates, deletes through the alert commands', async () => {
    await S().load()
    expect(S().alerts).toEqual([])
    const a = await S().create(NEW)
    expect(S().alerts.map((x) => x.id)).toEqual([a!.id])
    expect(S().armedCount()).toBe(1)
    await S().setEnabled(a!.id, false)
    expect(S().alerts[0]!.enabled).toBe(false)
    expect(S().armedCount()).toBe(0)
    await S().remove(a!.id)
    expect(S().alerts).toEqual([])
  })

  it('a bad alert comes back as an error message and changes nothing', async () => {
    const r = await S().create({ ...NEW, price: -1 })
    expect(r).toBeNull()
    expect(S().error).toMatch(/price/)
    expect(S().alerts).toEqual([])
  })

  it('first quote only records the side; a crossing fires once: one toast, one unseen event', async () => {
    await S().create(NEW)
    await feed(99)
    expect(S().toasts).toEqual([])
    expect(S().alerts[0]!.last_side).toBe(-1)
    await feed(101)
    expect(S().toasts).toHaveLength(1)
    expect(S().toasts[0]!.text).toMatch(/AAA/)
    expect(S().events).toHaveLength(1)
    expect(S().unseen).toBe(1)
    expect(S().alerts[0]!.enabled).toBe(false) // a once alert disables itself
    await feed(102)
    expect(S().toasts).toHaveLength(1)
    expect(fakeAlerts.eventCount()).toBe(1)
  })

  it('two polls delivering the same crossing at once produce exactly one event (the guard is the Rust-side single fire)', async () => {
    await S().create(NEW)
    await feed(99)
    await Promise.all([feed(101), feed(101)])
    expect(fakeAlerts.eventCount()).toBe(1)
    expect(S().toasts).toHaveLength(1)
  })

  it('6 fires in 1 hour on one symbol: 5 toasts and one summary, all 6 events kept', async () => {
    for (let i = 0; i < 6; i++) await S().create({ ...NEW, price: 100 + i })
    await feed(90)
    await feed(200)
    expect(fakeAlerts.eventCount()).toBe(6)
    const shown = S().toasts.filter((t) => t.kind === 'fire')
    const more = S().toasts.filter((t) => t.kind === 'more')
    expect(shown).toHaveLength(5)
    expect(more).toHaveLength(1)
    expect(more[0]!.text).toBe('1 more alert')
    expect(S().unseen).toBe(6)
  })

  it('snooze 15 m: the crossing during the snooze is silent, a new crossing after it fires', async () => {
    const a = (await S().create({ ...NEW, repeat: 'rearm' }))!
    await feed(99)
    await S().snooze(a.id, '15m')
    expect(S().alerts[0]!.snooze_until).toBe(OPEN + 15 * 60_000)
    await feed(101) // crosses while snoozed
    expect(fakeAlerts.eventCount()).toBe(0)
    expect(S().toasts).toEqual([])
    vi.setSystemTime(OPEN + 15 * 60_000 + 1000)
    await feed(101) // still above: its side was tracked, so this is not a crossing
    expect(fakeAlerts.eventCount()).toBe(0)
    await feed(99)
    await feed(101)
    expect(fakeAlerts.eventCount()).toBe(1)
  })

  it('session snooze is in memory and clears with "off"; it does not touch the stored alert', async () => {
    const a = (await S().create(NEW))!
    await feed(99)
    await S().snooze(a.id, 'session')
    expect(S().sessionSnoozed).toEqual([a.id])
    expect(fakeAlerts.get(a.id)!.snooze_until).toBeNull()
    await feed(101)
    expect(fakeAlerts.eventCount()).toBe(0)
    await S().snooze(a.id, 'off')
    expect(S().sessionSnoozed).toEqual([])
  })

  it('outside the regular session nothing fires (and nothing is recorded)', async () => {
    await S().create(NEW)
    await feed(99)
    vi.setSystemTime(Date.UTC(2026, 10, 14, 15, 30)) // Saturday
    await feed(101)
    expect(fakeAlerts.eventCount()).toBe(0)
    expect(S().alerts[0]!.last_side).toBe(-1)
  })

  it('a rearm alert that fired re-arms after the retreat and can fire again after its cooldown', async () => {
    await S().create({ ...NEW, repeat: 'rearm', cooldown_s: 0 })
    await feed(99)
    await feed(101)
    expect(fakeAlerts.eventCount()).toBe(1)
    expect(S().alerts[0]!.armed).toBe(false)
    await feed(100.04)
    expect(S().alerts[0]!.armed).toBe(false)
    await feed(99.9)
    expect(S().alerts[0]!.armed).toBe(true)
    await feed(101)
    expect(fakeAlerts.eventCount()).toBe(2)
  })

  it('history: loadEvents, ack marks seen and clears the badge', async () => {
    await S().create(NEW)
    await feed(99)
    await feed(101)
    expect(S().unseen).toBe(1)
    S().reset()
    await S().loadEvents()
    expect(S().events).toHaveLength(1)
    expect(S().unseen).toBe(1)
    await S().ack()
    expect(S().unseen).toBe(0)
    expect(S().events[0]!.seen).toBe(true)
  })

  it('dismissing a toast removes just that one; wipe clears toasts and the spam window but keeps the alerts', async () => {
    await S().create(NEW)
    await S().create({ ...NEW, price: 101 })
    await feed(99)
    await feed(105)
    expect(S().toasts).toHaveLength(2)
    S().dismissToast(S().toasts[0]!.id)
    expect(S().toasts).toHaveLength(1)
    S().wipe()
    expect(S().toasts).toEqual([])
    expect(S().alerts).toHaveLength(2)
  })
})
