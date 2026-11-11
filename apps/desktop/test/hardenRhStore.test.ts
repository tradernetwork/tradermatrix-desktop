import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeRh, type RhAccount, type RhOrder } from '../src/lib/api'
import { isEquitySymbol, useRhStore } from '../src/stores/rh'

const acct = (n: string): RhAccount => ({
  account_number: n, rhs_account_number: null, rhc_account_number: null, agentic_allowed: true, option_level: null,
  kind: 'margin', is_default: true, unsettled_funds: null, nickname: null, brokerage_account_type: null,
})
const order = (id: string): RhOrder => ({
  id, asset: 'equity', symbol: 'AAA', side: 'buy', order_type: 'limit', state: 'queued', trigger: 'immediate', quantity: 1, price: 1, stop_price: null,
  average_price: null, dollar_based_amount: null, time_in_force: 'gfd', created_at: null, reject_reason: null, legs: [],
})

beforeEach(async () => {
  fake.reset()
  fakeRh.accounts = [acct('ACCT0001')]
  useRhStore.getState().wipe()
  useRhStore.setState({ status: null, connecting: false, connectError: '' })
})
afterEach(() => vi.restoreAllMocks())

describe('F7 isEquitySymbol needs an instrument', () => {
  it('rejects anything that is not object_type instrument', () => {
    expect(isEquitySymbol({ symbol: 'AAA', object_type: 'instrument' })).toBe(true)
    expect(isEquitySymbol({ symbol: 'AAA', object_type: 'option' })).toBe(false)
    expect(isEquitySymbol({ symbol: 'AAA', object_type: '' })).toBe(false)
    expect(isEquitySymbol({ symbol: 'BTC/USD', object_type: 'instrument' })).toBe(false)
  })
})

describe('F3 loadOrders sequencing and result', () => {
  it('a slow older response never overwrites a newer one', async () => {
    useRhStore.setState({ account: 'ACCT0001' })
    let slow: (v: RhOrder[]) => void = () => undefined
    const spy = vi.spyOn(api, 'rhOrders')
    spy.mockImplementationOnce(() => new Promise((r) => (slow = r)))
    spy.mockImplementationOnce(async () => [order('new')])
    const first = useRhStore.getState().loadOrders()
    const second = useRhStore.getState().loadOrders()
    await second
    slow([order('old')])
    await first
    expect(useRhStore.getState().orders.map((o) => o.id)).toEqual(['new'])
  })
  it('returns true on success and false on failure', async () => {
    useRhStore.setState({ account: 'ACCT0001' })
    fakeRh.connected = true
    expect(await useRhStore.getState().loadOrders()).toBe(true)
    fakeRh.connected = false
    expect(await useRhStore.getState().loadOrders()).toBe(false)
    expect(useRhStore.getState().ordersError).toMatch(/not connected/)
  })
  it('can target an account other than the selected one', async () => {
    fakeRh.connected = true
    useRhStore.setState({ account: 'ACCT0001' })
    fakeRh.orderCalls = []
    await useRhStore.getState().loadOrders('ACCT0001')
    expect(fakeRh.orderCalls).toHaveLength(1)
  })
})

describe('F5 wipe', () => {
  it('clears data and drops an in-flight account load', async () => {
    let release: (v: RhAccount[]) => void = () => undefined
    fakeRh.connected = true
    vi.spyOn(api, 'rhAccounts').mockImplementationOnce(() => new Promise((r) => (release = r)))
    const p = useRhStore.getState().loadAccounts()
    useRhStore.getState().wipe()
    release([acct('LATE0001')])
    await p
    expect(useRhStore.getState().accounts).toEqual([])
    expect(useRhStore.getState().account).toBeNull()
  })
  it('wipe stops polling', async () => {
    vi.useFakeTimers()
    fakeRh.connected = true
    useRhStore.getState().watchQuotes('x', ['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    useRhStore.getState().wipe()
    fakeRh.quoteCalls = []
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fakeRh.quoteCalls).toEqual([])
    expect(useRhStore.getState().quotes).toEqual({})
    vi.useRealTimers()
  })
})

describe('F7 truncation note', () => {
  it('flags when more than 200 symbols are wanted', () => {
    const many = Array.from({ length: 230 }, (_, i) => `S${i}`)
    useRhStore.getState().watchQuotes('watchlist', many)
    expect(useRhStore.getState().quotesTruncated).toBe(true)
    useRhStore.getState().watchQuotes('watchlist', ['AAA'])
    expect(useRhStore.getState().quotesTruncated).toBe(false)
    useRhStore.getState().watchQuotes('watchlist', [])
  })
})
