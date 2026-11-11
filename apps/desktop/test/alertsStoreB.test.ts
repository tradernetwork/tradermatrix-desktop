import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeAlerts } from '../src/lib/alertsFake'
import { api } from '../src/lib/api'
import { useAlertsStore } from '../src/stores/alerts'

const S = () => useAlertsStore.getState()
const OPEN = Date.UTC(2026, 10, 12, 15, 30)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(OPEN)
  fakeAlerts.reset()
  S().reset()
})
afterEach(() => vi.restoreAllMocks())
const base = { kind: 'price', ref_kind: 'price', dir: 'up', mode: 'cross', repeat: 'once' } as const

describe('chart creation and drag (task 6)', () => {
  it('createPriceAlert rounds to cents, stores a manual alert and records no side yet', async () => {
    const a = await S().createPriceAlert({ symbol: 'AAA', price: 100.456, dir: 'up' })
    expect(a).toMatchObject({ price: 100.46, ref_kind: 'price', last_side: null, repeat: 'once' })
    expect(await S().createPriceAlert({ symbol: 'AAA', price: 0, dir: 'up' })).toBeNull()
  })
  it('a drag rewrites price and side in one update, so the next observation sees no flip and releasing never fires', async () => {
    const a = (await S().create({ symbol: 'AAA', price: 100, ...base }))!
    await S().update(a.id, { last_side: -1 })
    const fire = vi.spyOn(api, 'alertFire')
    const d = await S().dragTo(a.id, 95, 98)
    expect(d).toMatchObject({ price: 95, last_side: 1 })
    // price now 98: above the new level, same side as recorded: no fire
    await S().onQuotes([{ symbol: 'AAA', bid_price: null, ask_price: null, last_trade_price: 98, previous_close: null }], { startedAt: Date.now() })
    expect(fire).not.toHaveBeenCalled()
  })
  it('dragging a by-reference alert makes a manual one at the new price and removes the reference alert', async () => {
    const a = (await S().create({ symbol: 'AAA', price: 450, ...base, ref_kind: 'apex', ref_param: 'rank:2' }))!
    const m = await S().convertAndMove(a.id, 455, 451)
    expect(m).toMatchObject({ ref_kind: 'price', price: 455, last_side: -1 })
    expect(S().alerts.map((x) => x.id)).toEqual([m!.id])
  })
})

