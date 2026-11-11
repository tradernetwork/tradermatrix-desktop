import { describe, expect, it } from 'vitest'
import type { EquityOrderArgs, OptionOrderArgs } from '../src/lib/api'
import { isAccount, isDecimal, isSymbol, isUuid, validateEquity, validateOption } from '../src/lib/orderValidation'

// Same case table as the Rust tests in src-tauri/src/rh/orders.rs. Rust stays authoritative.

describe('grammar helpers', () => {
  it('decimals follow the exact grammar', () => {
    for (const ok of ['1', '0.5', '100', '100.50', '0.00000001', '007', '12345.12345678']) expect(isDecimal(ok), ok).toBe(true)
    for (const bad of [
      '', '-1', '+1', '1e3', '1E3', '0', '0.0', '0.00000000', ' 5', '5 ', 'NaN', 'inf', 'Infinity',
      '1.123456789', '.5', '5.', '1,5', '0x10', '１', '1_0', '--1', '1.2.3', '5\n',
    ])
      expect(isDecimal(bad), JSON.stringify(bad)).toBe(false)
  })
  it('symbols follow the exact grammar', () => {
    for (const ok of ['A', 'AAPL', 'BRK.B', 'BF-B', 'A1', 'ABCDEFGHIJ']) expect(isSymbol(ok), ok).toBe(true)
    for (const bad of ['', 'aapl', 'Aapl', 'A B', '1ABC', '.A', '-A', 'ABCDEFGHIJK', 'AA PL', 'AAPL\n', 'A;B', 'A/B', 'ÅB'])
      expect(isSymbol(bad), JSON.stringify(bad)).toBe(false)
  })
  it('accounts are alphanumeric 1..64, uuids are 8-4-4-4-12 hex', () => {
    expect(isAccount('SYN00000002')).toBe(true)
    for (const bad of ['', 'SYN 1', 'SYN-1', 'x'.repeat(65)]) expect(isAccount(bad)).toBe(false)
    expect(isUuid('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toBe(true)
    for (const bad of ['12345', '{11111111-2222-4333-8444-555555555555}', '11111111222243338444555555555555', 'g1111111-2222-4333-8444-555555555555'])
      expect(isUuid(bad)).toBe(false)
  })
})

type Over<T> = { [K in keyof T]?: T[K] | null }
const eq = (o: Over<EquityOrderArgs> = {}): EquityOrderArgs => {
  const base: EquityOrderArgs = {
    account_number: 'SYN00000002', symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '1', limit_price: '100.50',
  }
  const m = { ...base, ...o } as Record<string, unknown>
  for (const k of Object.keys(m)) if (m[k] === null) delete m[k]
  return m as unknown as EquityOrderArgs
}
const market = { type: 'market', limit_price: null } as const

describe('validateEquity', () => {
  const valid: Array<[string, EquityOrderArgs]> = [
    ['plain limit', eq()],
    ['gtc extended limit', eq({ time_in_force: 'gtc', market_hours: 'extended_hours' })],
    ['all day limit', eq({ market_hours: 'all_day_hours' })],
    ['sell', eq({ side: 'sell' })],
    ['BRK.B', eq({ symbol: 'BRK.B' })],
    ['market qty', eq(market)],
    ['fractional market regular', eq({ ...market, quantity: '0.5' })],
    ['six decimals fractional', eq({ ...market, quantity: '0.123456' })],
    ['dollar amount keeps eight decimals', eq({ ...market, quantity: undefined, dollar_amount: '10.12345678' })],
    ['dollar market', eq({ ...market, quantity: null, dollar_amount: '100.00' })],
    ['dollar market explicit regular', eq({ ...market, quantity: null, dollar_amount: '5', market_hours: 'regular_hours' })],
    ['stop_market', eq({ type: 'stop_market', limit_price: null, stop_price: '90' })],
    ['stop_limit', eq({ type: 'stop_limit', stop_price: '90' })],
    ['integer limit extended', eq({ market_hours: 'extended_hours', quantity: '3' })],
  ]
  it.each(valid)('valid: %s', (_n, a) => expect(validateEquity(a)).toBeNull())

  const invalid: Array<[string, EquityOrderArgs]> = [
    ['empty account', eq({ account_number: '' })],
    ['account with space', eq({ account_number: 'SYN 1' })],
    ['account with dash', eq({ account_number: 'SYN-1' })],
    ['lowercase symbol', eq({ symbol: 'aapl' })],
    ['symbol with space', eq({ symbol: 'A B' })],
    ['empty symbol', eq({ symbol: '' })],
    ['bad side', eq({ side: 'BUY' })],
    ['bad type', eq({ type: 'trailing_stop' })],
    ['neither qty nor dollars', eq({ quantity: null })],
    ['both qty and dollars', eq({ ...market, dollar_amount: '10' })],
    ['dollar with limit', eq({ quantity: null, dollar_amount: '10' })],
    ['dollar with stop_market', eq({ type: 'stop_market', limit_price: null, stop_price: '9', quantity: null, dollar_amount: '10' })],
    ['dollar market extended', eq({ ...market, quantity: null, dollar_amount: '10', market_hours: 'extended_hours' })],
    ['limit without price', eq({ limit_price: null })],
    ['stop_limit without limit', eq({ type: 'stop_limit', limit_price: null, stop_price: '9' })],
    ['stop_limit without stop', eq({ type: 'stop_limit' })],
    ['stop_market without stop', eq({ type: 'stop_market', limit_price: null })],
    ['limit with stop price', eq({ stop_price: '9' })],
    ['market with limit price', eq({ type: 'market' })],
    ['market extended', eq({ ...market, market_hours: 'extended_hours' })],
    ['stop_market all day', eq({ type: 'stop_market', limit_price: null, stop_price: '9', market_hours: 'all_day_hours' })],
    ['stop_limit extended', eq({ type: 'stop_limit', stop_price: '9', market_hours: 'extended_hours' })],
    ['fractional limit', eq({ quantity: '0.5' })],
    ['fractional market extended', eq({ ...market, quantity: '0.5', market_hours: 'extended_hours' })],
    ['bad tif', eq({ time_in_force: 'ioc' })],
    ['bad session', eq({ market_hours: 'overnight' })],
    ['qty empty', eq({ quantity: '' })],
    ['qty negative', eq({ quantity: '-1' })],
    ['qty zero', eq({ quantity: '0' })],
    ['qty exponent', eq({ quantity: '1e3' })],
    ['qty leading space', eq({ quantity: ' 5' })],
    ['qty NaN', eq({ quantity: 'NaN' })],
    ['qty too many decimals', eq({ quantity: '1.123456789' })],
    ['qty seven decimals (equity limit is six)', eq({ ...market, quantity: '1.1234567' })],
    ['limit price zero', eq({ limit_price: '0' })],
    ['limit price negative', eq({ limit_price: '-1' })],
    ['limit price exponent', eq({ limit_price: '1e2' })],
    ['stop price NaN', eq({ type: 'stop_limit', stop_price: 'NaN' })],
  ]
  it.each(invalid)('invalid: %s', (_n, a) => {
    const m = validateEquity(a)
    expect(m, _n).not.toBeNull()
    expect(typeof m).toBe('string')
  })
})

const UUID_A = '11111111-2222-4333-8444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const leg = (id: string, side: string, eff: string, ratio = 1) => ({ option_id: id, side, position_effect: eff, ratio_quantity: ratio })
const op = (o: Over<OptionOrderArgs> = {}): OptionOrderArgs => {
  const base = { account_number: 'SYN00000002', legs: [leg(UUID_A, 'buy', 'open')], quantity: '1', price: '1.50' }
  const m = { ...base, ...o } as Record<string, unknown>
  for (const k of Object.keys(m)) if (m[k] === null) delete m[k]
  return m as unknown as OptionOrderArgs
}
const two = [leg(UUID_A, 'buy', 'open'), leg(UUID_B, 'sell', 'open')]

describe('validateOption', () => {
  const valid: Array<[string, OptionOrderArgs]> = [
    ['single limit', op()],
    ['single limit gtc', op({ time_in_force: 'gtc' })],
    ['single sell to close', op({ legs: [leg(UUID_A, 'sell', 'close')] })],
    ['single with consistent debit', op({ direction: 'debit' })],
    ['single sell with credit', op({ legs: [leg(UUID_A, 'sell', 'open')], direction: 'credit' })],
    ['uppercase uuid', op({ legs: [leg('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', 'buy', 'open')] })],
    ['explicit limit type', op({ type: 'limit' })],
    ['market gfd', op({ type: 'market', price: null })],
    ['stop_limit', op({ type: 'stop_limit', stop_price: '1.00' })],
    ['stop_market', op({ type: 'stop_market', price: null, stop_price: '1' })],
    ['two-leg debit', op({ legs: two, direction: 'debit' })],
    ['four legs credit', op({ direction: 'credit', legs: [1, 2, 3, 4].map((i) => leg(`00000000-0000-4000-8000-00000000000${i}`, i % 2 ? 'buy' : 'sell', 'open')) })],
    ['ratio 2', op({ legs: [leg(UUID_A, 'buy', 'open', 2)] })],
    ['curb session on limit', op({ market_hours: 'regular_curb_hours' })],
    ['overnight curb on limit', op({ market_hours: 'regular_curb_overnight_hours' })],
    ['quantity 10', op({ quantity: '10' })],
  ]
  it.each(valid)('valid: %s', (_n, a) => expect(validateOption(a)).toBeNull())

  const invalid: Array<[string, OptionOrderArgs]> = [
    ['empty account', op({ account_number: '' })],
    ['zero legs', op({ legs: [] })],
    ['five legs', op({ direction: 'debit', legs: [1, 2, 3, 4, 5].map((i) => leg(`00000000-0000-4000-8000-00000000000${i}`, 'buy', 'open')) })],
    ['duplicate legs', op({ legs: [leg(UUID_A, 'buy', 'open'), leg(UUID_A, 'sell', 'open')], direction: 'debit' })],
    ['duplicate legs differing in case', op({ legs: [leg('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', 'buy', 'open'), leg('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'sell', 'open')], direction: 'debit' })],
    ['option id not a uuid', op({ legs: [leg('12345', 'buy', 'open')] })],
    ['option id url', op({ legs: [leg(`https://api.robinhood.com/options/instruments/${UUID_A}/`, 'buy', 'open')] })],
    ['option id braces', op({ legs: [leg(`{${UUID_A}}`, 'buy', 'open')] })],
    ['option id no dashes', op({ legs: [leg('11111111222243338444555555555555', 'buy', 'open')] })],
    ['option id non-hex', op({ legs: [leg('g1111111-2222-4333-8444-555555555555', 'buy', 'open')] })],
    ['bad leg side', op({ legs: [leg(UUID_A, 'BUY', 'open')] })],
    ['bad position effect', op({ legs: [leg(UUID_A, 'buy', 'opening')] })],
    ['ratio zero', op({ legs: [leg(UUID_A, 'buy', 'open', 0)] })],
    ['ratio fractional', op({ legs: [leg(UUID_A, 'buy', 'open', 1.5)] })],
    ['quantity empty', op({ quantity: '' })],
    ['quantity fractional', op({ quantity: '1.5' })],
    ['quantity 1.0', op({ quantity: '1.0' })],
    ['quantity zero', op({ quantity: '0' })],
    ['quantity negative', op({ quantity: '-1' })],
    ['quantity exponent', op({ quantity: '1e1' })],
    ['quantity space', op({ quantity: ' 1' })],
    ['bad type', op({ type: 'trailing' })],
    ['limit without price', op({ price: null })],
    ['limit price zero', op({ price: '0' })],
    ['limit price exponent', op({ price: '1e0' })],
    ['limit with stop price', op({ stop_price: '1' })],
    ['market with price', op({ type: 'market' })],
    ['market gtc', op({ type: 'market', price: null, time_in_force: 'gtc' })],
    ['market curb', op({ type: 'market', price: null, market_hours: 'regular_curb_hours' })],
    ['stop_limit without stop', op({ type: 'stop_limit' })],
    ['stop_limit without price', op({ type: 'stop_limit', price: null, stop_price: '1' })],
    ['stop_market without stop', op({ type: 'stop_market', price: null })],
    ['stop_market with price', op({ type: 'stop_market', stop_price: '1' })],
    ['multi-leg market', op({ legs: two, direction: 'debit', type: 'market', price: null })],
    ['multi-leg stop_limit', op({ legs: two, direction: 'debit', type: 'stop_limit', stop_price: '1' })],
    ['multi-leg without direction', op({ legs: two })],
    ['multi-leg bad direction', op({ legs: two, direction: 'net' })],
    ['single leg inconsistent direction', op({ direction: 'credit' })],
    ['bad tif', op({ time_in_force: 'day' })],
    ['bad session', op({ market_hours: 'extended_hours' })],
    ['stop_limit in curb', op({ type: 'stop_limit', stop_price: '1', market_hours: 'regular_curb_hours' })],
  ]
  it.each(invalid)('invalid: %s', (_n, a) => {
    const m = validateOption(a)
    expect(m, _n).not.toBeNull()
    expect(typeof m).toBe('string')
  })
})
