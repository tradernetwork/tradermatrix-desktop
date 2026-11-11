import { describe, expect, it } from 'vitest'
import type { RhOptionPosition, RhPnlTrade, RhPosition, RiskDraft, RiskStatsOut, StatRow } from '../src/lib/api'
import {
  approximateRs,
  concentration,
  fmtR,
  histogramBars,
  matchPositionRisk,
  rCell,
  rCounterText,
  realizedR,
  curvePoints,
  rstatsDigestState,
  statsView,
  validateRiskEdit,
  type RiskEditForm,
} from '../src/lib/riskUi'
import { heatReadout } from '../src/lib/riskHeat'
import { rStats } from '../src/lib/riskStats'

// M18 Tasks 6-8. Pure adapters. INFORMATIONAL ONLY.

describe('R formatting (Task 6)', () => {
  it('fmtR: signed, two decimals, "-" for anything unusable', () => {
    expect(fmtR(2)).toBe('+2.00R')
    expect(fmtR(-1)).toBe('-1.00R')
    expect(fmtR(0)).toBe('0.00R')
    expect(fmtR(0.004)).toBe('0.00R')
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(fmtR(v as number | null)).toBe('-')
  })
  it('realizedR = realized / planned; null without a positive planned risk or a finite gain', () => {
    expect(realizedR(500, 250)).toBe(2)
    expect(realizedR(-250, 250)).toBe(-1)
    expect(realizedR(null, 250)).toBeNull()
    expect(realizedR(100, 0)).toBeNull()
    expect(realizedR(100, -5)).toBeNull()
    expect(realizedR(Number.NaN, 250)).toBeNull()
  })
  it('rCell: planned $ and realized R; "-" when the trade has no R; manual is flagged "set after the fact"', () => {
    const row = { planned_risk_usd: 250, source: 'manual', risk_basis: 'equity_stop' } as StatRow
    expect(rCell(row, 500)).toEqual({ planned: '$250.00', r: '+2.00R', afterTheFact: true })
    expect(rCell({ ...row, source: 'draft' }, -125)).toEqual({ planned: '$250.00', r: '-0.50R', afterTheFact: false })
    expect(rCell(undefined, 500)).toEqual({ planned: '-', r: '-', afterTheFact: false })
    expect(rCell(row, null).r).toBe('-')
  })
  it('counter: "N of M trades have R"', () => {
    expect(rCounterText(12, 30)).toBe('12 of 30 trades have R')
    expect(rCounterText(0, 0)).toBe('0 of 0 trades have R')
    expect(rCounterText(1, 1)).toBe('1 of 1 trades have R')
  })
})

describe('risk editor validation (Task 6)', () => {
  const form = (o: Partial<RiskEditForm> = {}): RiskEditForm => ({ planned: '250', basis: 'equity_stop', instrument: 'equity', stop: '', entry: '', qty: '', note: '', ...o })
  const trade = { symbol: 'aaa' }
  it('a good form builds the manual payload with the masked account and an upper-case symbol', () => {
    const r = validateRiskEdit(form({ stop: '95', entry: '100', qty: '50', note: 'plan' }), trade, '••••1234')
    expect(r).toEqual({
      manual: { account_masked: '••••1234', symbol: 'AAA', instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: 250, qty: 50, entry_price: 100, stop_price: 95, note: 'plan' },
    })
  })
  it('blank optional fields are left out', () => {
    const r = validateRiskEdit(form(), trade, null)
    expect(r).toEqual({ manual: { symbol: 'AAA', instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: 250 } })
  })
  it('planned risk must be a positive finite dollar amount', () => {
    for (const p of ['', ' ', '0', '-5', 'abc', 'NaN', 'Infinity', '1e999', '2e9']) expect(validateRiskEdit(form({ planned: p }), trade, null), p).toHaveProperty('error')
    expect(validateRiskEdit(form({ planned: '0.5' }), trade, null)).toHaveProperty('manual')
  })
  it('a basis that does not fit the instrument is refused (no silent mixing)', () => {
    expect(validateRiskEdit(form({ instrument: 'option', basis: 'equity_stop' }), trade, null)).toHaveProperty('error')
    expect(validateRiskEdit(form({ instrument: 'equity', basis: 'spread_max_loss' }), trade, null)).toHaveProperty('error')
    expect(validateRiskEdit(form({ instrument: 'option', basis: 'stop_mult' }), trade, null)).toHaveProperty('manual')
    expect(validateRiskEdit(form({ instrument: 'option', basis: 'manual_dollars' }), trade, null)).toHaveProperty('manual')
  })
  it('stop, entry and quantity must be above zero when given; the note is one short line', () => {
    for (const f of [{ stop: '0' }, { stop: '-1' }, { entry: 'x' }, { qty: '0' }, { qty: 'NaN' }, { note: 'a\nb' }, { note: 'x'.repeat(501) }]) {
      expect(validateRiskEdit(form(f), trade, null), JSON.stringify(f)).toHaveProperty('error')
    }
  })
  it('only the masked account form is accepted (a full number is never sent)', () => {
    expect(validateRiskEdit(form(), trade, 'AGEN00001234')).toHaveProperty('error')
  })
  it('a symbol that is not valid is refused', () => {
    expect(validateRiskEdit(form(), { symbol: '' }, null)).toHaveProperty('error')
  })
})

