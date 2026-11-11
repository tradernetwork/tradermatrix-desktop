import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeRh, type RhAccount } from '../src/lib/api'
import * as clipboard from '../src/lib/clipboard'
import { connectState, isEquitySymbol, useRhStore } from '../src/stores/rh'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'SYN00000001',
  rhs_account_number: null,
  rhc_account_number: null,
  agentic_allowed: false,
  option_level: null,
  kind: 'margin',
  is_default: false,
  unsettled_funds: null,
  nickname: null,
  brokerage_account_type: null,
  ...o,
})

function seed() {
  fakeRh.accounts = [acct({ account_number: 'MAIN0001', is_default: true }), acct({ account_number: 'AGEN0002', agentic_allowed: true, kind: 'limited_margin' })]
  fakeRh.portfolios = { AGEN0002: { total_value: 5000, equity_value: 4000, options_value: 0, cash: 1000, buying_power: 2000, currency: 'USD' } }
  fakeRh.positions = {
    AGEN0002: [
      { symbol: 'AAA', quantity: 10, average_buy_price: 100, shares_available_for_sells: 10, shares_held_for_sells: 0 },
      { symbol: 'BBB', quantity: 2, average_buy_price: null, shares_available_for_sells: null, shares_held_for_sells: null },
    ],
    MAIN0001: [{ symbol: 'ZZZ', quantity: 1, average_buy_price: 1, shares_available_for_sells: null, shares_held_for_sells: null }],
  }
  fakeRh.watchlists = [
    { id: 'wl-1', display_name: 'First', icon_emoji: null, item_count: 3, owner_type: null, allowed_object_types: ['instrument'] },
    { id: 'wl-2', display_name: 'Second', icon_emoji: null, item_count: 0, owner_type: null, allowed_object_types: ['instrument'] },
  ]
  fakeRh.items = {
    'wl-1': [
      { object_id: '1', object_type: 'instrument', symbol: 'AAA' },
      { object_id: '2', object_type: 'currency_pair', symbol: 'BTC-USD' },
      { object_id: '3', object_type: 'instrument', symbol: 'BRK.B' },
    ],
  }
  fakeRh.optionItems = [
    { id: 'o1', name: 'AAA call', option_ids: ['x'], chain_symbol: 'AAA', expiration_date: '2026-12-18', strike_price: 150, contract_type: 'call' },
    { id: 'o2', name: 'BBB put', option_ids: [], chain_symbol: 'BBB', expiration_date: null, strike_price: null, contract_type: 'put' },
  ]
  fakeRh.last = { AAA: 101 }
}

const reset = () =>
  useRhStore.setState({
    status: null,
    connecting: false,
    connectError: '',
    accounts: [],
    account: null,
    portfolio: null,
    positions: [],
    positionsError: '',
    positionsLoading: false,
    orders: [],
    orderState: '',
    ordersError: '',
    watchlists: [],
    listId: null,
    listSymbols: [],
    optionItems: [],
    watchError: '',
    quotes: {},
    quoteError: '',
  })

beforeEach(() => {
  fake.reset()
  reset()
  seed()
})
afterEach(() => {
  useRhStore.getState().watchQuotes('positions', [])
  useRhStore.getState().watchQuotes('watchlist', [])
})

