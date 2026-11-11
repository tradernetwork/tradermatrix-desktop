import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeRh, type EquityOrderArgs, type OptionOrderArgs, type RhAccount, type RhOrder } from '../src/lib/api'
import { placeAllowed, retryAllowed, ticketKey, useOrdersStore, type Ticket } from '../src/stores/orders'
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
const opArgs = (o: Partial<OptionOrderArgs> = {}): OptionOrderArgs => ({
  account_number: AGENTIC, legs: [{ option_id: UUID, side: 'buy', position_effect: 'open', ratio_quantity: 1 }], quantity: '1', type: 'limit', price: '1.50', time_in_force: 'gfd', market_hours: 'regular_hours', ...o,
})

function order(id: string, state: string, asset = 'equity'): RhOrder {
  return {
    id, asset, symbol: 'AAA', side: 'buy', order_type: 'limit', state, trigger: null, quantity: 1, price: 90, stop_price: null,
    average_price: null, dollar_based_amount: null, time_in_force: 'gfd', created_at: null, reject_reason: null, legs: [],
  }
}

const fresh = () =>
  useOrdersStore.setState({
    phase: 'idle', ticket: null, reviewKey: null, reviewOut: null, outcome: null, error: '', actionNote: '',
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

describe('review', () => {
  it('idle -> reviewing -> reviewed with the masked account and approval flag', async () => {
    const seen: string[] = []
    const unsub = useOrdersStore.subscribe((s) => seen.push(s.phase))
    await S().review(eqTicket())
    unsub()
    expect(seen).toContain('reviewing')
    expect(S().phase).toBe('reviewed')
    expect(S().reviewOut?.account_masked).toBe('••••0002')
    expect(S().reviewOut?.customer_approval_required).toBe(true)
    expect(S().reviewOut?.order_checks).toEqual({})
    expect(S().error).toBe('')
  })

  it('a refused review (validation, non agentic account) stays idle with the message and no server state', async () => {
    await S().review(eqTicket({ quantity: '-1' }))
    expect(S().phase).toBe('idle')
    expect(S().error).toMatch(/quantity/)
    await S().review(eqTicket({ account_number: 'MAIN0001' }))
    expect(S().phase).toBe('idle')
    expect(S().error).toMatch(/agentic/)
    expect(fakeRh.placeLog).toHaveLength(0)
  })

  it('alert injection fills order_checks', async () => {
    fakeRh.alert = true
    await S().review(eqTicket())
    expect(Object.keys(S().reviewOut!.order_checks).length).toBeGreaterThan(0)
  })

  it('option review works the same way', async () => {
    await S().review({ kind: 'option', args: opArgs() })
    expect(S().phase).toBe('reviewed')
    expect(S().reviewOut?.kind).toBe('option')
  })

  it('a stale review result is dropped when the ticket changes while reviewing', async () => {
    const p = S().review(eqTicket())
    expect(S().phase).toBe('reviewing')
    S().ticketEdited(ticketKey(eqTicket({ quantity: '2' })))
    await p
    expect(S().phase).toBe('idle')
    expect(S().reviewOut).toBeNull()
  })
})

describe('editing a field after a review discards it', () => {
  it('different key -> idle and place is impossible', async () => {
    await S().review(eqTicket())
    S().ticketEdited(ticketKey(eqTicket()))
    expect(S().phase).toBe('reviewed')
    S().ticketEdited(ticketKey(eqTicket({ limit_price: '91' })))
    expect(S().phase).toBe('idle')
    expect(S().reviewOut).toBeNull()
    await S().place()
    expect(fakeRh.placeLog).toHaveLength(0)
  })
  it('does not touch an order that is being placed or already finished', async () => {
    fakeRh.approvalsOn = false
    await S().review(eqTicket())
    const p = S().place()
    S().ticketEdited('other')
    expect(S().phase).toBe('placing')
    await p
    expect(S().phase).toBe('placed')
    S().ticketEdited('other-again')
    expect(S().phase).toBe('placed')
  })
})

describe('place', () => {
  it('approvals OFF -> placing -> placed, one request, orders re-read', async () => {
    fakeRh.approvalsOn = false
    await S().review(eqTicket())
    const seen: string[] = []
    const unsub = useOrdersStore.subscribe((s) => seen.push(s.phase))
    await S().place()
    unsub()
    expect(seen).toContain('placing')
    expect(S().phase).toBe('placed')
    expect(S().outcome?.kind).toBe('placed')
    expect(fakeRh.placeLog).toHaveLength(1)
    expect(useRhStore.getState().orders.some((o) => o.state === 'queued')).toBe(true)
  })

  it('place is disabled while placing: a double click sends exactly one request', async () => {
    fakeRh.approvalsOn = false
    await S().review(eqTicket())
    expect(placeAllowed('reviewed')).toBe(true)
    const a = S().place()
    expect(placeAllowed(S().phase)).toBe(false)
    const b = S().place()
    await Promise.all([a, b])
    expect(fakeRh.placeLog).toHaveLength(1)
    expect(S().phase).toBe('placed')
  })

  it('approvals ON -> awaitingApproval; nothing placed, no resubmit offered', async () => {
    fakeRh.approvalsOn = true
    await S().review(eqTicket())
    await S().place()
    expect(S().phase).toBe('awaitingApproval')
    expect(S().outcome?.kind).toBe('awaiting_approval')
    expect(placeAllowed('awaitingApproval')).toBe(false)
    expect(retryAllowed('awaitingApproval')).toBe(false)
    await S().place()
    await S().retrySameRef()
    expect(fakeRh.placeLog).toHaveLength(1)
    expect((fakeRh.orders[AGENTIC] ?? []).length).toBe(0)
    expect(S().approvals).toHaveLength(1)
  })

  it('a server rejection is shown verbatim and the order is not placed', async () => {
    fakeRh.rejectPlace = 'tool error: insufficient buying power'
    await S().review(eqTicket())
    await S().place()
    expect(S().phase).toBe('rejected')
    expect(S().outcome).toEqual({ kind: 'rejected', message: 'tool error: insufficient buying power' })
    expect(placeAllowed('rejected')).toBe(false)
  })

  it('place without a review does nothing', async () => {
    await S().place()
    expect(S().phase).toBe('idle')
    expect(fakeRh.placeLog).toHaveLength(0)
  })

  it('an unknown review id (e.g. expired) lands in rejected with the message, nothing sent', async () => {
    await S().review(eqTicket())
    useOrdersStore.setState({ reviewOut: { ...S().reviewOut!, review_id: 'nope' } })
    await S().place()
    expect(S().phase).toBe('rejected')
    expect(S().outcome).toMatchObject({ kind: 'rejected' })
    expect(fakeRh.placeLog).toHaveLength(0)
  })
})

describe('unknown outcome', () => {
  it('offers retry with the SAME review id and ref id, and a new review mints a new ref', async () => {
    fakeRh.approvalsOn = false
    fakeRh.failPlace = 1
    await S().review(eqTicket())
    const reviewId = S().reviewOut!.review_id
    await S().place()
    expect(S().phase).toBe('unknown')
    expect(S().outcome?.kind).toBe('unknown')
    expect(retryAllowed('unknown')).toBe(true)
    expect(placeAllowed('unknown')).toBe(false)
    await S().place() // plain place is not the retry path
    expect(fakeRh.placeLog).toHaveLength(1)
    await S().retrySameRef()
    expect(S().phase).toBe('placed')
    expect(fakeRh.placeLog).toHaveLength(2)
    expect(fakeRh.placeLog[1]!.reviewId).toBe(reviewId)
    expect(fakeRh.placeLog[1]!.refId).toBe(fakeRh.placeLog[0]!.refId)
    S().reset()
    await S().review(eqTicket())
    await S().place()
    expect(fakeRh.placeLog[2]!.refId).not.toBe(fakeRh.placeLog[0]!.refId)
  })

  it('a new review is refused while unknown (it would mint a new ref and could double place)', async () => {
    fakeRh.failPlace = 1
    await S().review(eqTicket())
    await S().place()
    expect(S().phase).toBe('unknown')
    await S().review(eqTicket({ quantity: '2' }))
    expect(S().phase).toBe('unknown')
    expect(S().error).toMatch(/orders|retry|dismiss/i)
    expect(fakeRh.reviews.size).toBe(1)
  })

  it('retrying twice fast sends one request', async () => {
    fakeRh.approvalsOn = false
    fakeRh.failPlace = 1
    await S().review(eqTicket())
    await S().place()
    await Promise.all([S().retrySameRef(), S().retrySameRef()])
    expect(fakeRh.placeLog).toHaveLength(2)
  })
})

describe('reset', () => {
  it('goes back to idle and clears everything', async () => {
    await S().review(eqTicket())
    S().reset()
    expect(S().phase).toBe('idle')
    expect(S().reviewOut).toBeNull()
    expect(S().outcome).toBeNull()
    expect(S().error).toBe('')
  })
})

describe('cancel', () => {
  const OID = '33333333-4444-4555-8666-777777777777'
  const OID2 = '44444444-5555-4666-8777-888888888888'
  it('cancels an equity order and re-reads orders (cancel returns only accepted)', async () => {
    fakeRh.orders[AGENTIC] = [order(OID, 'queued')]
    await useRhStore.getState().loadOrders()
    const spy = vi.spyOn(api, 'rhCancelEquityOrder')
    const before = fakeRh.orderCalls.length
    await S().cancelOrder(useRhStore.getState().orders[0]!)
    expect(spy).toHaveBeenCalledWith(AGENTIC, OID)
    expect(fakeRh.orderCalls.length).toBeGreaterThan(before)
    expect(useRhStore.getState().orders[0]!.state).toBe('cancelled')
    expect(S().cancelling).toEqual({})
  })
  it('option orders use the option cancel', async () => {
    fakeRh.orders[AGENTIC] = [order(OID2, 'queued', 'option')]
    await useRhStore.getState().loadOrders()
    const spy = vi.spyOn(api, 'rhCancelOptionOrder')
    await S().cancelOrder(useRhStore.getState().orders[0]!)
    expect(spy).toHaveBeenCalledWith(AGENTIC, OID2)
  })
  it('a double click sends one cancel', async () => {
    fakeRh.orders[AGENTIC] = [order(OID, 'queued')]
    await useRhStore.getState().loadOrders()
    const spy = vi.spyOn(api, 'rhCancelEquityOrder')
    const o = useRhStore.getState().orders[0]!
    await Promise.all([S().cancelOrder(o), S().cancelOrder(o)])
    expect(spy).toHaveBeenCalledTimes(1)
  })
  it('a failed cancel is reported and orders are still re-read', async () => {
    fakeRh.orders[AGENTIC] = [order(OID, 'queued')]
    await useRhStore.getState().loadOrders()
    vi.spyOn(api, 'rhCancelEquityOrder').mockRejectedValue(new Error('tool error: already filled'))
    await S().cancelOrder(useRhStore.getState().orders[0]!)
    expect(S().actionNote).toMatch(/already filled/)
    expect(S().cancelling).toEqual({})
  })
  it('does nothing for a non cancelable order', async () => {
    const spy = vi.spyOn(api, 'rhCancelEquityOrder')
    await S().cancelOrder(order(OID, 'filled'))
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('approvals', () => {
  it('lists pending approvals and decline withdraws one', async () => {
    fakeRh.approvalsOn = true
    await S().review(eqTicket())
    await S().place()
    await S().refreshApprovals(AGENTIC)
    expect(S().approvals).toHaveLength(1)
    const id = S().approvals[0]!.approval_id
    await S().declineApproval(AGENTIC, id)
    expect(S().declined[id]).toBe(true)
    expect(S().approvals).toHaveLength(0)
  })
  it('a failed decline is reported', async () => {
    vi.spyOn(api, 'rhDeclineTradeApproval').mockRejectedValue(new Error('tool error: not pending'))
    await S().declineApproval(AGENTIC, 'appr-x')
    expect(S().actionNote).toMatch(/not pending/)
  })
  it('loads the per-account approvals setting (ON/OFF)', async () => {
    fakeRh.approvalsOn = true
    await S().loadApprovalSetting(AGENTIC)
    expect(S().approvalSetting[AGENTIC]).toBe(true)
    fakeRh.approvalsOn = false
    await S().loadApprovalSetting(AGENTIC)
    expect(S().approvalSetting[AGENTIC]).toBe(false)
  })
  it('a failed setting read leaves it unknown and records the message', async () => {
    vi.spyOn(api, 'rhTradeApprovalSetting').mockRejectedValue(new Error('boom'))
    await S().loadApprovalSetting(AGENTIC)
    expect(S().approvalSetting[AGENTIC]).toBeNull()
    expect(S().settingError).toMatch(/boom/)
  })
})

describe('clearFinished (tab switch)', () => {
  it('clears a placed or rejected result card but never an approval or an unconfirmed order', () => {
    const st = useOrdersStore
    st.setState({ phase: 'placed', outcome: { kind: 'placed', order: {} } as never })
    st.getState().clearFinished()
    expect(st.getState().phase).toBe('idle')
    st.setState({ phase: 'rejected', outcome: { kind: 'rejected', message: 'x' } as never })
    st.getState().clearFinished()
    expect(st.getState().phase).toBe('idle')
    for (const phase of ['unknown', 'awaitingApproval', 'placing', 'reviewed'] as const) {
      st.setState({ phase })
      st.getState().clearFinished()
      expect(st.getState().phase).toBe(phase)
    }
    st.getState().reset()
  })
})
