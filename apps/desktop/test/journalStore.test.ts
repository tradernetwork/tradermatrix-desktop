import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeRh, type RhAccount, type RhPnlTrade } from '../src/lib/api'
import { notesByTradeKey } from '../src/lib/journalUi'
import { useJournalStore } from '../src/stores/journal'
import { useRhStore } from '../src/stores/rh'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'MAIN0001', rhs_account_number: '900000001', rhc_account_number: null, agentic_allowed: false, option_level: null,
  kind: 'margin', is_default: true, unsettled_funds: null, nickname: null, brokerage_account_type: null, ...o,
})
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')
const trade = (key: string, symbol: string, gain: number | null, days: number): RhPnlTrade => ({
  trade_key: key, symbol, side: 'sell', quantity: 10, price: 100, realized_gain: gain, timestamp: ago(days),
})

function seed() {
  fakeRh.connected = true
  fakeRh.accounts = [acct({}), acct({ account_number: 'NORHS002', rhs_account_number: null, is_default: false })]
  fakeRh.pnlTrades = {
    MAIN0001: [trade('t_a', 'AAA', 25, 1), trade('t_b', 'BBB', -10, 2), trade('t_c', 'CCC', null, 20), trade('t_d', 'DDD', 5, 200)],
  }
}

const J = () => useJournalStore.getState()
const reset = () => {
  J().reset()
  useRhStore.setState({ account: 'MAIN0001', accounts: [], watchError: '' })
}

beforeEach(() => {
  fake.reset()
  seed()
  reset()
})
afterEach(() => vi.restoreAllMocks())

describe('P&L load', () => {
  it('month: totals and daily buckets from the account (mapped to rhs in the backend), trades newest first', async () => {
    await J().loadPnl()
    const s = J()
    expect(s.pnlError).toBe('')
    expect(s.pnl?.total_returns).toBe(15)
    expect(s.pnl?.data_points.map((p) => p.realized_gain)).toEqual([null, -10, 25])
    expect(s.pnl?.data_points).toHaveLength(3)
    expect(s.trades.map((t) => t.trade_key)).toEqual(['t_a', 't_b', 't_c'])
    expect(s.pnlAccount).toBe('MAIN0001')
    expect(fakeRh.pnlCalls.map((c) => c.tool).sort()).toEqual(['get_pnl_trade_history', 'get_realized_pnl'])
  })

  it('span change clears the old window first and loads the new one', async () => {
    await J().loadPnl()
    const seen: number[] = []
    const unsub = useJournalStore.subscribe((s) => seen.push(s.trades.length))
    await J().setSpan('week')
    unsub()
    expect(seen[0]).toBe(0)
    expect(J().span).toBe('week')
    expect(J().trades.map((t) => t.trade_key)).toEqual(['t_a', 't_b'])
    await J().setSpan('all')
    expect(J().trades).toHaveLength(4)
  })

  it('the last span wins when responses overlap', async () => {
    const a = J().setSpan('all')
    const b = J().setSpan('week')
    await Promise.all([a, b])
    expect(J().span).toBe('week')
    expect(J().trades.map((t) => t.trade_key)).toEqual(['t_a', 't_b'])
  })

  it('a failed refresh shows the error and keeps the numbers already on screen', async () => {
    await J().loadPnl()
    fakeRh.failPnl = 'tool error: upstream is down'
    await J().loadPnl()
    expect(J().pnlError).toMatch(/upstream is down/)
    expect(J().trades).toHaveLength(3)
    expect(J().pnlLoading).toBe(false)
  })

  it('an account without rhs_account_number is refused with the masked account', async () => {
    useRhStore.setState({ account: 'NORHS002' })
    await J().loadPnl()
    expect(J().pnlError).toMatch(/••••S002 has no rhs_account_number/)
    expect(J().pnlError).not.toMatch(/NORHS002/)
    expect(J().trades).toEqual([])
    expect(fakeRh.pnlCalls).toEqual([])
  })

  it('no account selected', async () => {
    useRhStore.setState({ account: null })
    await J().loadPnl()
    expect(J().pnlError).toBe('No account selected.')
  })

  it('data of another account is dropped before the new account loads', async () => {
    await J().loadPnl()
    useRhStore.setState({ account: 'NORHS002' })
    await J().loadPnl()
    expect(J().trades).toEqual([])
    expect(J().pnl).toBeNull()
  })

  it('pages: the first call reads up to 5 pages, "load more" resumes from the cursor and de-duplicates', async () => {
    fakeRh.pnlPage = 1
    fakeRh.pnlTrades = { MAIN0001: Array.from({ length: 7 }, (_, i) => trade(`t_${i}`, 'AAA', i, 1 + i * 0.01)) }
    await J().setSpan('all')
    expect(J().trades).toHaveLength(5)
    expect(J().tradesCursor).toBe('cur-5')
    await J().loadMoreTrades()
    expect(J().trades.map((t) => t.trade_key)).toEqual(['t_0', 't_1', 't_2', 't_3', 't_4', 't_5', 't_6'])
    expect(J().tradesCursor).toBeNull()
    await J().loadMoreTrades()
    expect(fakeRh.pnlCalls.filter((c) => c.tool === 'get_pnl_trade_history' && c.cursor === 'cur-5')).toHaveLength(1)
  })
})

