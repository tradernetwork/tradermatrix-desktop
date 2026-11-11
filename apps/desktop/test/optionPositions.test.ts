import { describe, expect, it } from 'vitest'
import type { RhOptionPosition } from '../src/lib/api'
import { dteOf, fmtStrike, optionLabel, optionPnl, sortOptionPositions } from '../src/lib/optionPositions'

// SYNTHETIC rows, labelled so: no real account data.
const row = (o: Partial<RhOptionPosition> = {}): RhOptionPosition => ({
  option_id: 'opt-1', chain_symbol: 'AAA', expiration_date: '2026-11-20', strike_price: 150, option_type: 'call', side: 'long',
  quantity: 2, average_price: 150, multiplier: 100, bid: 1.2, ask: 1.3, mark: 1.25, delta: 0.45, theta: -0.03, iv: 0.4,
  min_ticks: null, pending_buy: 0, pending_sell: 0, ...o,
})

describe('option position units (average_price = signed DOLLARS PER CONTRACT, quotes = per share)', () => {
  it('long: cost = avg x contracts, value = mark x multiplier x contracts', () => {
    // paid 1.50/share = 150.00 per contract, 2 contracts => cost 300; mark 1.25 => value 250; P&L -50 (-16.67%)
    const p = optionPnl(row())
    expect(p.avgPerShare).toBe(1.5)
    expect(p.cost).toBe(300)
    expect(p.value).toBe(250)
    expect(p.pnl).toBe(-50)
    expect(p.pnlPct).toBeCloseTo(-16.6667, 3)
  })
  it('long winner', () => {
    const p = optionPnl(row({ mark: 2 }))
    expect(p.value).toBe(400)
    expect(p.pnl).toBe(100)
    expect(p.pnlPct).toBeCloseTo(33.3333, 3)
  })
  it('short: the credit is NEGATIVE average_price; P&L = credit - cost to buy back', () => {
    // sold 1 contract at 0.80/share: average_price -80, mark 1.25 => value 125 => P&L 80 - 125 = -45 on 80 credit
    const p = optionPnl(row({ side: 'short', quantity: 1, average_price: -80 }))
    expect(p.avgPerShare).toBe(0.8)
    expect(p.cost).toBe(80)
    expect(p.value).toBe(125)
    expect(p.pnl).toBe(-45)
    expect(p.pnlPct).toBeCloseTo(-56.25, 3)
    // price falls to 0.30 => value 30 => +50 (62.5%)
    const w = optionPnl(row({ side: 'short', quantity: 1, average_price: -80, mark: 0.3 }))
    expect(w.pnl).toBe(50)
    expect(w.pnlPct).toBeCloseTo(62.5, 3)
  })
  it('a positive average_price on a short is read by magnitude (sign is not trusted)', () => {
    expect(optionPnl(row({ side: 'short', quantity: 1, average_price: 80, mark: 0.3 })).pnl).toBe(50)
  })
  it('honours the multiplier (e.g. an adjusted 10x contract)', () => {
    const p = optionPnl(row({ multiplier: 10, average_price: 15, quantity: 1, mark: 2 }))
    expect(p.avgPerShare).toBe(1.5)
    expect(p.value).toBe(20)
    expect(p.pnl).toBe(5)
  })
  it('null-safe: no mark => no value and no P&L; no average => no cost and no P&L', () => {
    const a = optionPnl(row({ mark: null }))
    expect(a.value).toBeNull()
    expect(a.pnl).toBeNull()
    expect(a.pnlPct).toBeNull()
    expect(a.cost).toBe(300)
    const b = optionPnl(row({ average_price: null }))
    expect(b.avgPerShare).toBeNull()
    expect(b.cost).toBeNull()
    expect(b.pnl).toBeNull()
    expect(b.value).toBe(250)
  })
  it('zero cost basis gives no percent', () => {
    expect(optionPnl(row({ average_price: 0 })).pnlPct).toBeNull()
  })
})

describe('labels, DTE and sorting', () => {
  it('SYM date strike C/P, trimmed strike, ? for unknowns', () => {
    expect(optionLabel(row())).toBe('AAA 2026-11-20 150 C')
    expect(optionLabel(row({ strike_price: 7.5, option_type: 'put' }))).toBe('AAA 2026-11-20 7.5 P')
    expect(optionLabel(row({ strike_price: null, option_type: null, expiration_date: null }))).toBe('AAA ? ? ?')
    expect(fmtStrike(150)).toBe('150')
    expect(fmtStrike(152.25)).toBe('152.25')
    expect(fmtStrike(null)).toBe('?')
  })
  it('DTE counts calendar days from the local date', () => {
    const now = new Date(2026, 10, 11, 15, 30) // 2026-11-11 local
    expect(dteOf('2026-11-11', now)).toBe(0)
    expect(dteOf('2026-11-20', now)).toBe(9)
    expect(dteOf('2026-11-10', now)).toBe(-1)
    expect(dteOf('2027-01-15', now)).toBe(65)
    expect(dteOf(null, now)).toBeNull()
    expect(dteOf('soon', now)).toBeNull()
  })
  it('sorted by expiry, then strike, then symbol; unknowns last; the input is not mutated', () => {
    const rows = [
      row({ option_id: 'e', expiration_date: null, strike_price: 1 }),
      row({ option_id: 'd', expiration_date: '2026-12-18', strike_price: 100 }),
      row({ option_id: 'c', expiration_date: '2026-11-20', strike_price: 160 }),
      row({ option_id: 'b', expiration_date: '2026-11-20', strike_price: 150, chain_symbol: 'ZZZ' }),
      row({ option_id: 'a', expiration_date: '2026-11-20', strike_price: 150 }),
      row({ option_id: 'f', expiration_date: '2026-11-20', strike_price: null }),
    ]
    const before = rows.map((r) => r.option_id).join('')
    expect(sortOptionPositions(rows).map((r) => r.option_id).join('')).toBe('abcfde')
    expect(rows.map((r) => r.option_id).join('')).toBe(before)
  })
})