const row = (key: string, planned: number, gain: number | null, at: string | null = '2026-11-02T15:00:00Z', source = 'draft'): StatRow => ({
  trade_key: key, symbol: 'AAA', planned_risk_usd: planned, risk_basis: 'equity_stop', source, realized_gain: gain, closed_at: at,
})
const out = (rows: StatRow[], total: number): RiskStatsOut => ({ rows, trades_total: total, with_risk: rows.length, suggestions: [] })

describe('statsView: R from the joined rows (Task 7)', () => {
  it('[2,-1,-1,3,-1] on $100 planned risk -> expectancy 0.4, curve in close order, N of M counter', () => {
    const gains = [200, -100, -100, 300, -100]
    const rows = gains.map((g, i) => row(`t${i}`, 100, g, `2026-11-0${i + 1}T15:00:00Z`))
    const v = statsView(out(rows.slice().reverse(), 9), [])
    expect(v.stats.n).toBe(5)
    expect(v.stats.expectancy).toBeCloseTo(0.4)
    expect(v.stats.winRate).toBeCloseTo(0.4)
    expect(v.stats.curve).toEqual([2, 1, 0, 3, 2])
    expect(v.counter).toBe('5 of 9 trades have R')
    expect(v.sqn).toBe('n=5, too few to rank')
    expect(v.sqnCaveat).toBe(true)
  })
  it('a recorded trade with no realized gain is left out of the stats and counted separately', () => {
    const v = statsView(out([row('a', 100, 50), row('b', 100, null)], 4), [])
    expect(v.stats.n).toBe(1)
    expect(v.missingRealized).toBe(1)
  })
  it('n >= 30: SQN appears; zero spread shows "-"', () => {
    const same = Array.from({ length: 30 }, (_, i) => row(`t${i}`, 100, 100, `2026-10-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`))
    const v = statsView(out(same, 30), [])
    expect(v.stats.n).toBe(30)
    expect(v.sqn).toBe('-')
    expect(v.sqnCaveat).toBe(false)
    const mixed = Array.from({ length: 30 }, (_, i) => row(`m${i}`, 100, i % 3 === 0 ? -100 : 150))
    expect(statsView(out(mixed, 30), []).sqn).toMatch(/^\d+\.\d\d$/)
  })
  it('no data -> an empty view without NaN', () => {
    const v = statsView(null, [])
    expect(v.stats.n).toBe(0)
    expect(v.counter).toBe('0 of 0 trades have R')
    expect(v.stats.expectancy).toBeNull()
  })
  it('histogram bars: heights relative to the tallest bin; curve points scale into the box', () => {
    const bars = histogramBars(rStats([1, 1, 1, -1, 2]).histogram)
    const tall = bars.reduce((a, b) => (b.height > a.height ? b : a))
    expect(tall.height).toBe(100)
    expect(bars.every((b) => b.height >= 0 && b.height <= 100)).toBe(true)
    const pts = curvePoints([0, 2, 1, 3], 100, 40)
    expect(pts).toHaveLength(4)
    expect(pts.every((p) => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 40)).toBe(true)
    expect(pts[3]!.y).toBeLessThan(pts[0]!.y) // higher cumulative R is drawn higher (smaller y)
    expect(curvePoints([], 100, 40)).toEqual([])
    expect(curvePoints([5], 100, 40)).toHaveLength(1)
  })
})

