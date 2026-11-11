import { describe, expect, it } from 'vitest'
import { SpamGate, HOUR_MS, MAX_PER_HOUR, MAX_PER_SYMBOL_PER_HOUR } from '../src/alerts/spam'

const T0 = 1_800_000_000_000

describe('SpamGate (task 5: 20 toasts/h overall, 5/h per symbol, then one "N more alerts" summary)', () => {
  it('limits are the published ones', () => {
    expect([MAX_PER_HOUR, MAX_PER_SYMBOL_PER_HOUR, HOUR_MS]).toEqual([20, 5, 3_600_000])
  })

  it('6 fires in 1 hour for one symbol: 5 toasts, then a summary that counts the rest', () => {
    const g = new SpamGate()
    const out = Array.from({ length: 6 }, (_, i) => g.admit('AAA', T0 + i * 60_000))
    expect(out.map((o) => o.show)).toEqual([true, true, true, true, true, false])
    expect(out.map((o) => o.more)).toEqual([0, 0, 0, 0, 0, 1])
    expect(g.admit('AAA', T0 + 400_000)).toEqual({ show: false, more: 2 })
  })

  it('per-symbol window boundary: the oldest toast leaves the window exactly one hour later', () => {
    const g = new SpamGate()
    for (let i = 0; i < 5; i++) expect(g.admit('AAA', T0).show).toBe(true)
    expect(g.admit('AAA', T0 + HOUR_MS - 1).show).toBe(false)
    expect(g.admit('AAA', T0 + HOUR_MS).show).toBe(true)
    // another symbol is unaffected by AAA's cap
    expect(g.admit('BBB', T0 + 5).show).toBe(true)
  })

  it('overall cap: 20 toasts across symbols, the 21st is held back, and a slot frees one hour after the first', () => {
    const g = new SpamGate()
    for (let i = 0; i < 20; i++) expect(g.admit(`S${i}`, T0 + i).show, `toast ${i}`).toBe(true)
    expect(g.admit('NEW', T0 + 100)).toEqual({ show: false, more: 1 })
    expect(g.admit('NEW', T0 + HOUR_MS - 1).show).toBe(false)
    expect(g.admit('NEW', T0 + HOUR_MS).show).toBe(true) // S0's toast (at T0) is out of the window
    expect(g.admit('NEW2', T0 + HOUR_MS).show).toBe(false) // S1's is still in (T0 + 1)
  })

  it('suppressed fires do not use up the window, and the summary count restarts after a quiet hour', () => {
    const g = new SpamGate()
    for (let i = 0; i < 5; i++) g.admit('AAA', T0)
    for (let i = 0; i < 10; i++) g.admit('AAA', T0 + 1000)
    expect(g.admit('AAA', T0 + HOUR_MS).show).toBe(true) // only the 5 shown toasts counted
    expect(g.admit('AAA', T0 + 2 * HOUR_MS + 5)).toEqual({ show: true, more: 0 })
  })

  it('reset forgets everything (session wipe)', () => {
    const g = new SpamGate()
    for (let i = 0; i < 6; i++) g.admit('AAA', T0)
    g.reset()
    expect(g.admit('AAA', T0).show).toBe(true)
  })
})
