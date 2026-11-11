import { describe, expect, it } from 'vitest'
import type { RhAccount, RhOptionPosition, RhOptionRow, RhPosition } from '../src/lib/api'
import {
  estimateLine, fillDisabledReason, fmtSignedMoney, locateContract, noPositionNote, optionChips, optionPositionLine, parseSession, parseTif,
  positionLine, sellQtyProblem, stepPrice,
} from '../src/lib/ticketUi'

const pos = (o: Partial<RhPosition> = {}): RhPosition => ({ symbol: 'AAA', quantity: 40, average_buy_price: 12.34, shares_available_for_sells: 40, shares_held_for_sells: 0, ...o })
const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'SYN00000001', rhs_account_number: null, rhc_account_number: null, agentic_allowed: false, option_level: null,
  kind: 'margin', is_default: false, unsettled_funds: null, nickname: null, brokerage_account_type: null, ...o,
})

describe('position line', () => {
  it('long with P&L', () => {
    // (13.72 - 12.34) * 40 = 55.20
    expect(positionLine(pos(), 13.72)).toBe('Long 40 @ 12.34, P&L +$55.20')
  })
  it('loss, short and unknown last', () => {
    expect(positionLine(pos(), 12)).toBe('Long 40 @ 12.34, P&L -$13.60')
    expect(positionLine(pos({ quantity: -10, average_buy_price: 5 }), 4)).toBe('Short 10 @ 5.00, P&L +$10.00')
    expect(positionLine(pos(), null)).toBe('Long 40 @ 12.34')
  })
  it('no position', () => {
    expect(positionLine(undefined, 1)).toBe('No position')
    expect(positionLine(pos({ quantity: 0 }), 1)).toBe('No position')
    expect(positionLine(pos({ quantity: null }), 1)).toBe('No position')
  })
  it('signed money', () => {
    expect(fmtSignedMoney(0)).toBe('$0.00')
    expect(fmtSignedMoney(0.001)).toBe('$0.00')
    expect(fmtSignedMoney(5)).toBe('+$5.00')
    expect(fmtSignedMoney(-5)).toBe('-$5.00')
    expect(fmtSignedMoney(null)).toBe('-')
  })
  it('option contract line uses per-share average', () => {
    const o: RhOptionPosition = {
      option_id: 'x', chain_symbol: 'AAA', expiration_date: '2026-11-20', strike_price: 150, option_type: 'call', side: 'long', quantity: 2,
      average_price: 150, multiplier: 100, bid: 1.2, ask: 1.3, mark: 2, delta: null, theta: null, iv: null, min_ticks: null, pending_buy: null, pending_sell: null,
    }
    expect(optionPositionLine(o)).toBe('Long 2 @ 1.50, P&L +$100.00')
    expect(optionPositionLine({ ...o, side: 'short', average_price: -150 })).toBe('Short 2 @ 1.50, P&L -$100.00')
    expect(optionPositionLine(undefined)).toBe('No position')
  })
})

describe('price steps', () => {
  it('steps by one tick without float noise', () => {
    expect(stepPrice('3.05', 1, 0.05)).toBe('3.10')
    expect(stepPrice('3.05', -1, 0.05)).toBe('3.00')
    expect(stepPrice('12.50', 1, 0.01)).toBe('12.51')
    expect(stepPrice('0.10', -1, 0.01)).toBe('0.09')
    expect(stepPrice('1', 1, 0.01)).toBe('1.01')
    expect(stepPrice('0.8421', 1, 0.0001)).toBe('0.8422')
  })
  it('never reaches zero or below; junk and empty are returned unchanged', () => {
    expect(stepPrice('0.01', -1, 0.01)).toBe('0.01')
    expect(stepPrice('0.05', -1, 0.05)).toBe('0.05')
    expect(stepPrice('', 1, 0.01)).toBe('')
    expect(stepPrice('abc', 1, 0.01)).toBe('abc')
    expect(stepPrice('-1', 1, 0.01)).toBe('-1')
    expect(stepPrice('1e3', 1, 0.01)).toBe('1e3')
  })
})

describe('sell quantity check', () => {
  it('blocks a sell above shares_available_for_sells and says why', () => {
    const p = pos({ shares_available_for_sells: 25, shares_held_for_sells: 15 })
    expect(sellQtyProblem('sell', '26', p)).toMatch(/only 25 shares are available.*15 held by open sell orders/)
    expect(sellQtyProblem('sell', '25', p)).toBeNull()
    expect(sellQtyProblem('sell', '1', pos({ shares_available_for_sells: 0 }))).toMatch(/only 0 shares/)
  })
  it('falls back to the held quantity when availability is unknown', () => {
    expect(sellQtyProblem('sell', '41', pos({ shares_available_for_sells: null }))).not.toBeNull()
    expect(sellQtyProblem('sell', '40', pos({ shares_available_for_sells: null }))).toBeNull()
  })
  it('buys, empty/invalid quantities and unknown positions are never blocked here', () => {
    expect(sellQtyProblem('buy', '999', pos())).toBeNull()
    expect(sellQtyProblem('sell', '', pos())).toBeNull()
    expect(sellQtyProblem('sell', 'abc', pos())).toBeNull()
    expect(sellQtyProblem('sell', '5', undefined)).toBeNull()
  })
  it('selling with no position is a soft note, only once positions have loaded', () => {
    expect(noPositionNote('sell', undefined, true)).toMatch(/short sale/)
    expect(noPositionNote('sell', undefined, false)).toBeNull()
    expect(noPositionNote('sell', pos(), true)).toBeNull()
    expect(noPositionNote('buy', undefined, true)).toBeNull()
  })
})