describe('notes', () => {
  it('add, list newest first, edit, delete', async () => {
    expect(await J().addNote({ body: 'first', tags: ['plan'] })).toBe(true)
    expect(await J().addNote({ body: 'second', tags: [] })).toBe(true)
    expect(J().notes.map((n) => n.body)).toEqual(['second', 'first'])
    const id = J().notes[1]!.id
    expect(await J().editNote(id, 'first, edited', ['mistake'])).toBe(true)
    expect(J().notes.map((n) => n.body)).toEqual(['second', 'first, edited'])
    expect(J().notes[1]!.tags).toEqual(['mistake'])
    expect(await J().removeNote(id)).toBe(true)
    expect(J().notes.map((n) => n.body)).toEqual(['second'])
  })

  it('invalid notes are refused before the backend and leave the list alone', async () => {
    await J().addNote({ body: 'keep', tags: [] })
    const add = vi.spyOn(api, 'journalAdd')
    for (const bad of [{ body: '', tags: [] }, { body: 'x'.repeat(10_001), tags: [] }, { body: 'a\u0000b', tags: [] }, { body: 'ok', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, { body: 'ok', tags: ['x'.repeat(33)] }]) {
      expect(await J().addNote(bad), JSON.stringify(bad).slice(0, 30)).toBe(false)
      expect(J().notesError).not.toBe('')
    }
    expect(add).not.toHaveBeenCalled()
    expect(J().notes.map((n) => n.body)).toEqual(['keep'])
  })

  it('editing or deleting a missing note shows the error and keeps the rows', async () => {
    await J().addNote({ body: 'keep', tags: [] })
    expect(await J().editNote(999, 'x', [])).toBe(false)
    expect(J().notesError).toMatch(/not found/)
    expect(await J().removeNote(999)).toBe(false)
    expect(J().notes).toHaveLength(1)
  })

  it('filters by symbol and by literal text (% and _ are not wildcards)', async () => {
    const t = (sym: string) => trade(`t_${sym}`, sym, 1, 1)
    await J().addNote({ body: '100% win', tags: [], trade: t('AAA') })
    await J().addNote({ body: '100x win', tags: [], trade: t('BBB') })
    await J().addNote({ body: 'a_b literal', tags: [] })
    await J().addNote({ body: 'axb other', tags: [] })
    await J().setFilter('aaa', '')
    expect(J().notes.map((n) => n.body)).toEqual(['100% win'])
    await J().setFilter('', '100%')
    expect(J().notes.map((n) => n.body)).toEqual(['100% win'])
    await J().setFilter('', 'a_b')
    expect(J().notes.map((n) => n.body)).toEqual(['a_b literal']) // not 'axb other': _ is not a wildcard
    await J().setFilter('', '')
    expect(J().notes).toHaveLength(4)
    await J().setFilter('bad sym', '')
    expect(J().notesError).toMatch(/symbol/)
    expect(J().notes).toHaveLength(4)
  })
})

describe('trade-note linking', () => {
  it('a note added from a trade carries trade_key, symbol and the masked account, and is found by trade_key', async () => {
    await J().loadPnl()
    const t = J().trades[0]!
    expect(await J().addNote({ body: 'sold the pop', tags: ['plan'], trade: t })).toBe(true)
    await J().addNote({ body: 'unrelated', tags: [] })
    const n = J().notes.find((x) => x.body === 'sold the pop')!
    expect(n.trade_key).toBe('t_a')
    expect(n.symbol).toBe('AAA')
    expect(n.account_masked).toBe('••••0001')
    expect(n.account_masked).not.toMatch(/MAIN/)
    const linked = notesByTradeKey(J().notes)
    expect(linked.get('t_a')!.map((x) => x.body)).toEqual(['sold the pop'])
    expect(linked.has('t_b')).toBe(false)
    expect((await api.journalList({ trade_key: 't_a' })).map((x) => x.body)).toEqual(['sold the pop'])
  })

  it('selecting a trade toggles the editor target', () => {
    J().selectTrade('t_a')
    expect(J().selectedKey).toBe('t_a')
    J().selectTrade('t_b')
    expect(J().selectedKey).toBe('t_b')
    J().selectTrade('t_b')
    expect(J().selectedKey).toBeNull()
  })
})

describe('CSV export', () => {
  it('shows the saved path and row count (trades + their notes + loose notes)', async () => {
    await J().loadPnl()
    await J().addNote({ body: 'on a trade', tags: [], trade: J().trades[0]! })
    await J().addNote({ body: 'loose', tags: [] })
    await J().exportCsv()
    expect(J().exportError).toBe('')
    // 3 trades in the month (one with a note) + 1 loose note
    expect(J().exportNote).toBe('Saved 4 rows to /fake/exports/rebull-journal-month.csv')
  })

  it('errors are shown and nothing is claimed saved', async () => {
    fakeRh.failPnl = 'tool error: nope'
    await J().exportCsv()
    expect(J().exportNote).toBe('')
    expect(J().exportError).toMatch(/nope/)
    useRhStore.setState({ account: null })
    await J().exportCsv()
    expect(J().exportError).toBe('No account selected.')
  })
})
