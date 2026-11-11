import { describe, expect, it } from 'vitest'
import { chipsFor, DEFAULT_CHIPS } from '../src/lib/explainChips'
import { lintReply } from '../src/lib/explainLint'
import { EMPTY_EXPLAIN_STATE, type ExplainState } from '../src/lib/explainDigest'

const chart = { symbol: 'AAPL', tf: '15m', bars: 100, last: 187.3, hi: 190, lo: 180, chg: 0.01, estBuyShare: 0.5 }
const strike = (verdict: string | null) => ({ right: 'put', strike: 95, dte: 9, emUnits: 1.2, wall: 97, earningsInside: false, verdict })
const st = (p: Partial<ExplainState>): ExplainState => ({ ...EMPTY_EXPLAIN_STATE, ...p })

describe('chipsFor (A5)', () => {
  it('empty state gives the default chips', () => {
    expect(chipsFor(EMPTY_EXPLAIN_STATE)).toEqual([...DEFAULT_CHIPS])
    expect(DEFAULT_CHIPS).toHaveLength(3)
  })
  it('exposed verdict first', () => {
    expect(chipsFor(st({ strike: strike('exposed') }))[0]).toBe('Why exposed?')
    expect(chipsFor(st({ strike: strike('protected') }))).not.toContain('Why exposed?')
  })
  it('IV rank present', () => {
    expect(chipsFor(st({ ivRank: 72 }))[0]).toBe('Is IV rank high?')
    expect(chipsFor(st({ ivRank: null }))).not.toContain('Is IV rank high?')
  })
  it('price near an Apex level (within 1%)', () => {
    const levels = { apex: [187.5, 200], flip: null, emLo: null, emHi: null, emPct: null }
    expect(chipsFor(st({ chart, levels }))[0]).toBe('What is the wall at 187.5?')
    const far = { ...levels, apex: [150, 200] }
    expect(chipsFor(st({ chart, levels: far }))).not.toContain('What is the wall at 150?')
  })
  it('a focus price overrides the last price', () => {
    const levels = { apex: [150, 200], flip: null, emLo: null, emHi: null, emPct: null }
    expect(chipsFor(st({ chart, levels }), { price: 150.4 })[0]).toBe('What is the wall at 150?')
  })
  it('all three rule chips, in order, and never more than 3', () => {
    const levels = { apex: [187.5], flip: null, emLo: null, emHi: null, emPct: null }
    const c = chipsFor(st({ chart, levels, ivRank: 72, strike: strike('exposed') }))
    expect(c).toEqual(['Why exposed?', 'Is IV rank high?', 'What is the wall at 187.5?'])
  })
  it('rule chips are topped up with defaults without duplicates', () => {
    const c = chipsFor(st({ ivRank: 72 }))
    expect(c).toHaveLength(3)
    expect(new Set(c).size).toBe(3)
    expect(c[0]).toBe('Is IV rank high?')
  })
  it('no chip is prescriptive, and none uses order words', () => {
    const levels = { apex: [187.5], flip: null, emLo: null, emHi: null, emPct: null }
    for (const s of [EMPTY_EXPLAIN_STATE, st({ chart, levels, ivRank: 72, strike: strike('exposed') })]) {
      for (const c of chipsFor(s)) {
        expect(lintReply(c).prescriptive, c).toBe(false)
        expect(c).not.toMatch(/\b(buy|sell|place|cancel|review|order|ticket)\b/i)
      }
    }
  })
})
