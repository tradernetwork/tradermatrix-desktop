import { describe, expect, it } from 'vitest'
import type { EquityOrderArgs, OptionOrderArgs } from '../src/lib/api'
import { DEFAULT_HELPER, draftFields, helperView, type HelperCtx, type HelperInputs } from '../src/lib/riskHelper'
import { perShareRisk } from '../src/lib/riskSizing'

// M18 Task 5. INFORMATIONAL ONLY: the helper turns typed numbers into text and (on "Use") a quantity string. It never sees a ticket.

const ctx = (o: Partial<HelperCtx> = {}): HelperCtx => ({ equity: 25000, entryHint: null, creditHint: null, increment: 1, defaultStopMult: 2, ...o })
const eq = (o: Partial<HelperInputs> = {}): HelperInputs => ({ ...DEFAULT_HELPER, kind: 'equity', symbol: 'AAA', side: 'buy', riskPct: '1', entry: '100', stop: '95', touched: true, ...o })
const op = (o: Partial<HelperInputs> = {}): HelperInputs => ({ ...DEFAULT_HELPER, kind: 'option', symbol: 'AAA', side: 'sell', basis: 'spread_max_loss', width: '5', credit: '1.2', riskUsd: '1000', mode: 'usd', touched: true, ...o })

describe('perShareRisk (extracted from sizeEquity)', () => {
  it('long below entry, short above, errors otherwise', () => {
    expect(perShareRisk(100, 95, 'long')).toEqual({ value: 5 })
    expect(perShareRisk(100, 104, 'short')).toEqual({ value: 4 })
    expect(perShareRisk(100, 100, 'long')).toHaveProperty('error')
    expect(perShareRisk(100, 101, 'long')).toHaveProperty('error')
    expect(perShareRisk(100, 99, 'short')).toHaveProperty('error')
    expect(perShareRisk(100, Number.NaN, 'long')).toHaveProperty('error')
    expect(perShareRisk(Number.NaN, 95, 'long')).toHaveProperty('error')
  })
})

describe('helperView: equity', () => {
  it('25000 at 1%, entry 100, stop 95 -> $250 R, 1.00% of equity, 50 shares, Use fills "50"', () => {
    const v = helperView(eq(), ctx())
    expect(v.error).toBeNull()
    expect(v.useQty).toBe('50')
    const rows = Object.fromEntries(v.rows.map((r) => [r.label, r.value]))
    expect(rows['Shares']).toBe('50')
    expect(rows['Risk (1R)']).toBe('$250.00')
    expect(rows['% of equity']).toBe('1.00%')
    expect(rows['Equity']).toBe('$25,000.00')
  })
  it('no stop -> "enter a stop", no quantity', () => {
    const v = helperView(eq({ stop: '' }), ctx())
    expect(v.useQty).toBeNull()
    expect(v.error).toMatch(/stop/i)
  })
  it('stop at or beyond entry for the side -> error text, no quantity (Review Focus 1)', () => {
    expect(helperView(eq({ stop: '100' }), ctx()).useQty).toBeNull()
    expect(helperView(eq({ stop: '101' }), ctx()).error).toMatch(/below/)
    expect(helperView(eq({ side: 'sell', stop: '99' }), ctx()).error).toMatch(/above/)
    expect(helperView(eq({ side: 'sell', stop: '104' }), ctx()).useQty).toBe('62') // 250 / 4
  })
  it('equity missing: says "equity unavailable" and "-" for the percent; flat dollars still size', () => {
    const pct = helperView(eq(), ctx({ equity: null }))
    expect(pct.useQty).toBeNull()
    expect(pct.error).toMatch(/equity unavailable/i)
    const usd = helperView(eq({ mode: 'usd', riskUsd: '250' }), ctx({ equity: null }))
    expect(usd.useQty).toBe('50')
    const rows = Object.fromEntries(usd.rows.map((r) => [r.label, r.value]))
    expect(rows['Equity']).toBe('equity unavailable')
    expect(rows['% of equity']).toBe('-')
  })
  it('entry falls back to the ticket hint when none is typed', () => {
    expect(helperView(eq({ entry: '' }), ctx({ entryHint: 100 })).useQty).toBe('50')
    expect(helperView(eq({ entry: '' }), ctx({ entryHint: null })).error).toMatch(/entry/i)
  })
  it('fractional increment gives a fractional quantity text', () => {
    expect(helperView(eq({ mode: 'usd', riskUsd: '250', stop: '97' }), ctx({ increment: 0.001 })).useQty).toBe('83.333')
  })
})

