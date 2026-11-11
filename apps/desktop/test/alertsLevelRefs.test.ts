import { describe, expect, it, vi } from 'vitest'
import { runAlertTick, type EngineDeps } from '../src/alerts/engine'
import { refFromLevel, resolveRef, type LevelSnap } from '../src/alerts/levelRefs'
import type { ApexLevels, ExpectedMove, RhQuote } from '../src/lib/api'
import { mkAlert } from './alertsHelpers'

const apex = (levels: [number, number][], flip: number | null = 440): ApexLevels =>
  ({ symbol: 'AAA', spot: 451, snapshot_time: null, gamma_flip: flip, net_gex: null, levels: levels.map(([rank, strike]) => ({ strike, score: 90 - rank, rank, net_gex: 1, total_oi: 1, is_above_spot: true })), expirations_used: [], available_expirations: [], open_url: null }) as ApexLevels
const move: ExpectedMove = {
  symbol: 'AAA', spot: 451, as_of: null, interpretation: null, open_url: null,
  horizons: [{ label: '1 week', calendar_days: 7, through_date: null, trading_days: 5, expected_move_pct: 0.03, band68: { low: 440, high: 460 }, band95: { low: 430, high: 470 }, held68_pct: null }],
} as ExpectedMove
const snap = (over: Partial<LevelSnap> = {}): LevelSnap => ({ apex: apex([[1, 440], [2, 450]]), move, desk: { fib: [{ ratio: 0.618, price: 433.2 }], atr: { sl: 430, tp1: 460, tp2: 470, tp3: 480 } }, ...over })
const ref = (ref_kind: string, ref_param: string | null) => ({ ref_kind, ref_param }) as never

describe('resolveRef (task 7)', () => {
  it('apex follows its rank: 450 moves to 452 and the resolved level is 452', () => {
    expect(resolveRef(ref('apex', 'rank:2'), snap())).toEqual({ state: 'ok', level: 450 })
    expect(resolveRef(ref('apex', 'rank:2'), snap({ apex: apex([[1, 440], [2, 452]]) }))).toEqual({ state: 'ok', level: 452 })
  })
  it('a rank that disappeared from loaded apex data is gone; no apex data at all is unknown (never gone)', () => {
    expect(resolveRef(ref('apex', 'rank:2'), snap({ apex: apex([[1, 440]]) }))).toEqual({ state: 'gone' })
    expect(resolveRef(ref('apex', 'rank:2'), snap({ apex: null }))).toEqual({ state: 'unknown' })
    expect(resolveRef(ref('apex', 'rank:2'), null)).toEqual({ state: 'unknown' })
  })
  it('flip, expected-move edges, fib and ATR resolve; missing pieces are gone only where the source is loaded', () => {
    expect(resolveRef(ref('flip', null), snap())).toEqual({ state: 'ok', level: 440 })
    expect(resolveRef(ref('flip', null), snap({ apex: apex([], null) }))).toEqual({ state: 'gone' })
    expect(resolveRef(ref('em_hi', '1 week|68'), snap())).toEqual({ state: 'ok', level: 460 })
    expect(resolveRef(ref('em_lo', '1 week|95'), snap())).toEqual({ state: 'ok', level: 430 })
    expect(resolveRef(ref('em_hi', '1 month|68'), snap())).toEqual({ state: 'gone' })
    expect(resolveRef(ref('fib', '0.618'), snap())).toEqual({ state: 'ok', level: 433.2 })
    expect(resolveRef(ref('fib', '0.5'), snap())).toEqual({ state: 'gone' })
    expect(resolveRef(ref('fib', '0.618'), snap({ desk: null }))).toEqual({ state: 'unknown' })
    expect(resolveRef(ref('atr', 'tp1'), snap())).toEqual({ state: 'ok', level: 460 })
    expect(resolveRef(ref('atr', 'tp1'), snap({ desk: { fib: [], atr: null } }))).toEqual({ state: 'unknown' })
  })
})