describe('connect state machine', () => {
  it('maps status to the four button states', () => {
    const base = { status: null, connecting: false, connectError: '' }
    expect(connectState(base)).toBe('disconnected')
    expect(connectState({ ...base, status: { connected: false, expires_soon: false, last_error: null } })).toBe('disconnected')
    expect(connectState({ ...base, connecting: true })).toBe('connecting')
    expect(connectState({ ...base, status: { connected: true, expires_soon: false, last_error: null } })).toBe('connected')
    expect(connectState({ ...base, connectError: 'boom' })).toBe('error')
    expect(connectState({ ...base, connecting: true, connectError: 'old' })).toBe('connecting')
  })

  it('disconnected -> connecting -> connected, then loads accounts and watchlists', async () => {
    await useRhStore.getState().refreshStatus()
    expect(connectState(useRhStore.getState())).toBe('disconnected')
    const seen: string[] = []
    const unsub = useRhStore.subscribe((s) => seen.push(connectState(s)))
    await useRhStore.getState().connect()
    unsub()
    expect(seen).toContain('connecting')
    expect(connectState(useRhStore.getState())).toBe('connected')
    expect(useRhStore.getState().accounts).toHaveLength(2)
    expect(useRhStore.getState().watchlists).toHaveLength(2)
  })

  it('a failed login lands in error with the message, and can retry', async () => {
    fakeRh.connectError = 'protocol error: login timed out waiting for the browser'
    await useRhStore.getState().connect()
    const s = useRhStore.getState()
    expect(connectState(s)).toBe('error')
    expect(s.connectError).toMatch(/timed out/)
    expect(s.connecting).toBe(false)
    fakeRh.connectError = null
    await useRhStore.getState().connect()
    expect(connectState(useRhStore.getState())).toBe('connected')
    expect(useRhStore.getState().connectError).toBe('')
  })

  it('ignores a second connect click while one is in flight', async () => {
    const spy = vi.spyOn(api, 'rhConnect')
    const a = useRhStore.getState().connect()
    const b = useRhStore.getState().connect()
    await Promise.all([a, b])
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('disconnect clears all Robinhood data', async () => {
    await useRhStore.getState().connect()
    expect(useRhStore.getState().positions.length).toBeGreaterThan(0)
    await useRhStore.getState().disconnect()
    const s = useRhStore.getState()
    expect(connectState(s)).toBe('disconnected')
    expect(s.accounts).toEqual([])
    expect(s.positions).toEqual([])
    expect(s.quotes).toEqual({})
    expect(fakeRh.connected).toBe(false)
  })
})

describe('copy login link', () => {
  it('copies the pending login URL and says so', async () => {
    const url = vi.spyOn(api, 'rhPendingLoginUrl').mockResolvedValue('https://robinhood.com/oauth?state=abc')
    const clip = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true)
    await useRhStore.getState().copyLoginLink()
    expect(clip).toHaveBeenCalledWith('https://robinhood.com/oauth?state=abc')
    expect(useRhStore.getState().loginLinkNote).toBe('Login link copied. Paste it into any browser.')
    expect(useRhStore.getState().loginLinkFallback).toBe('')
    url.mockRestore(); clip.mockRestore()
  })
  it('shows the URL itself when the clipboard is unavailable', async () => {
    const url = vi.spyOn(api, 'rhPendingLoginUrl').mockResolvedValue('https://robinhood.com/oauth?state=abc')
    const clip = vi.spyOn(clipboard, 'copyText').mockResolvedValue(false)
    await useRhStore.getState().copyLoginLink()
    expect(useRhStore.getState().loginLinkFallback).toBe('https://robinhood.com/oauth?state=abc')
    url.mockRestore(); clip.mockRestore()
  })
  it('says so when no login is in progress', async () => {
    const url = vi.spyOn(api, 'rhPendingLoginUrl').mockResolvedValue(null)
    await useRhStore.getState().copyLoginLink()
    expect(useRhStore.getState().loginLinkNote).toBe('No login in progress.')
    url.mockRestore()
  })
})

describe('tool list capture', () => {
  it('records the saved path and count, and surfaces failures as text', async () => {
    const ok = vi.spyOn(api, 'rhCaptureTools').mockResolvedValue({ path: '/tmp/x/robinhood-tools-2026-11-10.json', count: 91, names: ['get_accounts'] })
    await useRhStore.getState().captureTools()
    expect(useRhStore.getState().captureNote).toBe('Saved 91 tools to /tmp/x/robinhood-tools-2026-11-10.json')
    ok.mockRestore()
    const bad = vi.spyOn(api, 'rhCaptureTools').mockRejectedValue(new Error('not connected'))
    await useRhStore.getState().captureTools()
    expect(useRhStore.getState().captureNote).toBe('Capture failed: not connected')
    bad.mockRestore()
  })
})

describe('positions pane data', () => {
  it('defaults to the agentic account, loads its portfolio and positions', async () => {
    await useRhStore.getState().connect()
    const s = useRhStore.getState()
    expect(s.account).toBe('AGEN0002')
    expect(s.portfolio?.buying_power).toBe(2000)
    expect(s.positions.map((p) => p.symbol)).toEqual(['AAA', 'BBB'])
  })
  it('switching account reloads and drops the old rows first', async () => {
    await useRhStore.getState().connect()
    await useRhStore.getState().selectAccount('MAIN0001')
    expect(useRhStore.getState().positions.map((p) => p.symbol)).toEqual(['ZZZ'])
  })
  it('empty account has no rows and no error', async () => {
    fakeRh.positions = {}
    await useRhStore.getState().connect()
    expect(useRhStore.getState().positions).toEqual([])
    expect(useRhStore.getState().positionsError).toBe('')
  })
  it('surfaces an error message instead of throwing', async () => {
    await useRhStore.getState().connect()
    useRhStore.setState({ account: 'bad account!' })
    await useRhStore.getState().loadPositions()
    expect(useRhStore.getState().positionsError).toMatch(/invalid argument: account/)
    expect(useRhStore.getState().positionsLoading).toBe(false)
  })
})

describe('orders pane data', () => {
  it('filters by state through the api and shows the empty case', async () => {
    fakeRh.orders = {
      AGEN0002: [
        { id: '1', asset: 'equity', symbol: 'AAA', side: 'buy', order_type: 'limit', state: 'filled', trigger: null, quantity: 1, price: 1, stop_price: null, average_price: 1, dollar_based_amount: null, time_in_force: null, created_at: '2026-01-01T00:00:00Z', reject_reason: null, legs: [] },
      ],
    }
    await useRhStore.getState().connect()
    expect(useRhStore.getState().orders).toHaveLength(1)
    await useRhStore.getState().setOrderState('cancelled')
    expect(useRhStore.getState().orders).toEqual([])
    expect(fakeRh.orderCalls.at(-1)).toEqual({ account: 'AGEN0002', state: 'cancelled' })
    await useRhStore.getState().setOrderState('')
    expect(fakeRh.orderCalls.at(-1)?.state).toBeNull()
  })
})

describe('watchlist pane data', () => {
  it('selects the first list, keeps only equity symbols', async () => {
    await useRhStore.getState().connect()
    const s = useRhStore.getState()
    expect(s.listId).toBe('wl-1')
    expect(s.listSymbols).toEqual(['AAA', 'BRK.B'])
    await useRhStore.getState().selectList('wl-2')
    expect(useRhStore.getState().listSymbols).toEqual([])
  })
  const withOptions = () =>
    fakeRh.watchlists.unshift({ id: 'wl-opt', display_name: 'Opts', icon_emoji: null, item_count: 2, owner_type: null, allowed_object_types: ['option_strategy'] })

  it('default selection prefers the first non-options list', async () => {
    withOptions()
    await useRhStore.getState().connect()
    expect(useRhStore.getState().listId).toBe('wl-1')
  })
  it('falls back to an options list when it is the only one', async () => {
    fakeRh.watchlists = [{ id: 'wl-opt', display_name: 'Opts', icon_emoji: null, item_count: 2, owner_type: null, allowed_object_types: ['option_strategy'] }]
    await useRhStore.getState().connect()
    expect(useRhStore.getState().listId).toBe('wl-opt')
    expect(useRhStore.getState().optionItems).toHaveLength(2)
  })
  it('routes options lists to rhOptionWatchlist only, and equity lists to rhWatchlistItems only', async () => {
    withOptions()
    await useRhStore.getState().connect()
    const items = vi.spyOn(api, 'rhWatchlistItems')
    const opt = vi.spyOn(api, 'rhOptionWatchlist')
    await useRhStore.getState().selectList('wl-opt')
    expect(items).not.toHaveBeenCalled()
    expect(opt).toHaveBeenCalledTimes(1)
    let s = useRhStore.getState()
    expect(s.optionItems.map((o) => o.id)).toEqual(['o1', 'o2'])
    expect(s.listSymbols).toEqual([])
    expect(s.watchError).toBe('')
    await useRhStore.getState().selectList('wl-1')
    expect(opt).toHaveBeenCalledTimes(1)
    expect(items).toHaveBeenCalledTimes(1)
    s = useRhStore.getState()
    expect(s.optionItems).toEqual([])
    expect(s.listSymbols).toEqual(['AAA', 'BRK.B'])
    vi.restoreAllMocks()
  })
  it('a failing list shows its error and does not break the other lists', async () => {
    withOptions()
    await useRhStore.getState().connect()
    const spy = vi.spyOn(api, 'rhOptionWatchlist').mockRejectedValueOnce(new Error('tool error: boom'))
    await useRhStore.getState().selectList('wl-opt')
    expect(useRhStore.getState().watchError).toBe('tool error: boom')
    expect(useRhStore.getState().watchlists).toHaveLength(3)
    await useRhStore.getState().selectList('wl-1')
    expect(useRhStore.getState().watchError).toBe('')
    expect(useRhStore.getState().listSymbols).toEqual(['AAA', 'BRK.B'])
    spy.mockRestore()
  })
  it('the fake backend rejects equity reads of an options list like the server', () => {
    withOptions()
    fakeRh.connected = true
    expect(() => fakeRh.getWatchlistItems('wl-opt')).toThrow(/options watchlist/)
  })
  it('isEquitySymbol', () => {
    expect(isEquitySymbol({ symbol: 'AAA', object_type: 'instrument' })).toBe(true)
    expect(isEquitySymbol({ symbol: 'BTC-USD', object_type: 'currency_pair' })).toBe(false)
    expect(isEquitySymbol({ symbol: '', object_type: 'instrument' })).toBe(false)
  })
})

describe('quote polling through the store', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never feeds option items to the quote poller', async () => {
    fakeRh.watchlists = [{ id: 'wl-opt', display_name: 'Opts', icon_emoji: null, item_count: 2, owner_type: null, allowed_object_types: ['option_strategy'] }]
    await useRhStore.getState().connect()
    fakeRh.quoteCalls = []
    await vi.advanceTimersByTimeAsync(6000)
    expect(useRhStore.getState().optionItems).toHaveLength(2)
    expect(useRhStore.getState().listSymbols).toEqual([])
    expect(fakeRh.quoteCalls.flat()).not.toContain('AAA call')
    expect(fakeRh.quoteCalls.flat().every((s) => !['o1', 'o2', 'BBB put'].includes(s))).toBe(true)
  })

  it('batches positions and watchlist symbols into one deduplicated chunked call and fills quotes', async () => {
    await useRhStore.getState().connect()
    fakeRh.quoteCalls = []
    useRhStore.getState().watchQuotes('positions', ['AAA', 'BBB'])
    useRhStore.getState().watchQuotes('watchlist', ['AAA', 'BRK.B'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fakeRh.quoteCalls.length).toBe(1)
    expect(fakeRh.quoteCalls[0]).toEqual(['AAA', 'BBB', 'BRK.B'])
    expect(useRhStore.getState().quotes.AAA?.last_trade_price).toBe(101)
  })

  it('50 symbols cost 3 Robinhood calls per 5 s poll, well under 4/s', async () => {
    await useRhStore.getState().connect()
    fakeRh.quoteCalls = []
    useRhStore.getState().watchQuotes('watchlist', Array.from({ length: 50 }, (_, i) => `S${i}`))
    await vi.advanceTimersByTimeAsync(0)
    expect(fakeRh.quoteCalls.length).toBe(3)
    expect(fakeRh.quoteCalls.map((c) => c.length)).toEqual([20, 20, 10])
    expect(fakeRh.quoteCalls.length / 5).toBeLessThan(4)
  })
})
