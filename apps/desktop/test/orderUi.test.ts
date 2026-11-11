import { describe, expect, it } from 'vitest'
import type { PlaceOutcome, RhAccount, RhOptionRow, RhOrder } from '../src/lib/api'
import {
  agenticAccounts,
  approvalBanner,
  approvalIdOf,
  approvalPill,
  approvalSummary,
  buildEquityArgs,
  buildOptionArgs,
  echoedSummary,
  findContract,
  hasOrderChecks,
  isCancelable,
  maskKnown,
  midPrice,
  optionStrikes,
  orderCheckMessages,
  placeLabel,
  resultCard,
  shortId,
  ticketDisabledReason,
} from '../src/lib/orderUi'
import { validateEquity, validateOption } from '../src/lib/orderValidation'
import { chainsOf, optionLegLabel, pickChain, rowsForChain } from '../src/lib/orderUi'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'SYN00000001', rhs_account_number: null, rhc_account_number: null, agentic_allowed: false, option_level: null,
  kind: 'margin', is_default: false, unsettled_funds: null, nickname: null, brokerage_account_type: null, ...o,
})

describe('approval banner', () => {
  it('amber when approval is required, with the reason', () => {
    const b = approvalBanner({ customer_approval_required: true, customer_approval_reason: 'account_setting' })
    expect(b.tone).toBe('amber')
    expect(b.text).toBe('Needs your approval in the Robinhood app (account_setting)')
  })
  it('amber without a reason or with an empty one', () => {
    expect(approvalBanner({ customer_approval_required: true, customer_approval_reason: null }).text).toBe('Needs your approval in the Robinhood app')
    expect(approvalBanner({ customer_approval_required: true, customer_approval_reason: '' }).text).toBe('Needs your approval in the Robinhood app')
  })
  it('green when false, grey when absent', () => {
    expect(approvalBanner({ customer_approval_required: false, customer_approval_reason: null })).toEqual({
      tone: 'green',
      text: 'Will execute as soon as it is placed',
    })
    expect(approvalBanner({ customer_approval_required: null, customer_approval_reason: null })).toEqual({
      tone: 'grey',
      text: 'Approval requirement unknown',
    })
  })
})

describe('order checks and the place button', () => {
  it('empty object is clean, anything else is an alert', () => {
    expect(hasOrderChecks({})).toBe(false)
    expect(hasOrderChecks(null)).toBe(false)
    expect(hasOrderChecks(undefined)).toBe(false)
    expect(hasOrderChecks({ alert_type: 'BUYING_POWER_ALERT' })).toBe(true)
  })
  it('extracts readable messages and falls back to compact json', () => {
    const m = orderCheckMessages({ alert_type: 'BUYING_POWER_ALERT', buying_power_alert: { message: 'Not enough buying power' } })
    expect(m).toEqual(['BUYING_POWER_ALERT', 'Not enough buying power'])
    expect(orderCheckMessages({ weird: 5 })).toEqual(['{"weird":5}'])
    expect(orderCheckMessages({})).toEqual([])
  })
  it('labels: Place order / Place anyway / Placing', () => {
    expect(placeLabel(false, false)).toBe('Place order')
    expect(placeLabel(true, false)).toBe('Place anyway')
    expect(placeLabel(false, true)).toBe('Placing...')
    expect(placeLabel(true, true)).toBe('Placing...')
  })
})

