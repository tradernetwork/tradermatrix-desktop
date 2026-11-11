import { describe, expect, it } from 'vitest'
import { sizeEquity, sizeOption } from '../src/lib/riskSizing'

// M18 Task 1. INFORMATIONAL ONLY: these helpers return numbers and text, nothing here knows about Review or Place.

describe('sizeEquity: plan cases', () => {
  it('25000 equity, 1%, entry 100, stop 95 -> risk $250, 50 shares', () => {
    const r = sizeEquity({ equity: 25000, riskPct: 1, entry: 100, stop: 95, side: 'long', increment: 1 })
    expect(r.error).toBeUndefined()
    expect(r.qty).toBe(50)
    expect(r.riskUsd).toBe(250)
    expect(r.riskPctOfEquity).toBe(1)
    expect(r.remainderUsd).toBe(0)
  })
  it('50000 equity, 2%, entry 50, stop 45 -> 200 shares', () => {
    const r = sizeEquity({ equity: 50000, riskPct: 2, entry: 50, stop: 45, side: 'long', increment: 1 })
    expect(r.qty).toBe(200)
    expect(r.riskUsd).toBe(1000)
  })
  it('risk $250, $3 per share -> 83 whole shares with the remainder shown, 83.333 when fractional', () => {
    const w = sizeEquity({ equity: 25000, riskUsd: 250, entry: 100, stop: 97, side: 'long', increment: 1 })
    expect(w.qty).toBe(83)
    expect(w.riskUsd).toBe(249)
    expect(w.remainderUsd).toBe(1)
    const f = sizeEquity({ equity: 25000, riskUsd: 250, entry: 100, stop: 97, side: 'long', increment: 0.001 })
    expect(f.qty).toBeCloseTo(83.333, 3)
    expect(f.remainderUsd).toBeCloseTo(0.001, 3)
  })
  it('a flat dollar risk works without equity (percent of equity is null)', () => {
    const r = sizeEquity({ riskUsd: 250, entry: 100, stop: 95, side: 'long', increment: 1 })
    expect(r.qty).toBe(50)
    expect(r.riskPctOfEquity).toBeNull()
  })
})

describe('sizeEquity: errors never return a quantity (Review Focus 1)', () => {
  const base = { equity: 25000, riskPct: 1, entry: 100, side: 'long' as const, increment: 1 }
  it('missing stop -> "enter a stop"', () => {
    for (const stop of [undefined, null, Number.NaN]) {
      const r = sizeEquity({ ...base, stop: stop as number | undefined })
      expect(r.qty).toBe(0)
      expect(r.error).toMatch(/enter a stop/i)
    }
  })
  it('long stop at or above entry is an error', () => {
    for (const stop of [100, 101, 500]) {
      const r = sizeEquity({ ...base, stop })
      expect(r.qty).toBe(0)
      expect(r.error).toMatch(/below the entry/i)
    }
  })
  it('short stop at or below entry is an error; above entry sizes', () => {
    for (const stop of [100, 99, 1]) {
      const r = sizeEquity({ ...base, stop, side: 'short' })
      expect(r.qty).toBe(0)
      expect(r.error).toMatch(/above the entry/i)
    }
    const ok = sizeEquity({ ...base, stop: 105, side: 'short' })
    expect(ok.qty).toBe(50)
    expect(ok.riskUsd).toBe(250)
  })
  it('zero or negative or missing risk, zero or negative entry, bad equity, non-finite inputs', () => {
    expect(sizeEquity({ ...base, stop: 95, riskPct: 0 }).error).toBeTruthy()
    expect(sizeEquity({ ...base, stop: 95, riskPct: -1 }).error).toBeTruthy()
    expect(sizeEquity({ ...base, stop: 95, riskPct: 101 }).error).toBeTruthy()
    expect(sizeEquity({ ...base, stop: 95, riskPct: undefined }).error).toMatch(/risk/i)
    expect(sizeEquity({ ...base, stop: 95, entry: 0 }).error).toBeTruthy()
    expect(sizeEquity({ ...base, stop: 95, entry: -5 }).error).toBeTruthy()
    expect(sizeEquity({ ...base, stop: 95, equity: undefined }).error).toMatch(/equity unavailable/i)
    expect(sizeEquity({ ...base, stop: 95, equity: 0 }).error).toBeTruthy()
    expect(sizeEquity({ ...base, stop: Number.POSITIVE_INFINITY }).error).toBeTruthy()
    expect(sizeEquity({ ...base, stop: 95, entry: Number.NaN }).error).toBeTruthy()
    expect(sizeEquity({ ...base, stop: 95, riskUsd: 0, riskPct: undefined }).error).toBeTruthy()
  })
  it('a budget below one share risk gives 0 shares and an error text', () => {
    const r = sizeEquity({ riskUsd: 2, entry: 100, stop: 95, side: 'long', increment: 1 })
    expect(r.qty).toBe(0)
    expect(r.error).toMatch(/budget/i)
  })
  it('a bad increment falls back to whole shares', () => {
    expect(sizeEquity({ ...base, stop: 95, increment: 0 }).qty).toBe(50)
    expect(sizeEquity({ ...base, stop: 95, increment: Number.NaN }).qty).toBe(50)
  })
})

