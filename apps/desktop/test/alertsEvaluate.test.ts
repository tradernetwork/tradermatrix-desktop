import { describe, expect, it } from 'vitest'
import { evaluate, retreated, sideOf, STALE_QUOTE_S } from '../src/alerts/evaluate'
import { mkAlert } from './alertsHelpers'

const obs = (px: number, prevSide: -1 | 0 | 1 | null, over: object = {}) => ({ px, prevSide, quoteAgeS: 1, sessionOpen: true, ...over })

describe('evaluate (M17 task 2, exact cases)', () => {
  it('last 99 -> price 101, level 100, dir up: fires once with side +1', () => {
    const prev = sideOf(99, 100)
    expect(prev).toBe(-1)
    const r = evaluate(mkAlert(), obs(101, prev))
    expect(r.fire).toBe(true)
    expect(r.side).toBe(1)
    expect(r.event).toMatchObject({ kind: 'fire', side: 1, px: 101, level: 100 })
    // the next observation (still above) does not fire again
    expect(evaluate(mkAlert(), obs(102, r.side)).fire).toBe(false)
  })

  it('first observation (prevSide null) never fires, it only records the side', () => {
    const r = evaluate(mkAlert(), obs(101, null))
    expect(r.fire).toBe(false)
    expect(r.side).toBe(1)
    expect(r.event).toBeUndefined()
    expect(evaluate(mkAlert(), obs(99, null))).toMatchObject({ fire: false, side: -1 })
  })

  it('100.00 -> 100.00 does not fire (touching is not crossing in cross mode)', () => {
    expect(evaluate(mkAlert(), obs(100, 0)).fire).toBe(false)
    // coming up from below to exactly the level: no fire, and the old side is kept so the later cross still counts
    const touch = evaluate(mkAlert(), obs(100, -1))
    expect(touch).toMatchObject({ fire: false, side: -1 })
    expect(evaluate(mkAlert(), obs(100.01, touch.side)).fire).toBe(true)
  })

  it('a gap 98 -> 103 through the level fires exactly once', () => {
    const r = evaluate(mkAlert(), obs(103, sideOf(98, 100)))
    expect(r).toMatchObject({ fire: true, side: 1 })
    expect(evaluate(mkAlert(), obs(104, r.side)).fire).toBe(false)
  })

  it('dir up with the price falling through does not fire (but the side is still tracked)', () => {
    expect(evaluate(mkAlert(), obs(99, 1))).toMatchObject({ fire: false, side: -1 })
  })

  it('dir down fires on the way down only; dir either fires both ways', () => {
    expect(evaluate(mkAlert({ dir: 'down' }), obs(99, 1))).toMatchObject({ fire: true, side: -1 })
    expect(evaluate(mkAlert({ dir: 'down' }), obs(101, -1)).fire).toBe(false)
    expect(evaluate(mkAlert({ dir: 'either' }), obs(99, 1)).fire).toBe(true)
    expect(evaluate(mkAlert({ dir: 'either' }), obs(101, -1)).fire).toBe(true)
  })

  it(`quote age over ${STALE_QUOTE_S} s: no fire and the side is not advanced`, () => {
    const r = evaluate(mkAlert(), obs(101, -1, { quoteAgeS: 25 }))
    expect(r).toMatchObject({ fire: false, side: -1, observed: false })
    expect(evaluate(mkAlert(), obs(101, -1, { quoteAgeS: 20 })).fire).toBe(true) // exactly 20 s is still fresh
    expect(evaluate(mkAlert(), obs(101, null, { quoteAgeS: 25 })).side).toBe(0) // nothing known, nothing recorded
  })

  it('session closed: no fire; extended hours only counts when the alert opted in', () => {
    expect(evaluate(mkAlert(), obs(101, -1, { sessionOpen: false }))).toMatchObject({ fire: false, side: -1, observed: false })
    expect(evaluate(mkAlert(), obs(101, -1, { extendedOnly: true })).fire).toBe(false)
    expect(evaluate(mkAlert({ extended_hours: true }), obs(101, -1, { extendedOnly: true })).fire).toBe(true)
  })

  it('a resolved level overrides the frozen price; a bad price or level never fires', () => {
    expect(evaluate(mkAlert({ price: 100 }), obs(101, -1, { level: 102 }))).toMatchObject({ fire: false, side: -1 })
    expect(evaluate(mkAlert({ price: 100 }), obs(103, -1, { level: 102 })).fire).toBe(true)
    expect(evaluate(mkAlert(), obs(Number.NaN, -1))).toMatchObject({ fire: false, observed: false })
    expect(evaluate(mkAlert(), obs(101, -1, { level: 0 })).fire).toBe(false)
  })

  it('touch mode fires on an exact touch and on a crossing', () => {
    expect(evaluate(mkAlert({ mode: 'touch' }), obs(100, -1)).fire).toBe(true)
    expect(evaluate(mkAlert({ mode: 'touch' }), obs(101, -1)).fire).toBe(true)
    expect(evaluate(mkAlert({ mode: 'touch' }), obs(99, -1)).fire).toBe(false)
  })
})

describe('retreated (hysteresis mirror of the Rust re-arm rule)', () => {
  it('level 100, hysteresis 0.05%: 100.04 does not re-arm a fired up alert, 99.90 does', () => {
    const a = mkAlert({ repeat: 'rearm', last_side: 1, armed: false })
    expect(retreated(a, 100.04)).toBe(false)
    expect(retreated(a, 99.96)).toBe(false)
    expect(retreated(a, 99.9)).toBe(true)
    expect(retreated(mkAlert({ last_side: -1 }), 100.06)).toBe(true)
  })
})
