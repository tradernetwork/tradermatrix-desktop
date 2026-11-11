import { describe, expect, it } from 'vitest'
import { findTerms, GLOSSARY } from '../src/lib/glossary'

const terms = (t: string) => findTerms(t).map((m) => m.term)

describe('glossary (A7)', () => {
  it('has the core entries with static text', () => {
    for (const k of ['IV rank', 'expected move', 'gamma flip', 'Apex', 'FVG', 'ATR', 'delta', 'DTE', 'theta', 'IV', 'OI', 'short put', 'short call']) {
      const e = GLOSSARY.find((g) => g.term === k)
      expect(e, k).toBeTruthy()
      expect(e!.def.length).toBeGreaterThan(20)
      expect(e!.def).not.toMatch(/[<>]/)
    }
  })
  it('whole-word matching', () => {
    expect(terms('The delta is 0.3 and theta is small.')).toEqual(['delta', 'theta'])
    expect(terms('Deltas and thetaGang and ATRX and PIV and OIL and RIVET')).toEqual([])
    expect(terms('At DTE 9 the IV is high.')).toEqual(['DTE', 'IV'])
  })
  it('longest term wins over a shorter one inside it', () => {
    expect(terms('IV rank is 72.')).toEqual(['IV rank'])
    expect(terms('The gamma flip is 185.')).toEqual(['gamma flip'])
  })
  it('hyphenated forms: multiword terms accept a hyphen; a hyphen is a word boundary otherwise', () => {
    expect(terms('The gamma-flip level and a short-put leg.')).toEqual(['gamma flip', 'short put'])
    expect(terms('A delta-neutral book with theta-decay.')).toEqual(['delta', 'theta'])
    expect(terms('IV-rank is up.')).toEqual(['IV rank'])
  })
  it('case: acronyms are case sensitive, words are not', () => {
    expect(terms('iv and oi and dte')).toEqual([])
    expect(terms('Delta and EXPECTED MOVE')).toEqual(['delta', 'expected move'])
  })
  it('only the first occurrence of a term is marked', () => {
    expect(terms('delta then delta again')).toEqual(['delta'])
  })
  it('matches carry offsets and the static definition', () => {
    const t = 'See the Apex level.'
    const m = findTerms(t)[0]!
    expect(t.slice(m.start, m.end)).toBe('Apex')
    expect(m.def).toBe(GLOSSARY.find((g) => g.term === 'Apex')!.def)
  })
  it('adversarial input finishes fast', () => {
    const t0 = Date.now()
    findTerms('delta '.repeat(2000) + 'a'.repeat(8000))
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