describe('approximation toggle (Task 7): off by default, labeled, never mixed silently', () => {
  const t = (key: string, gain: number | null, ts = '2026-11-01T15:00:00Z'): RhPnlTrade => ({ trade_key: key, symbol: 'AAA', side: 'sell', quantity: 1, price: 1, realized_gain: gain, timestamp: ts })
  it('uses the average loss of the trades WITHOUT R as 1R, only for those trades', () => {
    const trades = [t('r1', 200), t('x1', -100), t('x2', -300), t('x3', 400), t('x4', null)]
    const a = approximateRs(trades, new Set(['r1']))
    expect(a.avgLossUsd).toBe(200)
    expect(a.items.map((i) => i.r)).toEqual([-0.5, -1.5, 2])
    expect(a.count).toBe(3)
  })
  it('no losing trade without R -> nothing to approximate from', () => {
    const a = approximateRs([t('x', 100)], new Set())
    expect(a.avgLossUsd).toBeNull()
    expect(a.items).toEqual([])
  })
  it('statsView adds the approximated items only when asked, and says how many', () => {
    const rows = [row('r1', 100, 100)]
    const items = [{ r: -0.5, closedAt: '2026-11-03T15:00:00Z' }]
    expect(statsView(out(rows, 2), items, false).stats.n).toBe(1)
    const on = statsView(out(rows, 2), items, true)
    expect(on.stats.n).toBe(2)
    expect(on.approximated).toBe(1)
  })
})

