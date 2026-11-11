import { describe, expect, it } from 'vitest'
import { diffOrders, earningsInside, evalLevelTrigger, verdictFire, type OrderSnap } from '../src/alerts/triggers'

describe('verdict alerts (task 10)', () => {
  it('ok -> exposed fires once, not again until the verdict changes', () => {
    expect(verdictFire(null, 'protected', 'exposed')).toEqual({ fire: false, next: 'protected' })
    const a = verdictFire('protected', 'exposed', 'exposed')
    expect(a).toEqual({ fire: true, next: 'exposed' })
    expect(verdictFire('exposed', 'exposed', 'exposed')).toEqual({ fire: false, next: 'exposed' })
    expect(verdictFire('exposed', 'protected', 'exposed')).toEqual({ fire: false, next: 'protected' })
    expect(verdictFire('protected', 'exposed', 'exposed').fire).toBe(true)
  })
  it('an unknown verdict never fires and never overwrites what we knew', () => {
    expect(verdictFire('protected', 'unknown', 'exposed')).toEqual({ fire: false, next: 'protected' })
  })
})

describe('P&L and IV level triggers (signed levels)', () => {
  it('P&L threshold -500 fires at -500.01 and not at -499.99', () => {
    expect(evalLevelTrigger(-500, 'down', 1, -500.01).fire).toBe(true)
    expect(evalLevelTrigger(-500, 'down', 1, -499.99).fire).toBe(false)
  })
  it('a first observation only records', () => {
    expect(evalLevelTrigger(-500, 'down', null, -900)).toMatchObject({ fire: false, side: -1 })
  })
  it('IV rank 59.9 -> 60.1 across 60 fires once', () => {
    const r = evalLevelTrigger(60, 'up', null, 59.9)
    expect(r.fire).toBe(false)
    const r2 = evalLevelTrigger(60, 'up', r.side, 60.1)
    expect(r2.fire).toBe(true)
    expect(evalLevelTrigger(60, 'up', r2.side, 61).fire).toBe(false)
  })
})

describe('earnings alerts (task 11)', () => {
  it('inside means today <= earnings <= expiry; the expiry date itself counts inside', () => {
    expect(earningsInside('2026-12-18', '2026-12-18', '2026-11-12')).toBe(true)
    expect(earningsInside('2026-12-19', '2026-12-18', '2026-11-12')).toBe(false)
    expect(earningsInside('2026-11-12', '2026-12-18', '2026-11-12')).toBe(true)
    expect(earningsInside('2026-11-11', '2026-12-18', '2026-11-12')).toBe(false)
    expect(earningsInside(null, '2026-12-18', '2026-11-12')).toBe(false)
  })
  it('only counts when the earnings date is within N days from today', () => {
    expect(earningsInside('2026-11-20', '2026-12-18', '2026-11-12', 7)).toBe(false)
    expect(earningsInside('2026-11-19', '2026-12-18', '2026-11-12', 7)).toBe(true)
  })
})

describe('order-state alerts', () => {
  const o = (id: string, state: string, symbol = 'AAA'): OrderSnap => ({ id, symbol, state })
  it('reports a state change to filled or rejected, and an approval appearing or deciding; the first snapshot is silent', () => {
    expect(diffOrders(null, [o('1', 'queued')])).toEqual([])
    expect(diffOrders([o('1', 'queued')], [o('1', 'filled')])).toEqual([{ id: '1', symbol: 'AAA', text: 'AAA order filled' }])
    expect(diffOrders([o('1', 'queued')], [o('1', 'rejected')])[0]!.text).toBe('AAA order rejected')
    expect(diffOrders([o('1', 'queued')], [o('1', 'confirmed')])).toEqual([])
    expect(diffOrders([], [o('2', 'pending_approval')])[0]!.text).toBe('AAA order waiting for approval')
    expect(diffOrders([o('2', 'pending_approval')], [o('2', 'approved')])[0]!.text).toBe('AAA order approved')
    expect(diffOrders([o('1', 'filled')], [o('1', 'filled')])).toEqual([])
  })
})
