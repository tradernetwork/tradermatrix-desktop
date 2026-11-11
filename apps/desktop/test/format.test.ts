import { describe, expect, it } from 'vitest'
import type { RhAccount, RhPosition } from '../src/lib/api'
import { accountLabel, defaultAccount, fmtMoney, fmtNum, fmtPct, fmtQty, maskAccount, pnlClass, positionRow, secretsPill } from '../src/lib/format'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'SYN00000001',
  rhs_account_number: null,
  rhc_account_number: null,
  agentic_allowed: false,
  option_level: null,
  kind: null,
  is_default: false,
  unsettled_funds: null,
  nickname: null,
  brokerage_account_type: null,
  ...o,
})
const pos = (o: Partial<RhPosition>): RhPosition => ({
  symbol: 'AAA',
  quantity: 10,
  average_buy_price: 100,
  shares_available_for_sells: null,
  shares_held_for_sells: null,
  ...o,
})

describe('position P&L math', () => {
  it('long: (last - avg) * qty and percent of cost', () => {
    const r = positionRow(pos({ quantity: 10, average_buy_price: 100.5 }), 101.25)
    expect(r.pnl).toBeCloseTo(7.5, 10)
    expect(r.pnlPct).toBeCloseTo((7.5 / 1005) * 100, 10)
    expect(r.value).toBeCloseTo(1012.5, 10)
  })
  it('loser is negative', () => {
    const r = positionRow(pos({ quantity: 100, average_buy_price: 5.25 }), 5)
    expect(r.pnl).toBeCloseTo(-25, 10)
    expect(r.pnlPct).toBeCloseTo(-4.7619, 3)
  })
  it('short: gains when price falls', () => {
    const r = positionRow(pos({ quantity: -10, average_buy_price: 100 }), 90)
    expect(r.pnl).toBeCloseTo(100, 10)
    expect(r.pnlPct).toBeCloseTo(10, 10)
  })
  it('missing last, missing cost or zero cost gives nulls, never NaN', () => {
    expect(positionRow(pos({}), null)).toMatchObject({ pnl: null, pnlPct: null, value: null })
    expect(positionRow(pos({ average_buy_price: null }), 5)).toMatchObject({ pnl: null, pnlPct: null })
    expect(positionRow(pos({ average_buy_price: 0 }), 5).pnlPct).toBeNull()
    expect(positionRow(pos({ quantity: null }), 5)).toMatchObject({ pnl: null, value: null })
  })
  it('colors by sign', () => {
    expect(pnlClass(1)).toBe('bull')
    expect(pnlClass(-1)).toBe('bear')
    expect(pnlClass(0)).toBe('')
    expect(pnlClass(null)).toBe('')
  })
})

describe('formatting', () => {
  it('handles null, thousands, sign', () => {
    expect(fmtNum(null)).toBe('-')
    expect(fmtNum(1234.5)).toBe('1,234.50')
    expect(fmtMoney(-12.3)).toBe('-$12.30')
    expect(fmtMoney(1000000)).toBe('$1,000,000.00')
    expect(fmtPct(1.234)).toBe('+1.23%')
    expect(fmtPct(-0.4)).toBe('-0.40%')
    expect(fmtPct(NaN)).toBe('-')
    expect(fmtQty(2.5)).toBe('2.5')
    expect(fmtQty(10)).toBe('10')
  })
})

describe('account picker', () => {
  it('defaults to the agentic_allowed account, then default, then first', () => {
    const a = acct({ account_number: 'A1', is_default: true })
    const b = acct({ account_number: 'B2', agentic_allowed: true })
    expect(defaultAccount([a, b])?.account_number).toBe('B2')
    expect(defaultAccount([acct({ account_number: 'X1' }), a])?.account_number).toBe('A1')
    expect(defaultAccount([acct({ account_number: 'X1' }), acct({ account_number: 'Y2' })])?.account_number).toBe('X1')
    expect(defaultAccount([])).toBeUndefined()
  })
  it('labels the agentic account and masks the number', () => {
    expect(maskAccount('SYN00001234')).toBe('••••1234')
    const l = accountLabel(acct({ account_number: 'SYN00001234', kind: 'limited_margin', agentic_allowed: true }))
    expect(l).toContain('[agentic]')
    expect(l).toContain('1234')
    expect(l).not.toContain('SYN0000')
    expect(accountLabel(acct({ is_default: true }))).toContain('(default)')
    expect(accountLabel(acct({}))).not.toContain('[agentic]')
  })
})

describe('secrets pill reads the vault state', () => {
  const be = (o: object) => ({ available: false, backend: 'vault', detail: 'd', ...o })
  it('vault backend', () => {
    expect(secretsPill(be({}), { exists: true, unlocked: true, backend: 'vault' })).toMatchObject({ text: 'secrets: vault unlocked', cls: 'ok' })
    expect(secretsPill(be({}), { exists: true, unlocked: false, backend: 'vault' })).toMatchObject({ text: 'secrets: vault locked', cls: 'warn' })
    expect(secretsPill(be({}), { exists: false, unlocked: false, backend: 'vault' })).toMatchObject({ text: 'secrets: vault not created', cls: 'warn' })
  })
  it('keyring backend and unknown', () => {
    expect(secretsPill(be({ backend: 'secret-service', available: true }), { exists: false, unlocked: false, backend: 'secret-service' })).toMatchObject({
      text: 'secrets: secret-service',
      cls: 'ok',
    })
    expect(secretsPill(null, null).text).toBe('secrets: ...')
    expect(secretsPill(be({ backend: 'x', available: false }), null).text).toBe('secrets: unavailable')
  })
})