describe('non-price alerts (tasks 10 and 11)', () => {
  it('a price-kind engine pass ignores verdict / pnl / iv / earnings / order alerts', async () => {
    await S().create({ symbol: 'AAA', kind: 'iv', ref_kind: 'iv', price: 60, dir: 'up', mode: 'cross', repeat: 'once', last_side: -1 })
    const fire = vi.spyOn(api, 'alertFire')
    await S().onQuotes([{ symbol: 'AAA', bid_price: null, ask_price: null, last_trade_price: 99, previous_close: null }], { startedAt: Date.now() })
    expect(fire).not.toHaveBeenCalled()
  })
  it('verdict alert: protected -> exposed fires once and not again until it changes', async () => {
    await S().create({ symbol: 'AAA', kind: 'verdict', ref_kind: 'verdict', ref_param: JSON.stringify({ opt: 'o1', to: 'exposed' }), price: 100, dir: 'either', mode: 'cross', repeat: 'rearm', cooldown_s: 0 })
    const h = (v: 'protected' | 'exposed') => ({ pnl: {}, verdict: { o1: v }, earningsInside: {} })
    await S().checkHoldings(h('protected'))
    expect(S().events).toHaveLength(0)
    await S().checkHoldings(h('exposed'))
    expect(S().events).toHaveLength(1)
    expect(S().events[0]!.label).toContain('protected to exposed')
  })
  it('P&L alert: -500.01 fires, -499.99 does not', async () => {
    const mk = async () => (await S().create({ symbol: 'AAA', kind: 'pnl', ref_kind: 'pnl', ref_param: JSON.stringify({ pos: 'o1', thr: -500, opt: true }), price: 500, dir: 'down', mode: 'cross', repeat: 'once' }))!
    await mk()
    const h = (v: number) => ({ pnl: { o1: v }, verdict: {}, earningsInside: {} })
    await S().checkHoldings(h(-300))
    await S().checkHoldings(h(-499.99))
    expect(S().events).toHaveLength(0)
    await S().checkHoldings(h(-500.01))
    expect(S().events).toHaveLength(1)
    expect(S().events[0]!.label).toContain('units unverified')
  })
  it('IV rank alert: 59.9 then 60.1 fires once', async () => {
    await S().create({ symbol: 'AAA', kind: 'iv', ref_kind: 'iv', price: 60, dir: 'up', mode: 'cross', repeat: 'rearm', cooldown_s: 0 })
    await S().checkIv({ AAA: 59.9 })
    await S().checkIv({ AAA: 60.1 })
    await S().checkIv({ AAA: 61 })
    expect(S().events).toHaveLength(1)
  })
  it('earnings alert fires when the date is inside the expiry', async () => {
    await S().create({ symbol: 'AAA', kind: 'earnings', ref_kind: 'verdict', ref_param: JSON.stringify({ opt: 'o1' }), price: 100, dir: 'either', mode: 'cross', repeat: 'once' })
    await S().checkHoldings({ pnl: {}, verdict: {}, earningsInside: { o1: false } })
    expect(S().events).toHaveLength(0)
    await S().checkHoldings({ pnl: {}, verdict: {}, earningsInside: { o1: true } })
    expect(S().events).toHaveLength(1)
  })
  it('order alert: the first snapshot is silent; filled fires for the matching symbol only', async () => {
    await S().create({ symbol: 'AAA', kind: 'order', ref_kind: 'order', price: 1, dir: 'either', mode: 'cross', repeat: 'once' })
    await S().onOrders([{ id: '1', symbol: 'AAA', state: 'queued' }, { id: '2', symbol: 'BBB', state: 'queued' }])
    await S().onOrders([{ id: '1', symbol: 'AAA', state: 'queued' }, { id: '2', symbol: 'BBB', state: 'filled' }])
    expect(S().events).toHaveLength(0)
    await S().onOrders([{ id: '1', symbol: 'AAA', state: 'filled' }, { id: '2', symbol: 'BBB', state: 'filled' }])
    expect(S().events.map((e) => e.label)).toEqual(['AAA order filled'])
  })
})

describe('delivery wiring (task 8) and the missed pass (task 9)', () => {
  it('a fire asks for an OS notice; a failing notice sets the unavailable flag once and never throws', async () => {
    const notify = vi.spyOn(api, 'alertNotify').mockRejectedValue(new Error('no daemon'))
    const a = (await S().create({ symbol: 'AAA', price: 100, ...base }))!
    const out = fakeAlerts.fire(a.id, 1, 101, 0)
    if (out.outcome === 'fired') S().notifyFired(out.event)
    await vi.waitFor(() => expect(S().osUnavailable).toBe(true))
    const b = (await S().create({ symbol: 'BBB', price: 100, ...base }))!
    const o2 = fakeAlerts.fire(b.id, 1, 101, 0)
    if (o2.outcome === 'fired') S().notifyFired(o2.event)
    await new Promise((r) => setTimeout(r, 0))
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('the OS toggle off asks for nothing', async () => {
    const notify = vi.spyOn(api, 'alertNotify')
    await S().setPref('os', false)
    const a = (await S().create({ symbol: 'AAA', price: 100, ...base }))!
    const out = fakeAlerts.fire(a.id, 1, 101, 0)
    if (out.outcome === 'fired') S().notifyFired(out.event)
    expect(notify).not.toHaveBeenCalled()
  })
  it('app-closed pass: a fresh quote past the level gives one missed event, one summary toast, and never the notify path', async () => {
    const notify = vi.spyOn(api, 'alertNotify')
    const a = (await S().create({ symbol: 'AAA', price: 100, ...base, last_side: -1 }))!
    vi.spyOn(api, 'candlesLoad').mockResolvedValue([])
    vi.spyOn(api, 'rhQuotes').mockResolvedValue([{ symbol: 'AAA', bid_price: null, ask_price: null, last_trade_price: 101, previous_close: null }])
    await S().load()
    await S().runMissed(a.created_at - 1)
    expect(S().events).toHaveLength(1)
    expect(S().events[0]).toMatchObject({ missed: true, kind: 'missed' })
    expect(S().toasts.map((t) => t.text)).toEqual(['1 alert crossed while you were away'])
    expect(notify).not.toHaveBeenCalled()
  })
})
