import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeRh, type RhAccount } from '../src/lib/api'
import { useRhStore } from '../src/stores/rh'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'MAIN0001', rhs_account_number: '900000001', rhc_account_number: null, agentic_allowed: false, option_level: null,
  kind: 'margin', is_default: true, unsettled_funds: null, nickname: null, brokerage_account_type: null, ...o,
})

const AAA = { object_id: 'o1', object_type: 'instrument', symbol: 'AAA' }
const BBB = { object_id: 'o2', object_type: 'instrument', symbol: 'BBB' }

function seed() {
  fakeRh.accounts = [acct({})]
  fakeRh.watchlists = [
    { id: 'wl-mine', display_name: 'Mine', icon_emoji: null, item_count: 2, owner_type: 'custom', allowed_object_types: ['instrument'] },
    { id: 'wl-hot', display_name: 'Top Movers', icon_emoji: null, item_count: 1, owner_type: 'robinhood', allowed_object_types: ['instrument'] },
    { id: 'wl-opt', display_name: 'My Options', icon_emoji: null, item_count: 1, owner_type: 'custom', allowed_object_types: ['option_strategy'] },
  ]
  fakeRh.items = { 'wl-mine': [AAA, BBB], 'wl-hot': [{ object_id: 'o9', object_type: 'instrument', symbol: 'XXX' }] }
  fakeRh.optionItems = [{ id: 'oi1', name: 'AAA call', option_ids: ['11111111-2222-4333-8444-555555555555'], chain_symbol: 'AAA', expiration_date: '2026-12-18', strike_price: 150, contract_type: 'call' }]
}

const reset = () =>
  useRhStore.setState({
    status: null, connecting: false, connectError: '', accounts: [], account: null, portfolio: null, positions: [], positionsError: '',
    positionsLoading: false, orders: [], orderState: '', ordersError: '', watchlists: [], listId: null, listSymbols: [], optionItems: [],
    watchError: '', watchBusy: false, watchNote: '', quotes: {}, quoteError: '',
  })

const st = () => useRhStore.getState()

beforeEach(async () => {
  fake.reset()
  reset()
  seed()
  await st().connect()
})
afterEach(() => {
  st().watchQuotes('positions', [])
  st().watchQuotes('watchlist', [])
  vi.restoreAllMocks()
})

describe('add / remove symbols', () => {
  it('starts on the first custom list', () => {
    expect(st().listId).toBe('wl-mine')
    expect(st().listSymbols).toEqual(['AAA', 'BBB'])
  })

  it('add sends validated, deduped, uppercase symbols and reloads the list from the server', async () => {
    const ok = await st().addSymbols('ccc, aaa  ddd ccc')
    expect(ok).toBe(true)
    expect(fakeRh.writeLog).toEqual([{ tool: 'add_to_watchlist', args: { list_id: 'wl-mine', symbols: ['CCC', 'AAA', 'DDD'] } }])
    expect(st().listSymbols).toEqual(['AAA', 'BBB', 'CCC', 'DDD'])
    expect(st().watchlists.find((w) => w.id === 'wl-mine')?.item_count).toBe(4)
    expect(st().watchNote).toMatch(/Added CCC, AAA, DDD/)
    expect(st().watchError).toBe('')
    expect(st().watchBusy).toBe(false)
  })

  it('remove sends one symbol and the list shrinks after the reload', async () => {
    expect(await st().removeSymbol('AAA')).toBe(true)
    expect(fakeRh.writeLog).toEqual([{ tool: 'remove_from_watchlist', args: { list_id: 'wl-mine', symbols: ['AAA'] } }])
    expect(st().listSymbols).toEqual(['BBB'])
    expect(st().watchNote).toMatch(/Removed AAA/)
  })

  it('invalid input never reaches the backend and shows the reason inline', async () => {
    for (const bad of ['BTC/USD', '1ABC', 'AAA TOOLONGSYMBOL', Array.from({ length: 51 }, (_, i) => `S${i}`).join(' ')]) {
      expect(await st().addSymbols(bad), bad).toBe(false)
      expect(st().watchError, bad).not.toBe('')
    }
    expect(fakeRh.writeLog).toEqual([])
    expect(await st().addSymbols('   ')).toBe(false)
    expect(fakeRh.writeLog).toEqual([])
  })

  it('a second write while one is in flight is ignored (single flight)', async () => {
    const [a, b] = await Promise.all([st().addSymbols('CCC'), st().addSymbols('DDD')])
    expect([a, b]).toEqual([true, false])
    expect(fakeRh.writeLog).toHaveLength(1)
  })
})

