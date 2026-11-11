import { describe, expect, it } from 'vitest'
import { budgetState, formatTokens, formatUsd, meterText } from '../src/lib/explainMeter'
import type { UsageSummary } from '../src/lib/api'

const base: UsageSummary = { session_tokens: 42_000, session_cap: 60_000, session_estimated: false, month_usd: 0.03, month_cap: 2, month_tokens: 90_000, month_estimated: false, month_unpriced: false, price_known: true }

describe('meter formatting (M16 B2)', () => {
  it('tokens are short: 42k, 1.5k, 800', () => {
    expect(formatTokens(42_000)).toBe('42k')
    expect(formatTokens(60_000)).toBe('60k')
    expect(formatTokens(1_500)).toBe('1.5k')
    expect(formatTokens(800)).toBe('800')
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(1_234_567)).toBe('1234.6k')
  })
  it('dollars: cents when big enough, more digits when tiny, never a fake zero for a real spend', () => {
    expect(formatUsd(0.03)).toBe('$0.03')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(1.999)).toBe('$2.00')
    expect(formatUsd(0.000126)).toBe('$0.0001')
    expect(formatUsd(0.00000001)).toBe('<$0.0001')
  })
  it('the header line from the plan: "42k / 60k tokens, $0.03 this month"', () => {
    expect(meterText(base)).toBe('42k / 60k tokens, $0.03 this month')
  })
  it("'est' when any of the session's tokens were estimated", () => {
    expect(meterText({ ...base, session_estimated: true })).toBe('42k / 60k tokens (est), $0.03 this month')
  })
  it("'price unknown' when the model price is unknown, never $0.00", () => {
    const t = meterText({ ...base, price_known: false, month_usd: 0 })
    expect(t).toBe('42k / 60k tokens, price unknown')
    expect(t).not.toContain('$')
  })
  it('known price but earlier unpriced use this month is called out, and a month estimate is flagged', () => {
    expect(meterText({ ...base, month_unpriced: true })).toBe('42k / 60k tokens, $0.03 this month + unpriced use')
    expect(meterText({ ...base, month_estimated: true })).toBe('42k / 60k tokens, $0.03 this month (est)')
  })
  it('nothing yet', () => {
    expect(meterText(null)).toBe('')
  })
  it('budget state: ok below 80%, near from 80%, over at the cap (either budget)', () => {
    expect(budgetState(base)).toBe('ok')
    expect(budgetState({ ...base, session_tokens: 48_000 })).toBe('near')
    expect(budgetState({ ...base, session_tokens: 60_000 })).toBe('over')
    expect(budgetState({ ...base, month_usd: 1.7 })).toBe('near')
    expect(budgetState({ ...base, month_usd: 2 })).toBe('over')
    expect(budgetState(null)).toBe('ok')
  })
})
