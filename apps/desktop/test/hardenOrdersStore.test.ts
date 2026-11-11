import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeRh, type EquityOrderArgs, type OptionOrderArgs, type RhAccount } from '../src/lib/api'
import { placeBlockedReason, useOrdersStore, type Ticket } from '../src/stores/orders'
import { useRhStore } from '../src/stores/rh'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'SYN00000001', rhs_account_number: null, rhc_account_number: null, agentic_allowed: false, option_level: null,
  kind: 'margin', is_default: false, unsettled_funds: null, nickname: null, brokerage_account_type: null, ...o,
})
const AGENTIC = 'AGEN0002'
const UUID = '11111111-2222-4333-8444-555555555555'
const eqArgs = (o: Partial<EquityOrderArgs> = {}): EquityOrderArgs => ({
  account_number: AGENTIC, symbol: 'AAA', side: 'buy', type: 'limit', quantity: '1', limit_price: '90', time_in_force: 'gfd', market_hours: 'regular_hours', ...o,
})
const eqTicket = (o: Partial<EquityOrderArgs> = {}): Ticket => ({ kind: 'equity', args: eqArgs(o) })
const opArgs = (): OptionOrderArgs => ({
  account_number: AGENTIC, legs: [{ option_id: UUID, side: 'buy', position_effect: 'open', ratio_quantity: 1 }], quantity: '1', type: 'limit', price: '1.50', time_in_force: 'gfd', market_hours: 'regular_hours',
})

const fresh = () =>
  useOrdersStore.setState({
    phase: 'idle', ticket: null, reviewKey: null, reviewOut: null, outcome: null, outcomeAt: null, error: '', actionNote: '',
    approvals: [], approvalsError: '', approvalsAccount: null, approvalSetting: {}, settingError: '', cancelling: {}, declined: {},
  })

beforeEach(async () => {
  fake.reset()
  fakeRh.accounts = [acct({ account_number: 'MAIN0001', is_default: true }), acct({ account_number: AGENTIC, agentic_allowed: true })]
  fakeRh.last = { AAA: 101 }
  useRhStore.setState({ status: null, connecting: false, connectError: '', accounts: [], account: null, orders: [], quotes: {} })
  fresh()
  await useRhStore.getState().connect()
})
afterEach(() => {
  useRhStore.getState().watchQuotes('positions', [])
  useRhStore.getState().watchQuotes('watchlist', [])
  vi.restoreAllMocks()
})
const S = () => useOrdersStore.getState()

describe('F2 unknown stays unknown', () => {
  it('records when the unknown outcome arrived', async () => {
    fakeRh.failPlace = 1
    await S().review(eqTicket())
    await S().place()
    expect(S().phase).toBe('unknown')
    expect(S().outcomeAt).toBeGreaterThan(0)
    expect(S().outcome).toMatchObject({ kind: 'unknown' })
    expect((S().outcome as { retry_until?: number }).retry_until).toBeGreaterThan(Date.now() / 1000)
  })
  it('a thrown error on retry keeps phase unknown and keeps the outcome', async () => {
    fakeRh.failPlace = 1
    await S().review(eqTicket())
    await S().place()
    fakeRh.connected = false // retry now throws "not connected"
    await S().retrySameRef()
    expect(S().phase).toBe('unknown')
    expect(S().outcome?.kind).toBe('unknown')
    expect(S().actionNote).toMatch(/not connected/)
  })
  it('refuses a retry after retry_until without calling the backend', async () => {
    const spy = vi.spyOn(api, 'rhPlaceOrder').mockResolvedValue({ kind: 'unknown', message: 'x', retry_until: Math.floor(Date.now() / 1000) - 5 })
    await S().review(eqTicket())
    await S().place()
    expect(S().phase).toBe('unknown')
    await S().retrySameRef()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(S().phase).toBe('unknown')
    expect(S().actionNote).toMatch(/review again/i)
  })
  it('dismiss needs a successful orders reload for the ticket account', async () => {
    fakeRh.failPlace = 1
    await S().review(eqTicket())
    await S().place()
    await useRhStore.getState().selectAccount('MAIN0001')
    fakeRh.connected = false
    expect(await S().dismissUnknown()).toBe(false)
    expect(S().phase).toBe('unknown')
    expect(S().actionNote).toMatch(/not dismissed/i)
    fakeRh.connected = true
    fakeRh.orderCalls = []
    expect(await S().dismissUnknown()).toBe(true)
    expect(S().phase).toBe('idle')
    expect(useRhStore.getState().account).toBe(AGENTIC)
    expect(fakeRh.orderCalls.some((c) => c.account === AGENTIC)).toBe(true)
  })
})

describe('F2 awaiting approval blocks a repeat review', () => {
  it('same ticket is refused, a changed ticket goes through', async () => {
    await S().review(eqTicket())
    await S().place()
    expect(S().phase).toBe('awaitingApproval')
    await S().review(eqTicket())
    expect(S().phase).toBe('awaitingApproval')
    expect(S().error).toMatch(/approval/i)
    expect(fakeRh.reviews.size).toBe(1)
    await S().review(eqTicket({ quantity: '2' }))
    expect(S().phase).toBe('reviewed')
  })
})

describe('F1 option leg lookup gates Place', () => {
  it('a leg that is not in the loaded chain disables Place with the reason', async () => {
    const t: Ticket = { kind: 'option', args: opArgs(), legs: [{ option_id: UUID, label: null }] }
    expect(placeBlockedReason(t)).toMatch(/not in the loaded chain/i)
    expect(placeBlockedReason({ kind: 'option', args: opArgs(), legs: [{ option_id: UUID, label: 'AAPL 2026-11-20 150 call' }] })).toBeNull()
    expect(placeBlockedReason({ kind: 'option', args: opArgs() })).toBeNull()
    expect(placeBlockedReason(eqTicket())).toBeNull()
    await S().review(t)
    expect(S().phase).toBe('reviewed')
    await S().place()
    expect(fakeRh.placeLog).toHaveLength(0)
    expect(S().phase).toBe('reviewed')
    expect(S().error).toMatch(/not in the loaded chain/i)
  })
})

describe('F3 refresh after place', () => {
  it('a placed order re-reads orders and positions', async () => {
    fakeRh.approvalsOn = false
    const pos = vi.spyOn(api, 'rhPositions')
    await S().review(eqTicket())
    await S().place()
    expect(S().phase).toBe('placed')
    expect(pos).toHaveBeenCalled()
  })
})
