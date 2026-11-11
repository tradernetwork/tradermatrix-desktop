import { describe, expect, it } from 'vitest'
import type { RhApproval, RhOptionPosition, RhOrder, RhPortfolio, RhPosition, RhQuote } from '../src/lib/api'
import { deskChips, deskMetrics, fmtMetric, isPendingApproval, priceLine, type DeskInput } from '../src/lib/deskUi'

const pf = (o: Partial<RhPortfolio> = {}): RhPortfolio => ({ total_value: 12000, equity_value: 10000, options_value: 500, cash: 1500, buying_power: 3000, currency: 'USD', ...o })
const pos = (symbol: string, quantity: number, avg: number): RhPosition => ({ symbol, quantity, average_buy_price: avg, shares_available_for_sells: quantity, shares_held_for_sells: 0 })
const q = (symbol: string, last: number | null, o: Partial<RhQuote> = {}): RhQuote => ({ symbol, bid_price: null, ask_price: null, last_trade_price: last, previous_close: null, ...o })
const ord = (state: string | null, o: Partial<RhOrder> = {}): RhOrder => ({
  id: 'o' + Math.random(), asset: 'equity', symbol: 'AAA', side: 'buy', order_type: 'limit', state, trigger: null, quantity: 1, price: 1, stop_price: null,
  average_price: null, dollar_based_amount: null, time_in_force: 'gfd', created_at: null, reject_reason: null, legs: [], ...o,
})
const appr = (state: string): RhApproval => ({ approval_id: 'a' + Math.random(), account_number: 'ACC1', asset_class: 'equity', state })
const base = (o: Partial<DeskInput> = {}): DeskInput => ({
  connected: true, account: 'ACC1', portfolio: pf(), positions: [], optionPositions: [], quotes: {}, orders: [], ordersError: '', approvals: [], approvalsAccount: 'ACC1', ...o,
})

describe('deskMetrics', () => {
  it('everything is null when not connected or no account', () => {
    for (const i of [base({ connected: false }), base({ account: null })]) {
      const m = deskMetrics(i)
      expect(m).toEqual({ equity: null, buyingPower: null, cash: null, positionsCount: null, unrealized: null, unrealizedPartial: false, openOrders: null, pendingApprovals: null })
    }
  })
  it('portfolio numbers pass through; a missing portfolio is null, not 0', () => {
    expect(deskMetrics(base())).toMatchObject({ equity: 10000, buyingPower: 3000, cash: 1500 })
    expect(deskMetrics(base({ portfolio: null }))).toMatchObject({ equity: null, buyingPower: null, cash: null })
    expect(deskMetrics(base({ portfolio: pf({ cash: null }) })).cash).toBeNull()
  })
  it('unrealized P&L is (last - avg) * qty summed over quoted equities: 10*(12-10) + 5*(8-10) = 10', () => {
    const m = deskMetrics(base({ positions: [pos('AAA', 10, 10), pos('BBB', 5, 10)], quotes: { AAA: q('AAA', 12), BBB: q('BBB', 8) } }))
    expect(m.positionsCount).toBe(2)
    expect(m.unrealized).toBeCloseTo(10)
    expect(m.unrealizedPartial).toBe(false)
  })
  it('a position without a quote is left out and flags the total as partial', () => {
    const m = deskMetrics(base({ positions: [pos('AAA', 10, 10), pos('BBB', 5, 10)], quotes: { AAA: q('AAA', 12) } }))
    expect(m.unrealized).toBeCloseTo(20)
    expect(m.unrealizedPartial).toBe(true)
    const none = deskMetrics(base({ positions: [pos('AAA', 10, 10)], quotes: {} }))
    expect(none.unrealized).toBeNull()
  })
  it('no positions at all: count 0 and unrealized 0', () => {
    const m = deskMetrics(base())
    expect(m.positionsCount).toBe(0)
    expect(m.unrealized).toBe(0)
  })
  it('option positions count and add their P&L (long: value - cost)', () => {
    const o = { option_id: 'x', chain_symbol: 'AAA', expiration_date: null, strike_price: 1, option_type: 'call', side: 'long', quantity: 2, average_price: 100, multiplier: 100, mark: 1.5 } as unknown as RhOptionPosition
    const m = deskMetrics(base({ optionPositions: [o] }))
    expect(m.positionsCount).toBe(1)
    expect(m.unrealized).toBeCloseTo(100) // value 1.5*100*2 = 300, cost 100*2 = 200
  })
  it('open orders counts only cancelable states and is null after a failed read', () => {
    const orders = [ord('queued'), ord('confirmed'), ord('filled'), ord('cancelled'), ord('partially_filled'), ord(null)]
    expect(deskMetrics(base({ orders })).openOrders).toBe(3)
    expect(deskMetrics(base({ orders, ordersError: 'boom' })).openOrders).toBeNull()
  })
  it('pending approvals counts PENDING only, and only for the selected account', () => {
    const approvals = [appr('APPROVAL_STATE_PENDING'), appr('APPROVAL_STATE_APPROVED'), appr('APPROVAL_STATE_PENDING')]
    expect(deskMetrics(base({ approvals })).pendingApprovals).toBe(2)
    expect(deskMetrics(base({ approvals, approvalsAccount: 'OTHER' })).pendingApprovals).toBeNull()
    expect(deskMetrics(base({ approvals, approvalsAccount: null })).pendingApprovals).toBeNull()
    expect(isPendingApproval(appr('APPROVAL_STATE_PENDING'))).toBe(true)
    expect(isPendingApproval(appr('APPROVAL_STATE_DECLINED'))).toBe(false)
  })
})

