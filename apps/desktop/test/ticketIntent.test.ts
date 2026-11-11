import { describe, expect, it } from 'vitest'
import type { RhOptionPosition, RhOrder, RhPosition, RhQuote } from '../src/lib/api'
import { addEquityIntent, closeEquityIntent, closeOptionIntent, dollarPreset, intentFromOrder, optionClosePrice, priceText, qtyFromPercent, shareText } from '../src/lib/ticketIntent'

// SYNTHETIC data only.
const pos = (o: Partial<RhPosition> = {}): RhPosition => ({
  symbol: 'AAA', quantity: 40, average_buy_price: 12.34, shares_available_for_sells: 40, shares_held_for_sells: 0, ...o,
})
const quote = (o: Partial<RhQuote> = {}): RhQuote => ({ symbol: 'AAA', bid_price: 12.5, ask_price: 12.6, last_trade_price: 12.55, previous_close: 12, ...o })
const opt = (o: Partial<RhOptionPosition> = {}): RhOptionPosition => ({
  option_id: 'opt-1', chain_symbol: 'AAA', expiration_date: '2026-11-20', strike_price: 150, option_type: 'call', side: 'long', quantity: 2,
  average_price: 150, multiplier: 100, bid: 1.2, ask: 1.3, mark: 1.25, delta: 0.4, theta: -0.03, iv: 0.4, min_ticks: null, pending_buy: 0, pending_sell: 0, ...o,
})

describe('closeEquityIntent', () => {
  it('long: sell the shares available at the bid, as a limit', () => {
    expect(closeEquityIntent(pos(), quote())).toEqual({ kind: 'equity', symbol: 'AAA', side: 'sell', quantity: '40', orderType: 'limit', limit: '12.50', source: 'close' })
  })
  it('uses shares_available_for_sells, not the held total', () => {
    expect(closeEquityIntent(pos({ shares_available_for_sells: 25, shares_held_for_sells: 15 }), quote())!.quantity).toBe('25')
  })
  it('falls back to the quantity when availability is unknown; never exceeds the quantity', () => {
    expect(closeEquityIntent(pos({ shares_available_for_sells: null }), quote())!.quantity).toBe('40')
    expect(closeEquityIntent(pos({ shares_available_for_sells: 99 }), quote())!.quantity).toBe('40')
  })
  it('nothing available (all held by open sells): empty quantity, never the held total', () => {
    expect(closeEquityIntent(pos({ shares_available_for_sells: 0, shares_held_for_sells: 40 }), quote())!.quantity).toBe('')
  })
  it('short stock: buy to cover |quantity| at the ask', () => {
    const i = closeEquityIntent(pos({ quantity: -10, shares_available_for_sells: 0 }), quote())!
    expect(i).toMatchObject({ side: 'buy', quantity: '10', orderType: 'limit', limit: '12.60' })
  })
  it('zero or unknown quantity: nothing to close', () => {
    expect(closeEquityIntent(pos({ quantity: 0 }), quote())).toBeNull()
    expect(closeEquityIntent(pos({ quantity: null }), quote())).toBeNull()
  })
  it('market variant: no limit', () => {
    const i = closeEquityIntent(pos(), quote(), { market: true })!
    expect(i.orderType).toBe('market')
    expect('limit' in i).toBe(false)
  })
  it('no bid: falls back to the last trade; no quote at all: a limit order with an empty price', () => {
    expect(closeEquityIntent(pos(), quote({ bid_price: null }))!.limit).toBe('12.55')
    expect(closeEquityIntent(pos(), quote({ bid_price: 0 }))!.limit).toBe('12.55')
    const none = closeEquityIntent(pos(), undefined)!
    expect(none.orderType).toBe('limit')
    expect('limit' in none).toBe(false)
  })
  it('a fractional position can only be a market order (limit orders take whole shares)', () => {
    const i = closeEquityIntent(pos({ quantity: 2.5, shares_available_for_sells: 2.5 }), quote())!
    expect(i).toMatchObject({ side: 'sell', quantity: '2.5', orderType: 'market' })
    expect('limit' in i).toBe(false)
  })
  it('sub-dollar prices keep 4 decimals', () => {
    expect(closeEquityIntent(pos({ symbol: 'F' }), quote({ bid_price: 0.8421 }))!.limit).toBe('0.8421')
  })
})

