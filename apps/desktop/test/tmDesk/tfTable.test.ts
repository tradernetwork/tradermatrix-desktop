import { describe, expect, it } from 'vitest'
import { TIMEFRAMES } from '../../src/chart/bars'
import { htfMs, tfRow } from '../../src/chart/tmDesk/tfTable'

describe('tfRow', () => {
  it('covers all 12 timeframe ids', () => {
    expect(TIMEFRAMES).toHaveLength(12)
    for (const t of TIMEFRAMES) {
      const r = tfRow(t.id)
      expect(r.lookback).toBeGreaterThan(0)
      expect(r.atrLen).toBeGreaterThan(0)
      expect(htfMs(r.sel)).toBeGreaterThan(0)
    }
  })
  it('15m row', () => {
    expect(tfRow('15m')).toEqual({ sel: '30', lookback: 200, atrLen: 175, vgN: 500, vgF: 2, show886: false })
  })
  it('table values from the Pine', () => {
    expect(tfRow('1m')).toMatchObject({ sel: '3', lookback: 250, atrLen: 250 })
    expect(tfRow('5m')).toMatchObject({ sel: '5', lookback: 200, atrLen: 200 })
    expect(tfRow('1h')).toMatchObject({ sel: '60', lookback: 200, atrLen: 150 })
    expect(tfRow('2h')).toMatchObject({ sel: '120', lookback: 200, atrLen: 100 })
    expect(tfRow('4h')).toMatchObject({ sel: '240', lookback: 200, atrLen: 75 })
    expect(tfRow('1D')).toMatchObject({ sel: 'D', lookback: 100, atrLen: 34 })
    expect(tfRow('1W')).toMatchObject({ sel: 'W', lookback: 200, atrLen: 21 })
    expect(tfRow('1M')).toMatchObject({ sel: 'M', lookback: 50, atrLen: 21 })
  })
  it('vg params switch at 60 minutes and 0.886 only on W/M', () => {
    expect(tfRow('1D').vgF).toBe(1)
    expect(tfRow('1D').vgN).toBe(100)
    expect(tfRow('30m').vgF).toBe(2)
    expect(tfRow('1h').vgF).toBe(1)
    expect(tfRow('1M').show886).toBe(true)
    expect(tfRow('1W').show886).toBe(true)
    expect(tfRow('1h').show886).toBe(false)
  })
  it('override clamps lookback to 5..500', () => {
    expect(tfRow('1D', 1).lookback).toBe(5)
    expect(tfRow('1D', 9999).lookback).toBe(500)
    expect(tfRow('1D', 123).lookback).toBe(123)
    expect(tfRow('1D', NaN).lookback).toBe(100)
  })
})