describe('helperView: option', () => {
  it('spread width 5, credit 1.20, budget $1000 -> $380 per contract, 2 contracts, collateral shown beside R', () => {
    const v = helperView(op(), ctx())
    expect(v.error).toBeNull()
    expect(v.useQty).toBe('2')
    const rows = Object.fromEntries(v.rows.map((r) => [r.label, r.value]))
    expect(rows['R per contract']).toBe('$380.00')
    expect(rows['Contracts']).toBe('2')
    expect(rows['Collateral']).toBe('$1,000.00')
  })
  it('short put credit 2.00, stop buyback 4.00 -> $200 per contract; default stop multiple fills in when no buyback typed', () => {
    const v = helperView(op({ basis: 'stop_mult', credit: '2', stopBuyback: '4', riskUsd: '600' }), ctx())
    expect(Object.fromEntries(v.rows.map((r) => [r.label, r.value]))['R per contract']).toBe('$200.00')
    expect(v.useQty).toBe('3')
    const d = helperView(op({ basis: 'stop_mult', credit: '2', stopBuyback: '', riskUsd: '600' }), ctx())
    expect(Object.fromEntries(d.rows.map((r) => [r.label, r.value]))['R per contract']).toBe('$200.00')
  })
  it('credit comes from the ticket price when not typed', () => {
    expect(helperView(op({ credit: '' }), ctx({ creditHint: 1.2 })).useQty).toBe('2')
  })
  it('budget below one contract -> 0 contracts with the message and no Use quantity', () => {
    const v = helperView(op({ riskUsd: '300' }), ctx())
    expect(v.useQty).toBeNull()
    expect(v.message).toBe('1 contract exceeds your budget by $80.00')
  })
  it('credit >= width is invalid input', () => {
    const v = helperView(op({ credit: '5' }), ctx())
    expect(v.useQty).toBeNull()
    expect(v.error).toMatch(/less than/)
  })
  it('percent mode needs equity; with equity 25000 at 1% the budget is $250', () => {
    expect(helperView(op({ mode: 'pct', riskPct: '1' }), ctx({ equity: null })).error).toMatch(/equity unavailable/i)
    const v = helperView(op({ mode: 'pct', riskPct: '2', width: '2', credit: '0.5' }), ctx()) // $500 budget / $150 = 3
    expect(v.useQty).toBe('3')
  })
})

describe('helperView never throws and never returns a bad quantity (weird input table)', () => {
  const weird = ['', ' ', '-1', '0', '-0', 'NaN', 'Infinity', '-Infinity', '1e999', '1e-999', '9'.repeat(400), 'abc', '5%', '１２', '\u0000', '0x10']
  it('equity: every combination yields text and either no quantity or a positive finite one', () => {
    for (const a of weird) {
      for (const b of weird) {
        for (const side of ['buy', 'sell'] as const) {
          for (const e of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 25000]) {
            const v = helperView(eq({ riskPct: a, riskUsd: b, stop: a, entry: b, side, mode: a.length % 2 ? 'pct' : 'usd' }), ctx({ equity: e as number | null }))
            if (v.useQty !== null) {
              const q = Number(v.useQty)
              expect(Number.isFinite(q) && q > 0, `qty ${v.useQty} for ${a}|${b}`).toBe(true)
            }
            expect(typeof v.error === 'string' || v.error === null).toBe(true)
            for (const r of v.rows) expect(r.value).not.toMatch(/NaN|Infinity|undefined/)
          }
        }
      }
    }
  })
  it('option: same guarantee', () => {
    for (const a of weird) {
      for (const b of weird) {
        for (const basis of ['spread_max_loss', 'stop_mult'] as const) {
          const v = helperView(op({ basis, width: a, credit: b, stopBuyback: a, riskUsd: b, riskPct: a }), ctx())
          if (v.useQty !== null) expect(Number(v.useQty) >= 1 && Number.isInteger(Number(v.useQty))).toBe(true)
          for (const r of v.rows) expect(r.value).not.toMatch(/NaN|Infinity|undefined/)
        }
      }
    }
  })
})

const eqArgs = (o: Partial<EquityOrderArgs> = {}): EquityOrderArgs => ({
  account_number: 'AGEN00001234', symbol: 'AAA', side: 'buy', type: 'limit', quantity: '50', limit_price: '100', time_in_force: 'gfd', market_hours: 'regular_hours', ...o,
})
const opArgs = (o: Partial<OptionOrderArgs> = {}, leg: Partial<OptionOrderArgs['legs'][0]> = {}): OptionOrderArgs => ({
  account_number: 'AGEN00001234', legs: [{ option_id: 'u', side: 'sell', position_effect: 'open', ratio_quantity: 1, ...leg }], quantity: '2', type: 'limit', price: '1.20', time_in_force: 'gfd', market_hours: 'regular_hours', ...o,
})
const dctx = { entryHint: null as number | null, defaultStopMult: 2 }