describe('failure leaves the UI list unchanged (no optimistic update survives)', () => {
  it('a failing add_to_watchlist keeps the old rows, shows the error, never shows the new symbol', async () => {
    fakeRh.failWrite = 'tool error: API error 400: boom'
    const items = vi.spyOn(api, 'rhWatchlistItems')
    const seen: string[][] = []
    const unsub = useRhStore.subscribe((s) => seen.push([...s.listSymbols]))
    const ok = await st().addSymbols('ZZZ')
    unsub()
    expect(ok).toBe(false)
    expect(st().listSymbols).toEqual(['AAA', 'BBB'])
    expect(seen.every((s) => s.length === 2 && !s.includes('ZZZ')), JSON.stringify(seen)).toBe(true)
    expect(st().watchError).toMatch(/boom/)
    expect(st().watchBusy).toBe(false)
    expect(st().watchNote).toBe('')
    expect(items).not.toHaveBeenCalled()
    expect(fakeRh.items['wl-mine']).toHaveLength(2)
    // and it recovers
    fakeRh.failWrite = null
    expect(await st().addSymbols('ZZZ')).toBe(true)
    expect(st().listSymbols).toEqual(['AAA', 'BBB', 'ZZZ'])
    expect(st().watchError).toBe('')
  })

  it('a failing remove keeps the row', async () => {
    fakeRh.failWrite = 'tool error: nope'
    expect(await st().removeSymbol('AAA')).toBe(false)
    expect(st().listSymbols).toEqual(['AAA', 'BBB'])
    expect(st().watchError).toMatch(/nope/)
  })

  it('a write that succeeds but whose reload fails says so and keeps the old rows on screen', async () => {
    vi.spyOn(api, 'rhWatchlistItems').mockRejectedValueOnce(new Error('network down'))
    expect(await st().addSymbols('CCC')).toBe(true)
    expect(st().watchError).toMatch(/Saved, but the list could not be reloaded: network down/)
    expect(st().listSymbols).toEqual(['AAA', 'BBB'])
    expect(st().watchBusy).toBe(false)
  })
})

describe('read-only lists', () => {
  it('curated and options lists refuse writes in the store and in the fake backend, with no write logged', async () => {
    await st().selectList('wl-hot')
    expect(await st().addSymbols('AAA')).toBe(false)
    expect(await st().removeSymbol('XXX')).toBe(false)
    expect(await st().renameList('x')).toBe(false)
    expect(st().watchError).toMatch(/read-only/)
    await st().selectList('wl-opt')
    expect(await st().addSymbols('AAA')).toBe(false)
    expect(fakeRh.writeLog).toEqual([])
    await expect(api.rhWatchlistAdd('wl-hot', ['AAA'])).rejects.toThrow(/Robinhood list you follow/)
    await expect(api.rhWatchlistRemove('wl-hot', ['XXX'])).rejects.toThrow(/read-only/)
    await expect(api.rhWatchlistAdd('wl-opt', ['AAA'])).rejects.toThrow(/options watchlist/)
    await expect(api.rhWatchlistAdd('nope', ['AAA'])).rejects.toThrow(/not found/)
    expect(fakeRh.writeLog).toEqual([])
  })
})

describe('create and rename', () => {
  it('create makes a custom list, selects it, and the headers reload', async () => {
    expect(await st().createList('  Tech ', '\u{1F680}')).toBe(true)
    const w = st().watchlists.find((x) => x.display_name === 'Tech')!
    expect(w.owner_type).toBe('custom')
    expect(w.icon_emoji).toBe('\u{1F680}')
    expect(st().listId).toBe(w.id)
    expect(st().listSymbols).toEqual([])
    expect(fakeRh.writeLog).toEqual([{ tool: 'create_watchlist', args: { display_name: 'Tech' } }])
    // the new list takes writes
    expect(await st().addSymbols('NVDA')).toBe(true)
    expect(st().listSymbols).toEqual(['NVDA'])
  })

  it('create: invalid names make no call; a duplicate or a server error adds nothing', async () => {
    for (const n of ['', '   ', 'x'.repeat(51), 'a\nb']) expect(await st().createList(n, ''), JSON.stringify(n)).toBe(false)
    expect(await st().createList('ok', 'abcdefghi')).toBe(false)
    expect(fakeRh.writeLog).toEqual([])
    expect(await st().createList('mine', '')).toBe(false)
    expect(st().watchError).toMatch(/unique set/)
    fakeRh.failWrite = 'tool error: boom'
    expect(await st().createList('Fresh', '')).toBe(false)
    expect(st().watchlists.map((w) => w.display_name)).toEqual(['Mine', 'Top Movers', 'My Options'])
    expect(st().listId).toBe('wl-mine')
  })

  it('rename updates the dropdown label from the server and keeps the rows', async () => {
    expect(await st().renameList(' Core ')).toBe(true)
    expect(st().watchlists.find((w) => w.id === 'wl-mine')?.display_name).toBe('Core')
    expect(st().listSymbols).toEqual(['AAA', 'BBB'])
    expect(await st().renameList('')).toBe(false)
    fakeRh.failWrite = 'tool error: boom'
    expect(await st().renameList('Other')).toBe(false)
    expect(st().watchlists.find((w) => w.id === 'wl-mine')?.display_name).toBe('Core')
  })
})

describe('option contract tools and the command surface', () => {
  const ID = '11111111-2222-4333-8444-555555555555'
  it('remove takes UUIDs only and drops the contract from the options list', async () => {
    await expect(api.rhOptionWatchlistRemove(['AAPL'])).rejects.toThrow(/UUID/)
    await expect(api.rhOptionWatchlistAdd([])).rejects.toThrow(/no option contracts/)
    await expect(api.rhOptionWatchlistAdd(Array.from({ length: 21 }, (_, i) => `11111111-2222-4333-8444-${String(i).padStart(12, '0')}`))).rejects.toThrow(/at most 20/)
    await api.rhOptionWatchlistRemove([ID.toUpperCase()])
    expect(fakeRh.optionItems).toEqual([])
    expect(fakeRh.writeLog.at(-1)).toEqual({ tool: 'remove_option_from_watchlist', args: { option_ids: [ID] } })
  })
  it('there is no delete-watchlist entry point (no such tool upstream)', () => {
    expect(Object.keys(api).filter((n) => /delete.*(watch|list)|watch.*delete/i.test(n) && !n.startsWith('journal') && !n.startsWith('layout'))).toEqual([])
  })
})
