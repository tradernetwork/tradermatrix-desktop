import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeRh, type RhAccount, type RhOrder } from '../src/lib/api'
import type { EquityIntent, TicketIntent } from '../src/lib/ticketIntent'
import { useOrdersStore } from '../src/stores/orders'
import { useRhStore } from '../src/stores/rh'
import { wipeSession } from '../src/stores/session'
import { INTENT_TTL_MS, cancelAndEdit, fillTicket, useTicketIntentStore } from '../src/stores/ticketIntent'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'SYN00000001', rhs_account_number: null, rhc_account_number: null, agentic_allowed: false, option_level: null,
  kind: 'margin', is_default: false, unsettled_funds: null, nickname: null, brokerage_account_type: null, ...o,
})
const AGENTIC = 'AGEN0002'
const OID = '11111111-2222-4333-8444-555555555555'
const OID2 = '11111111-2222-4333-8444-555555555556'

const order = (id: string, state: string, o: Partial<RhOrder> = {}): RhOrder => ({
  id, asset: 'equity', symbol: 'MSFT', side: 'sell', order_type: 'limit', state, trigger: 'immediate', quantity: 4, price: 310.5, stop_price: null,
  average_price: null, dollar_based_amount: null, time_in_force: 'gtc', created_at: null, reject_reason: null, legs: [], ...o,
})
const eq = (o: Partial<EquityIntent> = {}): TicketIntent => ({ kind: 'equity', symbol: 'AAA', source: 'test', ...o })

beforeEach(async () => {
  fake.reset()
  fakeRh.accounts = [acct({ account_number: 'MAIN0001', is_default: true }), acct({ account_number: AGENTIC, agentic_allowed: true })]
  useRhStore.setState({ status: null, connecting: false, connectError: '', accounts: [], account: null, orders: [], quotes: {} })
  useOrdersStore.setState({
    phase: 'idle', ticket: null, reviewKey: null, reviewOut: null, outcome: null, error: '', actionNote: '', cancelling: {},
  })
  useTicketIntentStore.setState({ pending: null, at: 0, seq: 0 })
  await useRhStore.getState().connect()
})
afterEach(() => {
  useRhStore.getState().watchQuotes('positions', [])
  useRhStore.getState().watchQuotes('watchlist', [])
  vi.restoreAllMocks()
})

describe('fillTicket', () => {
  it('queues the intent once and bumps seq', () => {
    expect(fillTicket(eq({ side: 'sell', quantity: '5' }))).toBe(true)
    expect(useTicketIntentStore.getState().seq).toBe(1)
    expect(useTicketIntentStore.getState().take()).toMatchObject({ symbol: 'AAA', side: 'sell', quantity: '5' })
    expect(useTicketIntentStore.getState().take()).toBeNull()
  })
  it('an intent older than the TTL is dropped on take (never applied minutes later)', () => {
    fillTicket(eq())
    const at = useTicketIntentStore.getState().at
    expect(useTicketIntentStore.getState().take(at + INTENT_TTL_MS + 1)).toBeNull()
    fillTicket(eq())
    expect(useTicketIntentStore.getState().take(useTicketIntentStore.getState().at + 1000)).not.toBeNull()
  })
  it('refuses a bad symbol (equity and option underlying) and queues nothing', () => {
    expect(fillTicket(eq({ symbol: 'bad symbol' }))).toBe(false)
    expect(fillTicket({ kind: 'option', underlying: '', optionId: 'x', side: 'sell', effect: 'close', quantity: '1', source: 't' })).toBe(false)
    expect(useTicketIntentStore.getState().pending).toBeNull()
    expect(useTicketIntentStore.getState().seq).toBe(0)
  })
  it('a fill discards an open review (reviewed and reviewing) through the edit path', () => {
    useOrdersStore.setState({ phase: 'reviewed', reviewKey: 'K', ticket: { kind: 'equity', args: { account_number: AGENTIC, symbol: 'AAA', side: 'buy', type: 'market', quantity: '1' } } })
    fillTicket(eq())
    expect(useOrdersStore.getState().phase).toBe('idle')
    expect(useOrdersStore.getState().reviewKey).toBeNull()
    useOrdersStore.setState({ phase: 'reviewing', reviewKey: 'K' })
    fillTicket(eq())
    expect(useOrdersStore.getState().phase).toBe('idle')
  })
  it('a fill never disturbs an unconfirmed or approval-pending order, and clears a finished card', () => {
    for (const phase of ['unknown', 'awaitingApproval', 'placing'] as const) {
      useOrdersStore.setState({ phase, reviewKey: 'K' })
      fillTicket(eq())
      expect(useOrdersStore.getState().phase, phase).toBe(phase)
    }
    useOrdersStore.setState({ phase: 'placed', reviewKey: 'K' })
    fillTicket(eq())
    expect(useOrdersStore.getState().phase).toBe('idle')
  })
  it('never reviews, places or cancels anything', async () => {
    const review = vi.spyOn(api, 'rhReviewEquityOrder')
    const reviewO = vi.spyOn(api, 'rhReviewOptionOrder')
    const place = vi.spyOn(api, 'rhPlaceOrder')
    const cancel = vi.spyOn(api, 'rhCancelEquityOrder')
    const cancelO = vi.spyOn(api, 'rhCancelOptionOrder')
    fillTicket(eq({ side: 'sell', quantity: '1', orderType: 'market' }))
    fillTicket({ kind: 'option', underlying: 'AAA', optionId: OID, side: 'sell', effect: 'close', quantity: '1', source: 't' })
    for (const s of [review, reviewO, place, cancel, cancelO]) expect(s).not.toHaveBeenCalled()
    expect(fakeRh.placeLog).toEqual([])
  })
  it('a session wipe drops a queued fill', () => {
    fillTicket(eq())
    wipeSession()
    expect(useTicketIntentStore.getState().pending).toBeNull()
  })
})