describe('estimate line', () => {
  const base = { bid: 99, ask: 101, last: 100, buyingPower: 5000 }
  it('buy at the ask, sell at the bid, limit wins', () => {
    expect(estimateLine({ ...base, side: 'buy', quantity: '10' })).toBe('est. cost $1,010.00 | buying power $5,000.00')
    expect(estimateLine({ ...base, side: 'sell', quantity: '10' })).toBe('est. proceeds $990.00 | buying power $5,000.00')
    expect(estimateLine({ ...base, side: 'buy', quantity: '10', limit: '95.50' })).toBe('est. cost $955.00 | buying power $5,000.00')
  })
  it('flags a buy above buying power; never a sell', () => {
    expect(estimateLine({ ...base, side: 'buy', quantity: '100' })).toMatch(/over buying power/)
    expect(estimateLine({ ...base, side: 'sell', quantity: '100' })).not.toMatch(/over/)
  })
  it('dollar orders use the amount; options multiply by 100', () => {
    expect(estimateLine({ ...base, side: 'buy', quantity: '', dollars: '250' })).toBe('est. cost $250.00 | buying power $5,000.00')
    expect(estimateLine({ side: 'buy', quantity: '2', limit: '1.25', bid: null, ask: null, last: null, buyingPower: 100, multiplier: 100 })).toBe('est. cost $250.00 | buying power $100.00 (over buying power)')
  })
  it('nothing known: null; only buying power: just that', () => {
    expect(estimateLine({ side: 'buy', quantity: '', bid: null, ask: null, last: null, buyingPower: null })).toBeNull()
    expect(estimateLine({ side: 'buy', quantity: '', bid: null, ask: null, last: null, buyingPower: 12 })).toBe('buying power $12.00')
  })
  it('no price anywhere: no cost estimate', () => {
    expect(estimateLine({ side: 'buy', quantity: '5', bid: null, ask: null, last: null, buyingPower: 12 })).toBe('buying power $12.00')
  })
})

describe('fill gate and remembered settings', () => {
  it('fills are disabled with the same reasons as the ticket', () => {
    expect(fillDisabledReason(false, [], null)).toMatch(/Connect Robinhood/)
    expect(fillDisabledReason(true, [acct({})], 'SYN00000001')).toMatch(/No agentic account/)
    expect(fillDisabledReason(true, [acct({ agentic_allowed: true })], null)).toMatch(/Select an account/)
    expect(fillDisabledReason(true, [acct({}), acct({ account_number: 'AGEN0002', agentic_allowed: true })], 'SYN00000001')).toMatch(/not enabled for agent trading/)
    expect(fillDisabledReason(true, [acct({ agentic_allowed: true })], 'SYN00000001')).toBeNull()
  })
  it('tif and session are validated on load', () => {
    expect(parseTif('gtc')).toBe('gtc')
    expect(parseTif('gfd')).toBe('gfd')
    expect(parseTif('ioc')).toBeNull()
    expect(parseTif(null)).toBeNull()
    expect(parseTif('')).toBeNull()
    expect(parseSession('extended_hours')).toBe('extended_hours')
    expect(parseSession('regular_hours')).toBe('regular_hours')
    expect(parseSession('overnight')).toBeNull()
    expect(parseSession(undefined)).toBeNull()
  })
})

describe('contract location and option chips', () => {
  const row = (id: string, chain: string, strike: number | null, type: string | null): RhOptionRow => ({
    instrument: { id, chain_id: chain, expiration_date: '2026-11-20', strike_price: strike, option_type: type },
    quote: null,
  })
  it('matches by instrument id (case-insensitive) and reports its chain, type and strike', () => {
    const rows = [row('AAAA', 'c1', 150, 'call'), row('BBBB', 'c2', 150, 'put')]
    expect(locateContract(rows, 'bbbb')).toEqual({ chainId: 'c2', type: 'put', strike: 150 })
    expect(locateContract(rows, 'zzzz')).toBeNull()
    expect(locateContract([row('X', 'c1', null, 'call')], 'X')).toBeNull()
    expect(locateContract([row('X', 'c1', 5, null)], 'X')).toBeNull()
  })
  it('chips: bid, ask, mid; the mark stands in when the market is one-sided', () => {
    const q = (o: object) => ({ instrument_id: 'x', bid: null, ask: null, mark: null, delta: null, gamma: null, theta: null, vega: null, rho: null, implied_volatility: null, open_interest: null, volume: null, ...o })
    expect(optionChips(q({ bid: 1.2, ask: 1.3, mark: 1.25 }))).toEqual({ bid: 1.2, ask: 1.3, mid: expect.closeTo(1.25, 6) })
    expect(optionChips(q({ bid: 0, ask: 1.3, mark: 0.65 }))).toEqual({ ask: 1.3, mid: 0.65 })
    expect(optionChips(q({}))).toEqual({})
    expect(optionChips(null)).toEqual({})
  })
})