describe('result cards', () => {
  const placed: PlaceOutcome = { kind: 'placed', order: { id: '22222222-3333-4444-8555-666666666666', state: 'queued' } }
  const awaiting: PlaceOutcome = { kind: 'awaiting_approval', approval: { approval_id: 'appr-0001' } }
  it('placed shows state and short id, no actions', () => {
    const c = resultCard(placed)
    expect(c.tone).toBe('green')
    expect(c.body).toContain('queued')
    expect(c.body).toContain('22222222')
    expect(c.body).not.toContain('666666666666')
    expect(c.actions).toEqual([])
  })
  it('awaiting approval: amber, decline only, no resubmit, points at the Robinhood app', () => {
    const c = resultCard(awaiting)
    expect(c.tone).toBe('amber')
    expect(c.body).toContain('Open the Robinhood app to approve or decline')
    expect(c.actions).toEqual(['decline'])
    expect(c.title).toMatch(/not placed/i)
    expect(approvalIdOf(awaiting)).toBe('appr-0001')
    expect(approvalIdOf(placed)).toBeNull()
  })
  it('rejected shows the server text verbatim and says NOT placed', () => {
    const c = resultCard({ kind: 'rejected', message: 'tool error: insufficient buying power' })
    expect(c.tone).toBe('red')
    expect(c.title).toMatch(/NOT placed/)
    expect(c.body).toBe('tool error: insufficient buying power')
    expect(c.actions).toEqual([])
  })
  it('unknown: could not confirm, retry same ref and refresh orders', () => {
    const c = resultCard({ kind: 'unknown', message: 'connection reset' })
    expect(c.tone).toBe('amber')
    expect(c.body).toContain('Could not confirm. Check Orders before retrying.')
    expect(c.body).toContain('connection reset')
    expect(c.actions).toEqual(['retry', 'refresh'])
  })
  it('shortId keeps the first eight characters', () => {
    expect(shortId('22222222-3333-4444-8555-666666666666')).toBe('22222222')
    expect(shortId(null)).toBe('-')
  })
})

describe('accounts and masking', () => {
  it('only agentic accounts are selectable', () => {
    const a = [acct({ account_number: 'MAIN0001' }), acct({ account_number: 'AGEN0002', agentic_allowed: true })]
    expect(agenticAccounts(a).map((x) => x.account_number)).toEqual(['AGEN0002'])
  })
  it('ticket disabled reasons', () => {
    expect(ticketDisabledReason(false, [])).toMatch(/connect/i)
    expect(ticketDisabledReason(true, [acct({})])).toMatch(/agentic/i)
    expect(ticketDisabledReason(true, [acct({ agentic_allowed: true })])).toBeNull()
  })
  it('maskKnown replaces every full account number', () => {
    const t = maskKnown('order on SYN00000002 failed; SYN00000002 and MAIN0001 untouched?', ['SYN00000002', 'MAIN0001'])
    expect(t).toBe('order on ••••0002 failed; ••••0002 and ••••0001 untouched?')
    expect(maskKnown('nothing here', ['SYN00000002'])).toBe('nothing here')
  })
  it('approvals pill: ON/OFF/unknown', () => {
    expect(approvalPill(true).text).toBe('approvals: ON')
    expect(approvalPill(true).cls).toBe('ok')
    expect(approvalPill(false).text).toBe('approvals: OFF')
    expect(approvalPill(false).cls).toBe('warn')
    expect(approvalPill(null).text).toBe('approvals: ?')
  })
})

describe('ticket builders go through the same validation as Rust', () => {
  const f = { account: 'SYN00000002', symbol: ' aapl ', side: 'buy', type: 'limit', sizeMode: 'quantity', quantity: '1', dollars: '', limit: '90', stop: '', tif: 'gfd', session: 'regular_hours' } as const
  it('uppercases, trims and keeps only the fields the type needs', () => {
    const a = buildEquityArgs({ ...f, stop: '95' })
    expect(a).toEqual({
      account_number: 'SYN00000002', symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '1', limit_price: '90', time_in_force: 'gfd', market_hours: 'regular_hours',
    })
    expect(validateEquity(a)).toBeNull()
  })
  it('market with dollars', () => {
    const a = buildEquityArgs({ ...f, type: 'market', sizeMode: 'dollars', dollars: '25', limit: '90' })
    expect(a.dollar_amount).toBe('25')
    expect(a.quantity).toBeUndefined()
    expect(a.limit_price).toBeUndefined()
    expect(validateEquity(a)).toBeNull()
  })
  it('stop_limit carries both prices; dollars with limit is rejected', () => {
    const a = buildEquityArgs({ ...f, type: 'stop_limit', stop: '95' })
    expect(a.stop_price).toBe('95')
    expect(a.limit_price).toBe('90')
    expect(validateEquity(buildEquityArgs({ ...f, sizeMode: 'dollars', dollars: '10' }))).not.toBeNull()
  })
  it('option args are one leg, limit, no direction', () => {
    const a = buildOptionArgs({ account: 'SYN00000002', optionId: '11111111-2222-4333-8444-555555555555', side: 'buy', effect: 'open', quantity: '1', price: '1.50', tif: 'gfd' })
    expect(a.legs).toEqual([{ option_id: '11111111-2222-4333-8444-555555555555', side: 'buy', position_effect: 'open', ratio_quantity: 1 }])
    expect(a.type).toBe('limit')
    expect(a.direction).toBeUndefined()
    expect(validateOption(a)).toBeNull()
    expect(validateOption(buildOptionArgs({ account: 'SYN00000002', optionId: '', side: 'buy', effect: 'open', quantity: '1', price: '1.5', tif: 'gfd' }))).not.toBeNull()
  })
})

