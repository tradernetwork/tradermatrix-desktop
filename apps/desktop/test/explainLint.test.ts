import { describe, expect, it } from 'vitest'
import { lintReply, LINT_NOTICE } from '../src/lib/explainLint'

describe('lintReply (A2)', () => {
  it('flags prescriptive wording', () => {
    for (const t of ['You should buy the dip.', 'I recommend selling the put.', 'I suggest you hold.', 'Consider buying calls here.', 'You might want to sell now.', 'Buy at 187.', "Let's sell into strength.", 'You need to close it.', 'Go long above the flip.']) {
      expect(lintReply(t).prescriptive, t).toBe(true)
    }
  })
  it('does not flag descriptions', () => {
    for (const t of ['The delta is 0.30.', 'Sell-side analysts cover the name.', 'Buy-side flow is estimated at 41%.', 'Buyers and sellers are balanced.', 'Est buy share is 0.41.', 'The put was sold short by someone, which a short put describes.', 'IV rank is 72, which is high.']) {
      expect(lintReply(t).prescriptive, t).toBe(false)
    }
  })
  it('returns the matched phrases (for tests, never for display of advice)', () => {
    expect(lintReply('You should buy it.').matches.length).toBeGreaterThan(0)
    expect(lintReply('clean text').matches).toEqual([])
  })
  it('the notice is plain, muted and free of order words', () => {
    expect(LINT_NOTICE.length).toBeGreaterThan(20)
    expect(LINT_NOTICE).not.toMatch(/\b(place|cancel|review)\b/i)
  })
  it('adversarial input finishes fast', () => {
    const t0 = Date.now()
    lintReply('you '.repeat(5000) + 'should ' + 'I '.repeat(3000))
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