describe('fmtMetric', () => {
  it('shows - for null / NaN, money, and counts', () => {
    expect(fmtMetric(null, 'money')).toBe('-')
    expect(fmtMetric(NaN, 'money')).toBe('-')
    expect(fmtMetric(1234.5, 'money')).toBe('$1,234.50')
    expect(fmtMetric(-5, 'money')).toBe('-$5.00')
    expect(fmtMetric(null, 'count')).toBe('-')
    expect(fmtMetric(3, 'count')).toBe('3')
  })
})

describe('priceLine', () => {
  it('last, bid, ask and the change from the previous close', () => {
    const p = priceLine(q('AAA', 102, { bid_price: 101.9, ask_price: 102.1, previous_close: 100 }))
    expect(p).toEqual({ last: '102.00', bid: '101.90', ask: '102.10', change: '+2.00', changePct: '+2.00%', cls: 'bull' })
  })
  it('a down day is bear, flat is neutral', () => {
    expect(priceLine(q('AAA', 98, { previous_close: 100 })).cls).toBe('bear')
    expect(priceLine(q('AAA', 98, { previous_close: 100 })).change).toBe('-2.00')
    expect(priceLine(q('AAA', 100, { previous_close: 100 })).cls).toBe('')
  })
  it('unknown quote or fields print -', () => {
    expect(priceLine(undefined)).toEqual({ last: '-', bid: '-', ask: '-', change: '-', changePct: '-', cls: '' })
    expect(priceLine(q('AAA', 5)).change).toBe('-')
    expect(priceLine(q('AAA', null, { previous_close: 5 })).changePct).toBe('-')
  })
})

describe('deskChips', () => {
  const chips = (o: Partial<Parameters<typeof deskChips>[0]> = {}) =>
    deskChips({ rh: 'connected', account: 'ACC1', approvalOn: false, tm: { key_present: true, last_error: null }, vault: { exists: true, unlocked: true, backend: 'vault' }, fake: false, ...o })
  const text = (o: Partial<Parameters<typeof deskChips>[0]> = {}) => chips(o).map((c) => c.text)
  it('connected, approvals OFF, TM key ok, vault unlocked, no FAKE chip', () => {
    expect(text()).toEqual(['Robinhood: connected', 'Approvals: OFF', 'TM key: ok', 'Vault: unlocked'])
  })
  it('the other Robinhood states', () => {
    expect(text({ rh: 'disconnected' })[0]).toBe('Robinhood: not connected')
    expect(text({ rh: 'connecting' })[0]).toBe('Robinhood: connecting')
    expect(text({ rh: 'error' })[0]).toBe('Robinhood: error')
  })
  it('approvals ON, unknown, and no account', () => {
    expect(text({ approvalOn: true })[1]).toBe('Approvals: ON')
    expect(text({ approvalOn: null })[1]).toBe('Approvals: ?')
    expect(text({ account: null, approvalOn: undefined })[1]).toBe('Approvals: -')
  })
  it('TM key states: missing, rejected, vault locked', () => {
    expect(text({ tm: { key_present: false, last_error: null } })[2]).toBe('TM key: missing')
    expect(text({ tm: null })[2]).toBe('TM key: missing')
    expect(text({ tm: { key_present: true, last_error: 'TraderMatrix rejected the key' } })[2]).toBe('TM key: rejected')
    expect(text({ tm: { key_present: true, last_error: 'vault locked' } })[2]).toBe('TM key: vault locked')
  })
  it('vault states, and a keychain backend', () => {
    expect(text({ vault: { exists: true, unlocked: false, backend: 'vault' } })[3]).toBe('Vault: locked')
    expect(text({ vault: { exists: false, unlocked: false, backend: 'vault' } })[3]).toBe('Vault: not created')
    expect(text({ vault: { exists: false, unlocked: false, backend: 'keychain' } })[3]).toBe('Secrets: keychain')
    expect(text({ vault: null })[3]).toBe('Vault: -')
  })
  it('FAKE DATA chip first when fake, with the bad tone', () => {
    const c = chips({ fake: true })
    expect(c[0]).toMatchObject({ text: 'FAKE DATA', tone: 'bad' })
    expect(c).toHaveLength(5)
  })
  it('every chip has a unique key and a tone', () => {
    const c = chips({ fake: true })
    expect(new Set(c.map((x) => x.key)).size).toBe(c.length)
    expect(c.every((x) => ['ok', 'warn', 'bad', 'muted'].includes(x.tone))).toBe(true)
  })
})