describe('refFromLevel', () => {
  const ctx = { move, horizon: '1 week' }
  it('maps ladder rows to a stable reference', () => {
    expect(refFromLevel({ price: 450, label: 'APEX 450', source: 'tm', rank: 2 }, ctx)).toEqual({ ref_kind: 'apex', ref_param: 'rank:2' })
    expect(refFromLevel({ price: 440, label: 'FLIP 440.00', source: 'flip', rank: 0 }, ctx)).toEqual({ ref_kind: 'flip', ref_param: null })
    expect(refFromLevel({ price: 460, label: 'EM68 460', source: 'em', rank: 1 }, ctx)).toEqual({ ref_kind: 'em_hi', ref_param: '1 week|68' })
    expect(refFromLevel({ price: 430, label: 'EM95 430', source: 'em', rank: 2 }, ctx)).toEqual({ ref_kind: 'em_lo', ref_param: '1 week|95' })
    expect(refFromLevel({ price: 433.2, label: '0.618 433.20', source: 'fib', rank: 0.618 }, ctx)).toEqual({ ref_kind: 'fib', ref_param: '0.618' })
    expect(refFromLevel({ price: 460, label: 'TP1 460.00', source: 'atr', rank: 1 }, ctx)).toEqual({ ref_kind: 'atr', ref_param: 'tp1' })
  })
  it('a source with no stable identity (FVG) gives null: the alert is created by price', () => {
    expect(refFromLevel({ price: 455, label: 'FVG + 455.00', source: 'fvg', rank: 0 }, ctx)).toBeNull()
  })
})

const NOW = 1_800_000_000_000
const q = (px: number): RhQuote => ({ symbol: 'AAA', bid_price: null, ask_price: null, last_trade_price: px, previous_close: null })
function deps(over: Partial<EngineDeps>): EngineDeps {
  return { now: () => NOW, session: () => ({ open: true, extendedOnly: false }), fire: vi.fn(async () => ({ outcome: 'skipped', reason: 'x' }) as never), setSide: vi.fn(), ...over } as never
}

describe('engine with by-reference alerts (Review Focus 4)', () => {
  const byRef = mkAlert({ symbol: 'AAA', ref_kind: 'apex', ref_param: 'rank:2', price: 450, dir: 'either', last_side: 1 })
  it('the level moved 450 -> 452: the alert follows (price and side rewritten) and does not fire by itself', async () => {
    const follow = vi.fn()
    const fire = vi.fn()
    // 451 was above 450 (side 1); against the new level 452 it is below: a naive evaluation would fire
    await runAlertTick([byRef], [q(451)], { startedAt: NOW }, deps({ fire, levelFor: () => ({ state: 'ok', level: 452 }), follow }))
    expect(follow).toHaveBeenCalledWith(byRef.id, 452, -1)
    expect(fire).not.toHaveBeenCalled()
  })
  it('an unchanged level evaluates normally against the stored price', async () => {
    const fire = vi.fn(async () => ({ outcome: 'skipped', reason: 'x' }) as never)
    await runAlertTick([byRef], [q(449)], { startedAt: NOW }, deps({ fire, levelFor: () => ({ state: 'ok', level: 450 }) }))
    expect(fire).toHaveBeenCalledTimes(1)
  })
  it('a vanished level: exactly one level-gone report, never a fire; an already snoozed alert reports nothing', async () => {
    const gone = vi.fn()
    const fire = vi.fn()
    const d = deps({ fire, levelFor: () => ({ state: 'gone' }), levelGone: gone })
    await runAlertTick([byRef], [q(449)], { startedAt: NOW }, d)
    expect(gone).toHaveBeenCalledTimes(1)
    expect(fire).not.toHaveBeenCalled()
    await runAlertTick([{ ...byRef, snooze_until: NOW + 1000 }], [q(449)], { startedAt: NOW }, d)
    expect(gone).toHaveBeenCalledTimes(1)
  })
  it('an unknown level falls back to the frozen price', async () => {
    const fire = vi.fn(async () => ({ outcome: 'skipped', reason: 'x' }) as never)
    await runAlertTick([byRef], [q(449)], { startedAt: NOW }, deps({ fire, levelFor: () => ({ state: 'unknown' }) }))
    expect(fire).toHaveBeenCalledTimes(1)
  })
})
