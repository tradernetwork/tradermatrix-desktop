import { describe, expect, it } from 'vitest'
import type { RhAccount, RhApproval, RhOptionRow, RhOrder } from '../src/lib/api'
import {
  approvalSummary,
  echoedSummary,
  midPrice,
  nextOptionPrice,
  optionLegLabel,
  orderCheckMessages,
  orderStopText,
  orderTypeLabel,
  resultCard,
  retryExpired,
  ticketAccountProblem,
  withTicketRows,
} from '../src/lib/orderUi'

const row = (id: string, strike: number, type: string, bid: number | null, ask: number | null, mark: number | null = null): RhOptionRow => ({
  instrument: { id, chain_id: 'c', expiration_date: '2026-11-20', strike_price: strike, option_type: type },
  quote: { instrument_id: id, bid, ask, mark, delta: null, gamma: null, theta: null, vega: null, rho: null, implied_volatility: null, open_interest: null, volume: null },
})

describe('F1 option helpers', () => {
  it('rounds the mid to the chain tick (below/above cutoff) else 0.01', () => {
    const r = row('x', 100, 'call', 3.0, 3.1)
    expect(midPrice(r)).toBe('3.05')
    const ticks = { above_tick: '0.05', below_tick: '0.01', cutoff_price: '3.00' }
    expect(midPrice(row('x', 1, 'call', 3.0, 3.1), ticks)).toBe('3.05')
    expect(midPrice(row('x', 1, 'call', 3.02, 3.1), ticks)).toBe('3.05') // 3.06 -> 3.05
    expect(midPrice(row('x', 1, 'call', 1.0, 1.04), ticks)).toBe('1.02')
    expect(midPrice(row('x', 1, 'call', 3.0, 3.07), ticks)).toBe('3.05') // 3.035 -> 3.05
    expect(midPrice(row('x', 1, 'call', 1.0, 1.1), { above_tick: 0.05 })).toBe('1.05')
    expect(midPrice(row('x', 1, 'call', 1.0, 1.1), null)).toBe('1.05')
  })
  it('never overwrites a hand-typed price', () => {
    expect(nextOptionPrice({ current: '', lastAuto: null, mid: '1.10' })).toEqual({ price: '1.10', auto: '1.10' })
    expect(nextOptionPrice({ current: '1.10', lastAuto: '1.10', mid: '2.20' })).toEqual({ price: '2.20', auto: '2.20' })
    expect(nextOptionPrice({ current: '1.50', lastAuto: '1.10', mid: '2.20' })).toEqual({ price: '1.50', auto: '1.10' })
    expect(nextOptionPrice({ current: '', lastAuto: '1.10', mid: null })).toEqual({ price: '', auto: '1.10' })
  })
  it('labels a leg from the loaded rows, null when not found', () => {
    const rows = [row('00000000-0000-4000-8000-000000000001', 150, 'put', 1, 1.2)]
    expect(optionLegLabel(rows, '00000000-0000-4000-8000-000000000001', 'AAPL')).toBe('AAPL 2026-11-20 150 put')
    expect(optionLegLabel(rows, '00000000-0000-4000-8000-000000000002', 'AAPL')).toBeNull()
  })
  it('option quote lines prefer instrument_id', () => {
    const s = echoedSummary({ option_quotes: [{ instrument_id: 'abcdefgh-1', option_id: 'zzzzzzzz-9', bid_price: '1' }, { option_id: 'qwertyui-2', bid_price: '2' }] }, [])
    expect(s.optionQuotes[0]).toMatch(/^abcdefgh:/)
    expect(s.optionQuotes[1]).toMatch(/^qwertyui:/)
  })
})

describe('F2 result cards', () => {
  it('a placed order in a failed state is red and says it was not accepted', () => {
    for (const state of ['rejected', 'failed', 'voided', 'cancelled']) {
      const c = resultCard({ kind: 'placed', order: { id: 'abcdef123456', state } })
      expect(c.tone).toBe('red')
      expect(c.title).toBe(`Order was not accepted: ${state}`)
    }
    expect(resultCard({ kind: 'placed', order: { id: 'abcdef123456', state: 'queued' } }).tone).toBe('green')
  })
  it('unknown shows age and retry window; retry is disabled after retry_until', () => {
    const now = 1_000_000_000_000
    const live = resultCard({ kind: 'unknown', message: 'reset', retry_until: now / 1000 + 300 }, { now, since: now - 125_000 })
    expect(live.retryDisabled).toBe(false)
    expect(live.body).toMatch(/2m 5s/)
    expect(live.actions).toContain('retry')
    const dead = resultCard({ kind: 'unknown', message: 'reset', retry_until: now / 1000 - 1 }, { now, since: now - 700_000 })
    expect(dead.retryDisabled).toBe(true)
    expect(dead.body).toMatch(/check Orders, then review again/i)
    const lenient = resultCard({ kind: 'unknown', message: 'reset' }, { now, since: now })
    expect(lenient.retryDisabled).toBe(false)
  })
  it('retryExpired', () => {
    expect(retryExpired({ kind: 'unknown', message: '', retry_until: 100 }, 101_000)).toBe(true)
    expect(retryExpired({ kind: 'unknown', message: '', retry_until: 100 }, 99_000)).toBe(false)
    expect(retryExpired({ kind: 'unknown', message: '' }, 1e15)).toBe(false)
    expect(retryExpired(null, 1e15)).toBe(false)
  })
})