describe('addEquityIntent', () => {
  it('long: buy at the ask, no quantity', () => {
    const i = addEquityIntent(pos(), quote())
    expect(i).toEqual({ kind: 'equity', symbol: 'AAA', side: 'buy', orderType: 'limit', limit: '12.60', source: 'add' })
    expect('quantity' in i).toBe(false)
  })
  it('short: sell at the bid', () => {
    expect(addEquityIntent(pos({ quantity: -5 }), quote())).toMatchObject({ side: 'sell', limit: '12.50' })
  })
})

describe('closeOptionIntent', () => {
  it('long: sell to close all contracts at the mid', () => {
    expect(closeOptionIntent(opt())).toEqual({
      kind: 'option', underlying: 'AAA', optionId: 'opt-1', side: 'sell', effect: 'close', quantity: '2', limit: '1.25', expiration: '2026-11-20', source: 'close',
    })
  })
  it('short: buy to close', () => {
    expect(closeOptionIntent(opt({ side: 'short', average_price: -80 }))).toMatchObject({ side: 'buy', effect: 'close', quantity: '2' })
  })
  it('the mid is rounded to the contract tick table', () => {
    const mt = { above_tick: 0.05, below_tick: 0.01, cutoff_price: 3 }
    expect(optionClosePrice({ bid: 3.1, ask: 3.2, mark: null, min_ticks: mt }, 'sell')).toBe('3.15')
    expect(optionClosePrice({ bid: 3.1, ask: 3.25, mark: null, min_ticks: mt }, 'sell')).toBe('3.20') // 3.175 -> nearest 0.05
    expect(optionClosePrice({ bid: 1.01, ask: 1.04, mark: null, min_ticks: mt }, 'sell')).toBe('1.03') // 1.025 -> 0.01 grid
  })
  it('no two-sided market: the mark, then the side touch, then nothing', () => {
    expect(optionClosePrice({ bid: 0, ask: 0, mark: 0.42, min_ticks: null }, 'sell')).toBe('0.42')
    expect(optionClosePrice({ bid: 0.4, ask: 0, mark: null, min_ticks: null }, 'sell')).toBe('0.40')
    expect(optionClosePrice({ bid: 0.4, ask: 0, mark: null, min_ticks: null }, 'buy')).toBeUndefined()
    expect(optionClosePrice({ bid: null, ask: null, mark: null, min_ticks: null }, 'sell')).toBeUndefined()
    const i = closeOptionIntent(opt({ bid: null, ask: null, mark: null }))!
    expect('limit' in i).toBe(false)
  })
  it('refuses rows it cannot close: no id, no expiry, no contracts', () => {
    expect(closeOptionIntent(opt({ option_id: '' }))).toBeNull()
    expect(closeOptionIntent(opt({ expiration_date: null }))).toBeNull()
    expect(closeOptionIntent(opt({ quantity: 0 }))).toBeNull()
  })
  it('a fractional contract count is left empty rather than guessed', () => {
    expect(closeOptionIntent(opt({ quantity: 1.5 }))!.quantity).toBe('')
  })
})

describe('qtyFromPercent', () => {
  it('floors to whole shares unless fractional is allowed', () => {
    expect(qtyFromPercent(25, 10, false)).toBe('2')
    expect(qtyFromPercent(75, 5, false)).toBe('3')
    expect(qtyFromPercent(25, 10, true)).toBe('2.5')
    expect(qtyFromPercent(33, 10, true)).toBe('3.3')
  })
  it('exact results are not lost to float error', () => {
    expect(qtyFromPercent(50, 40, false)).toBe('20')
    expect(qtyFromPercent(75, 40, false)).toBe('30')
    expect(qtyFromPercent(100, 7, false)).toBe('7')
    expect(qtyFromPercent(10, 30, false)).toBe('3')
  })
  it('never exceeds the base, even above 100 percent', () => {
    expect(qtyFromPercent(150, 8, false)).toBe('8')
    expect(qtyFromPercent(100, 2.5, true)).toBe('2.5')
    expect(qtyFromPercent(100, 2.5, false)).toBe('2')
  })
  it('zero results are empty (a 25 percent slice of 3 whole shares is 0)', () => {
    expect(qtyFromPercent(25, 3, false)).toBe('')
    expect(qtyFromPercent(0, 10, false)).toBe('')
    expect(qtyFromPercent(50, 0, false)).toBe('')
    expect(qtyFromPercent(50, -4, false)).toBe('')
    expect(qtyFromPercent(Number.NaN, 4, false)).toBe('')
    expect(qtyFromPercent(50, Number.NaN, false)).toBe('')
  })
  it('fractions stay within 6 decimals', () => {
    expect(qtyFromPercent(100, 1 / 3, true)).toBe('0.333333')
  })
})

