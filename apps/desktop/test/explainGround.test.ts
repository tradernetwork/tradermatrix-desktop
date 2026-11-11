import { describe, expect, it } from 'vitest'
import { groundReply } from '../src/lib/explainGround'

const D = [
  'CHART: symbol=AAPL tf=15m bars=834 last=187.32',
  'RANGE: hi=190.5 lo=180 chg=+1.23% (last 30 bars)',
  'VOL: est_buy_share=0.41 (estimate from bar closes, not tape)',
  'OVERLAYS: fib=key fvg=off ma=50,200 atr=off',
  'LEVELS: apex=1250,1255 flip=185 em_lo=180.1 em_hi=194.5 em_pct=0.021',
  'IV: rank=72',
  'STRIKE: right=put strike=95 dte=9 em_units=1.25 wall=97 earnings_inside=false verdict=exposed',
].join('\n')
const flagged = (reply: string, digest = D) => groundReply(reply, digest).flagged.map((f) => f.text)

describe('groundReply (A1)', () => {
  it('rounding: $187.3 and 187.32 match the digest 187.32', () => {
    expect(flagged('It last traded at $187.3 today.')).toEqual([])
    expect(flagged('Last is 187.32 right now.')).toEqual([])
    expect(flagged('About $187 on the last bar.')).toEqual([])
  })
  it('a number that is not in the digest is flagged with exact offsets', () => {
    const reply = 'The price is $210 and the flip is 185.'
    const r = groundReply(reply, D)
    expect(r.flagged.map((f) => f.text)).toEqual(['$210'])
    const f = r.flagged[0]!
    expect(reply.slice(f.start, f.end)).toBe('$210')
  })
  it('percent vs decimal both ways', () => {
    expect(flagged('The expected move is 2.1% of spot.')).toEqual([])
    expect(flagged('That is 0.021 of spot.')).toEqual([])
    expect(flagged('Up 1.2% over the window.')).toEqual([])
    expect(flagged('IV rank is 72%.')).toEqual([])
    expect(flagged('The expected move is 9.5% of spot.')).toEqual(['9.5%'])
  })
  it('thousands separators', () => {
    expect(flagged('There is a wall near 1,250.')).toEqual([])
    expect(flagged('There is a wall near $1,250 and 1255.')).toEqual([])
    expect(flagged('A level at 1,300 shows up.')).toEqual(['1,300'])
  })
  it('lists of numbers in the digest do not fuse (1250,1255 are two numbers)', () => {
    expect(flagged('Apex at 1255 and 1250.')).toEqual([])
    expect(flagged('Apex at 1,255,1250.')).not.toBeUndefined()
  })
  it('ranges are checked number by number; a minus after a digit is a range, not a sign', () => {
    expect(flagged('Band 180-194.5 is the range.')).toEqual([])
    expect(flagged('Band 180-230 is the range.')).toEqual(['230'])
    expect(flagged('Band 180–194.5 is the range.')).toEqual([])
  })
  it('years, dates, times, list markers, ordinals and unit-glued numbers are ignored', () => {
    const t = 'In 2026 on 2026-12-18 or Dec 18, at 14:32, step 1. then 2) next, the 3rd item, 15m bars, Q3, IV30, a 200-day line.'
    expect(flagged(t)).toEqual([])
    expect(flagged('1. First point\n2. Second point\n10. Tenth')).toEqual([])
  })
  it('small plain integers are not claims (3 reasons), but dollar and percent figures always are', () => {
    expect(flagged('There are 3 ideas here and 7 things.')).toEqual([])
    expect(flagged('It costs $3 per share.')).toEqual(['$3'])
    expect(flagged('That is 4%.')).toEqual(['4%'])
  })
  it('no digits means nothing flagged; empty inputs are safe', () => {
    expect(flagged('It looks like a pullback to the middle of the range.')).toEqual([])
    expect(flagged('')).toEqual([])
    expect(flagged('Price is $5.', '')).toEqual(['$5'])
  })
  it('the Used: line is not graded', () => {
    expect(flagged('Fine.\nUsed: LEVELS, IV, 0.382')).toEqual([])
  })
  it('relative tolerance 0.6%: 1.00 inside, a far miss outside', () => {
    expect(flagged('Roughly 188.0 here.')).toEqual([]) // 0.36% off 187.32
    expect(flagged('Roughly 192 here.')).toEqual(['192'])
  })
  it('sign is ignored when comparing (a drop of 1.2% against +1.23%)', () => {
    expect(flagged('Down -1.2% on the window.')).toEqual([])
  })
  it('adversarial long input finishes fast', () => {
    const t0 = Date.now()
    groundReply('1'.repeat(5000) + ' ' + '$9.'.repeat(2000), D)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