describe('draftFields: the draft comes from the REVIEWED ticket values', () => {
  it('equity: symbol, side, qty and entry from the reviewed args; planned risk = qty x per-share risk', () => {
    const r = draftFields({ kind: 'equity', args: eqArgs() }, eq(), dctx)
    expect(r.reason).toBeNull()
    expect(r.fields).toMatchObject({ side: 'buy', account_masked: '••••1234', symbol: 'AAA', instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: 250, qty: 50, entry_price: 100, stop_price: 95, multiplier: 1 })
  })
  it('the quantity actually reviewed wins over what the helper suggested (risk is recomputed)', () => {
    const r = draftFields({ kind: 'equity', args: eqArgs({ quantity: '10' }) }, eq(), dctx)
    expect(r.fields?.planned_risk_usd).toBe(50)
    expect(r.fields?.qty).toBe(10)
  })
  it('the reviewed limit price is the entry; a market order uses the typed entry, then the hint', () => {
    expect(draftFields({ kind: 'equity', args: eqArgs({ limit_price: '98' }) }, eq(), dctx).fields?.planned_risk_usd).toBe(150)
    const m = eqArgs({ type: 'market', limit_price: null })
    expect(draftFields({ kind: 'equity', args: m }, eq({ entry: '' }), { ...dctx, entryHint: 100 }).fields?.entry_price).toBe(100)
    expect(draftFields({ kind: 'equity', args: m }, eq({ entry: '' }), dctx).fields).toBeNull()
  })
  it('no helper use, other symbol, other side, dollar sizing, bad stop -> no draft with a reason (never guessed)', () => {
    expect(draftFields({ kind: 'equity', args: eqArgs() }, null, dctx)).toEqual({ fields: null, reason: null })
    expect(draftFields({ kind: 'equity', args: eqArgs({ symbol: 'BBB' }) }, eq(), dctx).fields).toBeNull()
    expect(draftFields({ kind: 'equity', args: eqArgs({ symbol: 'BBB' }) }, eq(), dctx).reason).toMatch(/symbol/)
    expect(draftFields({ kind: 'equity', args: eqArgs({ side: 'sell' }) }, eq(), dctx).fields).toBeNull()
    expect(draftFields({ kind: 'equity', args: eqArgs({ quantity: null, dollar_amount: '500' }) }, eq(), dctx).reason).toMatch(/dollars/)
    expect(draftFields({ kind: 'equity', args: eqArgs() }, eq({ stop: '101' }), dctx).fields).toBeNull()
    expect(draftFields({ kind: 'equity', args: eqArgs({ quantity: '0' }) }, eq(), dctx).fields).toBeNull()
    expect(draftFields({ kind: 'equity', args: eqArgs({ quantity: 'abc' }) }, eq(), dctx).fields).toBeNull()
  })
  it('option: contracts and price from the reviewed order, basis from the helper', () => {
    const r = draftFields({ kind: 'option', args: opArgs(), underlying: 'AAA' }, op(), dctx)
    expect(r.reason).toBeNull()
    expect(r.fields).toMatchObject({ side: 'sell', symbol: 'AAA', instrument: 'option', risk_basis: 'spread_max_loss', planned_risk_usd: 760, qty: 2, entry_price: 1.2, multiplier: 100 })
  })
  it('option stop_mult: stop buyback recorded (typed, else credit x multiple)', () => {
    const a = draftFields({ kind: 'option', args: opArgs({ price: '2.00' }), underlying: 'AAA' }, op({ basis: 'stop_mult', stopBuyback: '4' }), dctx)
    expect(a.fields).toMatchObject({ risk_basis: 'stop_mult', planned_risk_usd: 400, stop_price: 4 })
    const b = draftFields({ kind: 'option', args: opArgs({ price: '2.00' }), underlying: 'AAA' }, op({ basis: 'stop_mult', stopBuyback: '' }), dctx)
    expect(b.fields).toMatchObject({ planned_risk_usd: 400, stop_price: 4 })
  })
  it('option: buying to open, closing, multi-leg or a different underlying -> no draft', () => {
    expect(draftFields({ kind: 'option', args: opArgs({}, { side: 'buy' }), underlying: 'AAA' }, op(), dctx).fields).toBeNull()
    expect(draftFields({ kind: 'option', args: opArgs({}, { position_effect: 'close' }), underlying: 'AAA' }, op(), dctx).fields).toBeNull()
    const two = opArgs()
    two.legs.push({ option_id: 'v', side: 'buy', position_effect: 'open', ratio_quantity: 1 })
    expect(draftFields({ kind: 'option', args: two, underlying: 'AAA' }, op(), dctx).fields).toBeNull()
    expect(draftFields({ kind: 'option', args: opArgs(), underlying: 'BBB' }, op(), dctx).fields).toBeNull()
  })
})