describe('heat and concentration (Task 8, Review Focus 4)', () => {
  const draft = (o: Partial<RiskDraft>): RiskDraft => ({
    review_id: 'r', created_at: 1, account_masked: '••••1234', symbol: 'AAA', side: 'buy', instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: 250,
    qty: 10, entry_price: 100, stop_price: 95, multiplier: 1, order_id: 'o1', placed_at: 2, expires_at: 9, ...o,
  })
  const pos = (symbol: string, quantity: number): RhPosition => ({ symbol, quantity, average_buy_price: 100, shares_available_for_sells: quantity, shares_held_for_sells: 0 })
  const optPos = (o: Partial<RhOptionPosition>): RhOptionPosition => ({
    option_id: 'op1', chain_symbol: 'AAA', expiration_date: '2026-12-18', strike_price: 90, option_type: 'put', side: 'short', quantity: 2, average_price: 120, multiplier: 100,
    bid: 1, ask: 1.2, mark: 1.1, delta: -0.2, theta: 0.1, iv: 0.3, min_ticks: null, pending_buy: null, pending_sell: null, ...o,
  })

  it('two positions with $250 and $400 recorded on 25000 equity -> $650, 2.6%; one unknown is listed and not counted', () => {
    const drafts = [draft({ review_id: 'a', symbol: 'AAA', qty: 10, planned_risk_usd: 250 }), draft({ review_id: 'b', symbol: 'BBB', qty: 5, planned_risk_usd: 400 })]
    const hp = matchPositionRisk(drafts, '••••1234', [pos('AAA', 10), pos('BBB', 5), pos('CCC', 7)], [])
    expect(hp.map((p) => [p.id, p.plannedRiskUsd ?? null])).toEqual([['eq:AAA', 250], ['eq:BBB', 400], ['eq:CCC', null]])
    const h = heatReadout(25000, hp)
    expect(h.totalUsd).toBe(650)
    expect(h.pctOfEquity).toBe(2.6)
    expect(h.unknown).toEqual(['eq:CCC'])
    expect(h.counted).toBe(2)
  })
  it('only PLACED drafts of the same account whose quantity equals the position count; ambiguity is unknown, never a guess', () => {
    const unplaced = draft({ order_id: null, placed_at: null })
    expect(matchPositionRisk([unplaced], '••••1234', [pos('AAA', 10)], [])[0]!.plannedRiskUsd).toBeNull()
    expect(matchPositionRisk([draft({})], '••••9999', [pos('AAA', 10)], [])[0]!.plannedRiskUsd).toBeNull()
    expect(matchPositionRisk([draft({})], '••••1234', [pos('AAA', 11)], [])[0]!.plannedRiskUsd).toBeNull()
    expect(matchPositionRisk([draft({ side: 'sell' })], '••••1234', [pos('AAA', 10)], [])[0]!.plannedRiskUsd).toBeNull()
    const two = [draft({ review_id: 'a' }), draft({ review_id: 'b' })]
    expect(matchPositionRisk(two, '••••1234', [pos('AAA', 10)], [])[0]!.plannedRiskUsd).toBeNull()
    expect(matchPositionRisk([draft({})], '••••1234', [pos('AAA', 10)], [])[0]!.plannedRiskUsd).toBe(250)
  })
  it('option positions match on underlying, contract count and side (short = sold to open)', () => {
    const d = draft({ instrument: 'option', side: 'sell', qty: 2, planned_risk_usd: 400, risk_basis: 'stop_mult', multiplier: 100 })
    expect(matchPositionRisk([d], '••••1234', [], [optPos({})])[0]).toEqual({ id: 'opt:op1', plannedRiskUsd: 400 })
    expect(matchPositionRisk([d], '••••1234', [], [optPos({ side: 'long' })])[0]!.plannedRiskUsd).toBeNull()
    expect(matchPositionRisk([d], '••••1234', [], [optPos({ option_id: 'a' }), optPos({ option_id: 'b' })]).map((p) => p.plannedRiskUsd)).toEqual([null, null])
  })
  it('concentration: each position market value as % of equity; "-" without equity; short options by absolute value; no thresholds', () => {
    const rows = concentration(25000, [pos('AAA', 10), pos('BBB', 5)], { AAA: 100, BBB: 50 }, [optPos({ mark: 1.1, quantity: 2 })])
    expect(rows.map((r) => [r.label, r.valueUsd, r.pct])).toEqual([
      ['AAA', 1000, 4],
      ['BBB', 250, 1],
      ['AAA 2026-12-18 90P (short)', 220, 0.88],
    ])
    expect(concentration(null, [pos('AAA', 10)], { AAA: 100 }, []).map((r) => r.pct)).toEqual([null])
    expect(concentration(25000, [pos('AAA', 10)], {}, [])[0]).toMatchObject({ valueUsd: null, pct: null })
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['label', 'pct', 'valueUsd'])
  })
})

describe('digest numbers (Task 9 input)', () => {
  it('rstatsDigestState: numbers only, from recorded R; sqn only for n >= 30; heat from the readout', () => {
    const v = statsView(out([row('a', 100, 200), row('b', 100, -100)], 5), [])
    const d = rstatsDigestState(v, 2.6)
    expect(d).toEqual({ n: 5, nWithR: 2, expectancyR: 0.5, winRate: 0.5, avgWinR: 2, avgLossR: -1, sqn: null, heatPct: 2.6 })
    expect(rstatsDigestState(statsView(null, []), null)).toEqual({ n: 0, nWithR: 0, expectancyR: null, winRate: null, avgWinR: null, avgLossR: null, sqn: null, heatPct: null })
  })
  it('the approximation never reaches the digest', () => {
    const v = statsView(out([row('a', 100, 200)], 3), [{ r: -2 }, { r: -3 }], true)
    expect(rstatsDigestState(v, null).expectancyR).toBe(2)
  })
})