/**
 * Cross-check against ~/projects/alpha-skills/skills/position-sizer/scripts/tests/test_position_sizer.py (expected numbers read there, no code copied).
 * Same semantics (whole shares, long, stop below entry, fixed fractional): identical answers.
 * DELIBERATE DIFFERENCES (not asserted as equal): fractional increments, short stops, options, and the alpha-skills ATR/Kelly/max-position/sector
 * constraints, which this lib does not have (no caps: informational only).
 */
describe('sizeEquity: agrees with alpha-skills position-sizer on the equivalent long-stock inputs', () => {
  it('entry 155, stop 148.50, account 100k, 1% -> risk/share 6.50, $1000, 153 shares', () => {
    const r = sizeEquity({ equity: 100_000, riskPct: 1, entry: 155, stop: 148.5, side: 'long', increment: 1 })
    expect(r.perShareRisk).toBe(6.5)
    expect(r.riskPctOfEquity).toBeCloseTo((153 * 6.5) / 1000, 6)
    expect(r.qty).toBe(153)
  })
  it('penny stock entry 0.85, stop 0.70, 50k, 0.5% -> 1666 shares (floating point 0.15000000000000002 must not change it)', () => {
    expect(sizeEquity({ equity: 50_000, riskPct: 0.5, entry: 0.85, stop: 0.7, side: 'long', increment: 1 }).qty).toBe(1666)
  })
  it('large account entry 500, stop 475, 1M, 2% -> 800 shares', () => {
    expect(sizeEquity({ equity: 1_000_000, riskPct: 2, entry: 500, stop: 475, side: 'long', increment: 1 }).qty).toBe(800)
  })
  it('ATR case: stop = 155 - 3.20 x 2.0 = 148.60, risk/share 6.40, 156 shares (the stop is an input here, we have no ATR mode)', () => {
    const r = sizeEquity({ equity: 100_000, riskPct: 1, entry: 155, stop: 155 - 3.2 * 2, side: 'long', increment: 1 })
    expect(r.qty).toBe(156)
  })
  it('ATR: a wider stop gives fewer shares (1.5x > 2x > 3x)', () => {
    const q = (m: number) => sizeEquity({ equity: 100_000, riskPct: 1, entry: 155, stop: 155 - 3.2 * m, side: 'long', increment: 1 }).qty
    expect(q(1.5)).toBeGreaterThan(q(2))
    expect(q(2)).toBeGreaterThan(q(3))
  })
  it('alpha-skills rejects stop above entry and risk <= 0; so do we', () => {
    expect(sizeEquity({ equity: 100_000, riskPct: 1, entry: 155, stop: 160, side: 'long', increment: 1 }).error).toBeTruthy()
    expect(sizeEquity({ equity: 100_000, riskPct: 0, entry: 155, stop: 150, side: 'long', increment: 1 }).error).toBeTruthy()
    expect(sizeEquity({ equity: 100_000, riskPct: -1, entry: 155, stop: 150, side: 'long', increment: 1 }).error).toBeTruthy()
  })
})