const row = (id: string, strike: number, type: string, bid: number | null, ask: number | null, mark: number | null = null): RhOptionRow => ({
  instrument: { id, chain_id: 'c', expiration_date: '2026-12-18', strike_price: strike, option_type: type },
  quote: { instrument_id: id, bid, ask, mark, delta: 0.4, gamma: null, theta: null, vega: null, rho: null, implied_volatility: null, open_interest: null, volume: null },
})

describe('option contract helpers', () => {
  const rows = [row('a', 200, 'call', 1, 1.2), row('b', 195, 'call', 2, 2.2), row('c', 200, 'put', 1.5, 1.7), row('d', 190, 'put', null, null), { ...row('e', 205, 'call', null, null), quote: null }]
  it('strikes for a side are sorted and unique', () => {
    expect(optionStrikes(rows, 'call')).toEqual([195, 200, 205])
    expect(optionStrikes(rows, 'put')).toEqual([190, 200])
  })
  it('finds the contract by type and strike', () => {
    expect(findContract(rows, 'put', 200)?.instrument.id).toBe('c')
    expect(findContract(rows, 'call', 200)?.instrument.id).toBe('a')
    expect(findContract(rows, 'call', 999)).toBeUndefined()
  })
  it('mid from bid/ask, else mark, else null', () => {
    expect(midPrice(rows[0])).toBe('1.10')
    expect(midPrice(row('x', 1, 'call', null, null, 0.8))).toBe('0.80')
    expect(midPrice(rows[3])).toBeNull()
    expect(midPrice(rows[4])).toBeNull()
  })
})

describe('cancelable orders', () => {
  const o = (state: string | null, asset = 'equity'): RhOrder => ({
    id: 'x', asset, symbol: 'A', side: 'buy', order_type: 'limit', state, trigger: null, quantity: 1, price: 1, stop_price: null,
    average_price: null, dollar_based_amount: null, time_in_force: null, created_at: null, reject_reason: null, legs: [],
  })
  it('open states are cancelable, terminal ones are not', () => {
    for (const s of ['queued', 'confirmed', 'unconfirmed', 'partially_filled']) expect(isCancelable(o(s)), s).toBe(true)
    for (const s of ['filled', 'cancelled', 'rejected', 'failed', null]) expect(isCancelable(o(s)), String(s)).toBe(false)
    expect(isCancelable(o('queued', 'crypto'))).toBe(false)
  })
})