describe('text helpers', () => {
  it('dollar presets and share text', () => {
    expect(dollarPreset(100)).toBe('100')
    expect(dollarPreset(1000)).toBe('1000')
    expect(dollarPreset(0)).toBe('')
    expect(dollarPreset(-5)).toBe('')
    expect(shareText(2.50)).toBe('2.5')
    expect(shareText(0)).toBe('')
    expect(priceText(0.5)).toBe('0.5000')
    expect(priceText(12.5)).toBe('12.50')
  })
})

const ord = (o: Partial<RhOrder> = {}): RhOrder => ({
  id: 'o1', asset: 'equity', symbol: 'MSFT', side: 'buy', order_type: 'limit', state: 'queued', trigger: 'immediate', quantity: 2, price: 300,
  stop_price: null, average_price: null, dollar_based_amount: null, time_in_force: 'gtc', created_at: null, reject_reason: null, legs: [], ...o,
})

describe('intentFromOrder (Cancel & edit)', () => {
  it('equity limit', () => {
    expect(intentFromOrder(ord())).toEqual({ kind: 'equity', symbol: 'MSFT', side: 'buy', orderType: 'limit', quantity: '2', limit: '300.00', source: 'edit' })
  })
  it('stop limit and stop market read the trigger', () => {
    expect(intentFromOrder(ord({ side: 'sell', trigger: 'stop', stop_price: 120, price: 118.5, quantity: 3 }))).toMatchObject({ orderType: 'stop_limit', stop: '120.00', limit: '118.50' })
    expect(intentFromOrder(ord({ order_type: 'market', trigger: 'stop', price: null, stop_price: 0.8421 }))).toMatchObject({ orderType: 'stop_market', stop: '0.8421' })
  })
  it('a dollar-sized order keeps its dollars', () => {
    expect(intentFromOrder(ord({ order_type: 'market', price: null, quantity: null, dollar_based_amount: 250 }))).toMatchObject({ dollars: '250', orderType: 'market' })
  })
  it('single-leg option order carries the contract', () => {
    const leg = { option_id: 'opt-9', side: 'sell', position_effect: 'close', ratio_quantity: 1, expiration_date: '2026-12-18', strike_price: 150, option_type: 'call' }
    expect(intentFromOrder(ord({ asset: 'option', symbol: 'AAA', side: 'credit', quantity: 2, price: 1.5, legs: [leg] }))).toEqual({
      kind: 'option', underlying: 'AAA', optionId: 'opt-9', side: 'sell', effect: 'close', quantity: '2', limit: '1.50', expiration: '2026-12-18', source: 'edit',
    })
  })
  it('multi-leg, leg-less and unknown-side orders cannot be edited', () => {
    const leg = { option_id: 'a', side: 'buy', position_effect: 'open', ratio_quantity: 1, expiration_date: null, strike_price: null, option_type: null }
    expect(intentFromOrder(ord({ asset: 'option', symbol: 'AAA', legs: [leg, { ...leg, option_id: 'b' }] }))).toBeNull()
    expect(intentFromOrder(ord({ asset: 'option', symbol: 'AAA', legs: [] }))).toBeNull()
    expect(intentFromOrder(ord({ side: 'credit' }))).toBeNull()
    expect(intentFromOrder(ord({ symbol: null }))).toBeNull()
    expect(intentFromOrder(ord({ asset: 'crypto' }))).toBeNull()
  })
})