describe('sizeOption', () => {
  it('spread width 5, credit 1.20 -> max loss $380 per contract; budget $1000 -> 2 contracts', () => {
    const r = sizeOption({ basis: 'spread_max_loss', width: 5, credit: 1.2, budgetUsd: 1000 })
    expect(r.error).toBeUndefined()
    expect(r.perContractRisk).toBe(380)
    expect(r.contracts).toBe(2)
    expect(r.totalRisk).toBe(760)
  })
  it('1 contract without a budget reports the max loss', () => {
    const r = sizeOption({ basis: 'spread_max_loss', width: 5, credit: 1.2 })
    expect(r.perContractRisk).toBe(380)
    expect(r.contracts).toBe(1)
    expect(r.totalRisk).toBe(380)
    expect(r.collateralPerContract).toBe(500)
  })
  it('short put credit 2.00, stop buyback 4.00 -> R $200 per contract', () => {
    const r = sizeOption({ basis: 'stop_mult', credit: 2, stopBuyback: 4, budgetUsd: 600 })
    expect(r.perContractRisk).toBe(200)
    expect(r.contracts).toBe(3)
  })
  it('default stop at the multiple of the credit when no buyback is typed', () => {
    const r = sizeOption({ basis: 'stop_mult', credit: 2, stopMult: 2 })
    expect(r.perContractRisk).toBe(200)
  })
  it('collateral for a short leg is strike x 100 when the strike is known, otherwise null (never guessed)', () => {
    expect(sizeOption({ basis: 'stop_mult', credit: 2, stopBuyback: 4, strike: 50 }).collateralPerContract).toBe(5000)
    expect(sizeOption({ basis: 'stop_mult', credit: 2, stopBuyback: 4 }).collateralPerContract).toBeNull()
  })
  it('budget below one contract -> 0 contracts and the shortfall message', () => {
    const r = sizeOption({ basis: 'spread_max_loss', width: 5, credit: 1.2, budgetUsd: 300 })
    expect(r.contracts).toBe(0)
    expect(r.error).toBeUndefined()
    expect(r.message).toBe('1 contract exceeds your budget by $80.00')
  })
  it('credit >= width is invalid input and returns no contracts', () => {
    for (const credit of [5, 5.5]) {
      const r = sizeOption({ basis: 'spread_max_loss', width: 5, credit, budgetUsd: 1000 })
      expect(r.error).toMatch(/credit/i)
      expect(r.contracts).toBe(0)
    }
  })
  it('missing or non-positive or non-finite inputs are errors; stop buyback must exceed the credit', () => {
    expect(sizeOption({ basis: 'spread_max_loss', credit: 1 }).error).toBeTruthy()
    expect(sizeOption({ basis: 'spread_max_loss', width: 0, credit: 1 }).error).toBeTruthy()
    expect(sizeOption({ basis: 'spread_max_loss', width: 5, credit: 0 }).error).toBeTruthy()
    expect(sizeOption({ basis: 'spread_max_loss', width: 5, credit: Number.NaN }).error).toBeTruthy()
    expect(sizeOption({ basis: 'stop_mult', credit: 2 }).error).toMatch(/stop/i)
    expect(sizeOption({ basis: 'stop_mult', credit: 2, stopBuyback: 2 }).error).toBeTruthy()
    expect(sizeOption({ basis: 'stop_mult', credit: 2, stopBuyback: 1 }).error).toBeTruthy()
    expect(sizeOption({ basis: 'stop_mult', credit: 2, stopMult: 1 }).error).toBeTruthy()
    expect(sizeOption({ basis: 'spread_max_loss', width: 5, credit: 1.2, budgetUsd: -5 }).error).toBeTruthy()
  })
})