describe('F2 order checks verbatim', () => {
  it('alert_type, alertType and every string leaf of details objects', () => {
    const m = orderCheckMessages({
      alert_type: 'PDT',
      alertType: 'X_TYPE',
      pdt_alert_details: { title: 'Day trade limit', body: 'You have 3 day trades', count: 3, nested: { note: 'deep' } },
      details: { message: 'plain message' },
    })
    expect(m).toEqual(expect.arrayContaining(['PDT', 'X_TYPE', 'title: Day trade limit', 'body: You have 3 day trades', 'nested note: deep', 'plain message']))
    expect(new Set(m).size).toBe(m.length)
  })
  it('keeps nested message lines and falls back to compact JSON', () => {
    expect(orderCheckMessages({ alert_type: 'A', x_alert: { message: 'hi' } })).toEqual(['A', 'hi'])
    expect(orderCheckMessages({ weird: 5 })).toEqual(['{"weird":5}'])
  })
})

describe('F2 review rows', () => {
  it('adds time in force and session from the ticket when the echo lacks them', () => {
    const t = { kind: 'equity' as const, args: { account_number: 'A', symbol: 'X', side: 'buy', type: 'limit', time_in_force: 'gtc', market_hours: 'extended_hours' } }
    expect(withTicketRows([['symbol', 'X']], t)).toEqual([['symbol', 'X'], ['time in force', 'gtc'], ['session', 'extended_hours']])
    expect(withTicketRows([['time in force', 'gfd'], ['market hours', 'regular_hours']], t)).toEqual([['time in force', 'gfd'], ['market hours', 'regular_hours']])
  })
  it('approval limit_price may be a money object or a string', () => {
    const a = (lp: unknown): RhApproval => ({ approval_id: 'a', account_number: 'X1234', asset_class: 'ASSET_CLASS_EQUITY', state: 'APPROVAL_STATE_PENDING', proposed_order: { symbol: 'AAA', limit_price: lp } })
    expect(approvalSummary(a({ amount: '12.50', currency_code: 'USD' }), [])).toContain('@ 12.50 USD')
    expect(approvalSummary(a('12.50'), [])).toContain('@ 12.50')
  })
})

describe('F2/F3 order type and account', () => {
  const o = (type: string | null, trigger: string | null, stop: number | null): RhOrder => ({
    id: '1', asset: 'equity', symbol: 'A', side: 'buy', order_type: type, state: 'queued', trigger, quantity: 1, price: 10, stop_price: stop,
    average_price: null, dollar_based_amount: null, time_in_force: null, created_at: null, reject_reason: null, legs: [],
  })
  it('derives the user-facing type from type + trigger', () => {
    expect(orderTypeLabel(o('limit', 'immediate', null))).toBe('limit')
    expect(orderTypeLabel(o('market', 'immediate', null))).toBe('market')
    expect(orderTypeLabel(o('limit', 'stop', 5))).toBe('stop_limit')
    expect(orderTypeLabel(o('market', 'stop', 5))).toBe('stop_market')
    expect(orderTypeLabel(o('limit', null, null))).toBe('limit')
    expect(orderTypeLabel(o(null, null, null))).toBe('-')
    expect(orderStopText(o('limit', 'stop', 5))).toBe('stop 5.00')
    expect(orderStopText(o('limit', 'immediate', null))).toBe('')
    expect(orderStopText(o('market', 'stop', 0.8421))).toBe('stop 0.8421')
  })
  it('ticket account must be the selected agentic account', () => {
    const acct = (n: string, agentic: boolean) => ({ account_number: n, agentic_allowed: agentic }) as RhAccount
    const list = [acct('MAIN1', false), acct('AGEN2', true)]
    expect(ticketAccountProblem(list, 'AGEN2')).toBeNull()
    expect(ticketAccountProblem(list, 'MAIN1')).toMatch(/agent/i)
    expect(ticketAccountProblem(list, null)).toMatch(/select/i)
  })
})
