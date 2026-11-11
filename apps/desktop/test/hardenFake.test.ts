import { beforeEach, describe, expect, it } from 'vitest'
import { fake, fakeRh, fakeTm, TM_KEY_SLOT, type RhAccount } from '../src/lib/api'
import { clampedOf } from '../src/lib/tmFake'

const acct: RhAccount = {
  account_number: 'AGEN0002', rhs_account_number: null, rhc_account_number: null, agentic_allowed: true, option_level: null,
  kind: 'margin', is_default: true, unsettled_funds: null, nickname: null, brokerage_account_type: null,
}
const eq = (o: Record<string, string>) => ({ account_number: 'AGEN0002', symbol: 'AAA', side: 'buy', type: 'limit', quantity: '1', limit_price: '90', time_in_force: 'gfd', market_hours: 'regular_hours', ...o })

beforeEach(() => {
  fake.reset()
  fakeRh.accounts = [acct]
  fakeRh.connected = true
  fakeRh.last = { AAA: 100 }
})

describe('contract: PlaceOutcome.unknown carries retry_until', () => {
  it('is unix seconds about 600 s out', () => {
    fakeRh.failPlace = 1
    const r = fakeRh.reviewEquity(eq({}))
    const out = fakeRh.placeOrder(r.review_id)
    expect(out.kind).toBe('unknown')
    const until = (out as { retry_until?: number }).retry_until!
    const now = Date.now() / 1000
    expect(until).toBeGreaterThan(now + 590)
    expect(until).toBeLessThanOrEqual(now + 601)
  })
})

describe('contract: Order.trigger / stop_price, order_type stays raw', () => {
  it('stop_limit -> limit + stop, stop_market -> market + stop', () => {
    fakeRh.approvalsOn = false
    const a = fakeRh.reviewEquity(eq({ type: 'stop_limit', stop_price: '95' }))
    fakeRh.placeOrder(a.review_id)
    const b = fakeRh.reviewEquity({ account_number: 'AGEN0002', symbol: 'AAA', side: 'buy', type: 'stop_market', quantity: '1', stop_price: '94', time_in_force: 'gfd', market_hours: 'regular_hours' })
    fakeRh.placeOrder(b.review_id)
    const c = fakeRh.reviewEquity(eq({}))
    fakeRh.placeOrder(c.review_id)
    const orders = fakeRh.getOrders('AGEN0002', null)
    const byType = (t: string, trig: string) => orders.find((o) => o.order_type === t && o.trigger === trig)
    expect(byType('limit', 'stop')?.stop_price).toBe(95)
    expect(byType('market', 'stop')?.stop_price).toBe(94)
    expect(byType('limit', 'immediate')?.stop_price).toBeNull()
  })
})

describe('contract: TM clamped is a string or null', () => {
  it('clampedOf maps strings, drops everything else', () => {
    expect(clampedOf('below_band')).toBe('below_band')
    expect(clampedOf('above_band')).toBe('above_band')
    expect(clampedOf(null)).toBeNull()
    expect(clampedOf(false)).toBeNull()
    expect(clampedOf(true)).toBeNull()
    expect(clampedOf('weird')).toBeNull()
  })
  it('the fake iv rank answers with a string-or-null clamped', async () => {
    fake.secrets.add(TM_KEY_SLOT)
    const v = await fakeTm.ivRank('AAPL')
    expect(v.clamped === null || typeof v.clamped === 'string').toBe(true)
  })
})