describe('echoed review summary', () => {
  it('collects scalar rows, quote, disclosure, fees and collateral; masks account numbers', () => {
    const s = echoedSummary(
      {
        account_number: 'SYN00000002', symbol: 'AAA', side: 'buy', type: 'limit', quantity: '1', limit_price: '90.00',
        quote_data: { bid_price: '100.10', ask_price: '100.20', last_trade_price: '100.15' },
        market_data_disclosure: 'NBBO delayed',
        fees: { total_fee: '0.03' },
        collateral: { cash: { amount: '150.00', direction: 'debit', infinite: false }, equities: [] },
        order_checks: {}, customer_approval_required: true, customer_approval_required_reason: 'x',
      },
      ['SYN00000002'],
    )
    expect(s.rows).toContainEqual(['account number', '••••0002'])
    expect(s.rows).toContainEqual(['symbol', 'AAA'])
    expect(s.rows.some(([k]) => k.includes('customer approval'))).toBe(false)
    expect(s.quote).toBe('bid 100.10 / ask 100.20 / last 100.15')
    expect(s.disclosure).toBe('NBBO delayed')
    expect(s.fees).toBe('total fee 0.03')
    expect(s.collateral).toBe('cash 150.00 (debit)')
    expect(JSON.stringify(s)).not.toContain('SYN00000002')
  })
  it('lists legs and option quotes for options', () => {
    const s = echoedSummary(
      {
        legs: [{ option_id: '11111111-2222-4333-8444-555555555555', side: 'buy', position_effect: 'open', ratio_quantity: 1 }],
        option_quotes: [{ option_id: '11111111-2222-4333-8444-555555555555', bid_price: '1.40', ask_price: '1.60', delta: '0.45' }],
      },
      [],
    )
    expect(s.legs).toEqual(['buy open x1 11111111'])
    expect(s.optionQuotes).toEqual(['11111111: bid 1.40 / ask 1.60 / delta 0.45'])
  })
  it('an empty echo does not throw', () => {
    expect(echoedSummary({}, []).rows).toEqual([])
  })
})

describe('approval summary', () => {
  it('summarises the proposed order and masks the account', () => {
    const t = approvalSummary(
      { approval_id: 'a1', account_number: 'SYN00000002', asset_class: 'ASSET_CLASS_EQUITY', state: 'APPROVAL_STATE_PENDING', proposed_order: { symbol: 'AAA', side: 'buy', quantity: '1', limit_price: '90.00' } },
      ['SYN00000002'],
    )
    expect(t).toContain('AAA')
    expect(t).toContain('buy')
    expect(t).toContain('90.00')
    expect(t).not.toContain('SYN00000002')
  })
  it('survives a missing proposed order', () => {
    expect(approvalSummary({ approval_id: 'a1', account_number: 'X', asset_class: 'ASSET_CLASS_OPTION', state: 'APPROVAL_STATE_PENDING' }, [])).toBeTruthy()
  })
})


describe('multi-chain option rows (index and adjusted chains)', () => {
  const mk = (id: string, chainId: string, chainSymbol: string | null, strike: number, type: string): RhOptionRow => {
    const r = row(id, strike, type, 1, 1.2)
    return { ...r, instrument: { ...r.instrument, chain_id: chainId, chain_symbol: chainSymbol } }
  }
  const rows = [mk('a', 'c1', 'AAPL', 200, 'call'), mk('b', 'c2', 'AAPL1', 200, 'call'), mk('c', 'c1', 'AAPL', 205, 'call')]
  it('lists each chain once, in order of appearance, with its symbol', () => {
    expect(chainsOf(rows)).toEqual([{ id: 'c1', symbol: 'AAPL' }, { id: 'c2', symbol: 'AAPL1' }])
  })
  it('keeps only the picked chain, so a strike never silently resolves to another chain', () => {
    expect(rowsForChain(rows, 'c2').map((r) => r.instrument.id)).toEqual(['b'])
    expect(optionStrikes(rowsForChain(rows, 'c1'), 'call')).toEqual([200, 205])
    expect(findContract(rowsForChain(rows, 'c2'), 'call', 200)?.instrument.id).toBe('b')
  })
  it('defaults to the primary chain; an unknown pick falls back to primary, then to the first chain', () => {
    const cs = chainsOf(rows)
    expect(pickChain(cs, '', 'c1')).toBe('c1')
    expect(pickChain(cs, 'c2', 'c1')).toBe('c2')
    expect(pickChain(cs, 'zzz', 'c1')).toBe('c1')
    expect(pickChain(cs, 'zzz', 'nope')).toBe('c1')
    expect(pickChain([], 'c2', 'c1')).toBe('')
  })
  it('a single-chain list is returned unchanged', () => {
    const one = [rows[0]!, rows[2]!]
    expect(rowsForChain(one, 'c1')).toEqual(one)
  })
  it('the review label uses the contract\'s OWN chain symbol, not the primary one', () => {
    expect(optionLegLabel(rows, 'b', 'AAPL')).toMatch(/^AAPL1 /)
    expect(optionLegLabel(rows, 'a', 'AAPL')).toMatch(/^AAPL /)
  })
})