describe('cancelAndEdit', () => {
  it('cancels through the existing flow and ONLY then fills the ticket from the order', async () => {
    fakeRh.orders[AGENTIC] = [order(OID, 'queued')]
    await useRhStore.getState().loadOrders()
    const cancel = vi.spyOn(api, 'rhCancelEquityOrder')
    const ok = await cancelAndEdit(useRhStore.getState().orders[0]!)
    expect(ok).toBe(true)
    expect(cancel).toHaveBeenCalledWith(AGENTIC, OID)
    expect(useTicketIntentStore.getState().pending).toEqual({
      kind: 'equity', symbol: 'MSFT', side: 'sell', orderType: 'limit', quantity: '4', limit: '310.50', source: 'edit',
    })
    expect(fakeRh.orders[AGENTIC]![0]!.state).toBe('cancelled')
  })
  it('the fill happens after the cancel resolves, not before', async () => {
    fakeRh.orders[AGENTIC] = [order(OID, 'queued')]
    await useRhStore.getState().loadOrders()
    let release: (v: boolean) => void = () => undefined
    vi.spyOn(api, 'rhCancelEquityOrder').mockReturnValue(new Promise<boolean>((r) => (release = r)))
    const p = cancelAndEdit(useRhStore.getState().orders[0]!)
    await Promise.resolve()
    expect(useTicketIntentStore.getState().pending).toBeNull()
    release(true)
    await p
    expect(useTicketIntentStore.getState().pending).not.toBeNull()
  })
  it('a failed or refused cancel fills nothing', async () => {
    fakeRh.orders[AGENTIC] = [order(OID, 'queued')]
    await useRhStore.getState().loadOrders()
    const o = useRhStore.getState().orders[0]!
    vi.spyOn(api, 'rhCancelEquityOrder').mockRejectedValueOnce(new Error('tool error: already filled'))
    expect(await cancelAndEdit(o)).toBe(false)
    expect(useTicketIntentStore.getState().pending).toBeNull()
    expect(useOrdersStore.getState().actionNote).toMatch(/already filled/)
    vi.spyOn(api, 'rhCancelEquityOrder').mockResolvedValueOnce(false)
    expect(await cancelAndEdit(o)).toBe(false)
    expect(useTicketIntentStore.getState().pending).toBeNull()
  })
  it('a non-cancelable (filled) order is neither cancelled nor filled', async () => {
    const cancel = vi.spyOn(api, 'rhCancelEquityOrder')
    expect(await cancelAndEdit(order(OID, 'filled'))).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    expect(useTicketIntentStore.getState().pending).toBeNull()
  })
  it('an order that cannot be rebuilt on the ticket (multi-leg) is not cancelled at all', async () => {
    const cancelO = vi.spyOn(api, 'rhCancelOptionOrder')
    const leg = { option_id: 'a', side: 'buy', position_effect: 'open', ratio_quantity: 1, expiration_date: null, strike_price: null, option_type: null }
    fakeRh.orders[AGENTIC] = [order(OID2, 'queued', { asset: 'option', symbol: 'AAA', legs: [leg, { ...leg, option_id: 'b' }] })]
    await useRhStore.getState().loadOrders()
    expect(await cancelAndEdit(useRhStore.getState().orders[0]!)).toBe(false)
    expect(cancelO).not.toHaveBeenCalled()
    expect(useOrdersStore.getState().actionNote).toMatch(/cannot be edited/)
  })
  it('never places or reviews, and the plain cancelOrder still reports its result', async () => {
    fakeRh.orders[AGENTIC] = [order(OID, 'queued')]
    await useRhStore.getState().loadOrders()
    const place = vi.spyOn(api, 'rhPlaceOrder')
    const review = vi.spyOn(api, 'rhReviewEquityOrder')
    expect(await useOrdersStore.getState().cancelOrder(useRhStore.getState().orders[0]!)).toBe(true)
    await cancelAndEdit(order(OID2, 'filled'))
    expect(place).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
  })
})
