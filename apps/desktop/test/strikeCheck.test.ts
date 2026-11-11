import { describe, expect, it } from 'vitest'
import type { ApexLevels, EarningsInfo, ExpectedMove, RhOptionRow } from '../src/lib/api'
import { buildStrikeInput, daysBetween, pickHorizon, strikeCheck, strikeRows, type StrikeCheckInput } from '../src/lib/strikeCheck'

const base: StrikeCheckInput = {
  side: 'sell', right: 'put', strike: 95, expiration: '2026-11-20', dte: 9, spot: 100, emPct: 0.04, emFor: '2026-11-20',
  apex: [{ price: 97 }], earnings: null, earningsStatus: 'ok', today: '2026-11-11',
}
const chk = (o: Partial<StrikeCheckInput> = {}) => strikeCheck({ ...base, ...o })

describe('strikeCheck numbers (spot 100, short put 95, EM 4%)', () => {
  it('distance 5%, 1.25 EM, outside', () => {
    const r = chk()
    expect(r.distancePct).toBeCloseTo(0.05, 9)
    expect(r.emUnits).toBeCloseTo(1.25, 9)
    expect(r.insideEm).toBe(false)
  })
  it('EM 6% -> 0.8333 EM, inside', () => {
    const r = chk({ emPct: 0.06 })
    expect(r.emUnits).toBeCloseTo(0.8333, 4)
    expect(r.insideEm).toBe(true)
  })
  it('boundary: exactly one EM away is NOT inside (strict <)', () => {
    const r = chk({ strike: 96, emPct: 0.04 })
    expect(r.emUnits).toBe(1)
    expect(r.insideEm).toBe(false)
    expect(chk({ strike: 96.01, emPct: 0.04 }).insideEm).toBe(true)
  })
  it('apex 97 between spot and strike -> wallBetween 97', () => {
    expect(chk().wallBetween).toBe(97)
    expect(chk().atStrike).toBeNull()
  })
  it('boundary: an apex level EXACTLY at the strike is reported as atStrike, not as a wall between', () => {
    const r = chk({ apex: [{ price: 95 }] })
    expect(r.atStrike).toBe(95)
    expect(r.wallBetween).toBeNull()
    expect(r.verdict).toBe('exposed')
  })
  it('a level at spot itself is not between either (strict)', () => {
    expect(chk({ apex: [{ price: 100 }] }).wallBetween).toBeNull()
  })
  it('picks the wall nearest the strike when several sit between', () => {
    expect(chk({ apex: [{ price: 99 }, { price: 97 }, { price: 93 }, { price: 101 }] }).wallBetween).toBe(97)
    expect(chk({ right: 'call', strike: 105, apex: [{ price: 101 }, { price: 103 }, { price: 99 }, { price: 107 }] }).wallBetween).toBe(103)
  })
  it('short call mirror (spot 100, strike 105, apex 103)', () => {
    const r = chk({ right: 'call', strike: 105, apex: [{ price: 103 }] })
    expect(r.distancePct).toBeCloseTo(0.05, 9)
    expect(r.emUnits).toBeCloseTo(1.25, 9)
    expect(r.wallBetween).toBe(103)
    expect(r.verdict).toBe('protected')
    expect(chk({ right: 'call', strike: 105, apex: [{ price: 97 }] }).wallBetween).toBeNull()
  })
  it('an ITM strike has nothing between on its side', () => {
    const r = chk({ strike: 105, apex: [{ price: 102 }] })
    expect(r.itm).toBe(true)
    expect(r.wallBetween).toBeNull()
    expect(r.verdict).toBe('exposed')
  })
});

describe('event calendar', () => {
  it('earnings on the expiry date is inside (inclusive, am/pm irrelevant)', () => {
    expect(chk({ earnings: { date: '2026-11-20' } }).eventInside).toBe(true)
    expect(chk({ earnings: { date: '2026-11-20' } }).verdict).toBe('event')
  })
  it('earnings yesterday is ignored; the day after expiry is outside; today is inside', () => {
    expect(chk({ earnings: { date: '2026-11-10' } }).eventInside).toBe(false)
    expect(chk({ earnings: { date: '2026-11-21' } }).eventInside).toBe(false)
    expect(chk({ earnings: { date: '2026-11-11' } }).eventInside).toBe(true)
  })
  it('event wins over everything, even with no apex data', () => {
    expect(chk({ apex: [], earnings: { date: '2026-11-15' } }).verdict).toBe('event')
  })
  it('unknown calendar: row is unknown (null), and a would-be "protected" is downgraded to unknown', () => {
    const r = chk({ earningsStatus: 'unknown' })
    expect(r.eventInside).toBeNull()
    expect(r.verdict).toBe('unknown')
  })
  it('no earnings row with a known (answered) calendar is "none found", and protected is allowed', () => {
    const r = chk({ earnings: null })
    expect(r.eventInside).toBe(false)
    expect(r.verdict).toBe('protected')
  })
})

describe('verdicts', () => {
  it('protected = wall in front AND outside 1 EM (and calendar known)', () => {
    expect(chk().verdict).toBe('protected')
  })
  it('wall in front but inside 1 EM is exposed', () => {
    expect(chk({ emPct: 0.06 }).verdict).toBe('exposed')
  })
  it('no wall between -> exposed', () => {
    expect(chk({ apex: [{ price: 90 }] }).verdict).toBe('exposed')
  })
  it('missing apex -> unknown (never protected)', () => {
    expect(chk({ apex: [] }).verdict).toBe('unknown')
    expect(chk({ apex: null }).verdict).toBe('unknown')
    expect(chk({ apex: [], apexThrough: null }).apexCoverage).toBe('missing')
  })
  it('apex that stops before the expiry gives no verdict', () => {
    const r = chk({ apexThrough: '2026-11-18' })
    expect(r.apexCoverage).toBe('beyond')
    expect(r.wallBetween).toBeNull()
    expect(r.verdict).toBe('unknown')
    expect(chk({ apexThrough: '2026-11-20' }).verdict).toBe('protected')
  })
  it('missing spot -> unknown, no numbers', () => {
    const r = chk({ spot: null })
    expect(r.distancePct).toBeNull()
    expect(r.emUnits).toBeNull()
    expect(r.verdict).toBe('unknown')
  })
  it('wall present but no EM -> unknown, never protected', () => {
    const r = chk({ emPct: null, emFor: null })
    expect(r.emCoverage).toBe('missing')
    expect(r.insideEm).toBeNull()
    expect(r.verdict).toBe('unknown')
  })
  it('long legs: rows are computed, there is NO verdict', () => {
    const r = chk({ side: 'buy' })
    expect(r.graded).toBe(false)
    expect(r.verdict).toBeUndefined()
    expect(r.distancePct).toBeCloseTo(0.05, 9)
    expect(r.emUnits).toBeCloseTo(1.25, 9)
    expect('verdict' in chk({ side: 'buy', earnings: { date: '2026-11-15' } })).toBe(false)
  })
})

describe('expected move expiry coverage', () => {
  it('an EM for another expiry is flagged and emUnits omitted', () => {
    const r = chk({ emFor: '2026-11-18' })
    expect(r.emCoverage).toBe('mismatch')
    expect(r.emUnits).toBeNull()
    expect(r.insideEm).toBeNull()
    expect(r.verdict).toBe('unknown')
  })
  it('emVsAtr: emPct 0.04, spot 100, ATR 2, dte 9 -> 4 / (2*3) = 0.667', () => {
    expect(chk({ atr: 2 }).emVsAtr).toBeCloseTo(0.6667, 4)
  })
  it('emVsAtr needs ATR and dte >= 1 and a matching EM', () => {
    expect(chk().emVsAtr).toBeNull()
    expect(chk({ atr: 2, dte: 0 }).emVsAtr).toBeNull()
    expect(chk({ atr: 0 }).emVsAtr).toBeNull()
    expect(chk({ atr: 2, emFor: '2026-11-18' }).emVsAtr).toBeNull()
  })
})

describe('strikeRows text', () => {
  it('unknowns are "-" and mismatches say what TM covers', () => {
    const i = { strike: 95, expiration: '2026-11-20', emFor: '2026-11-18', apexThrough: null }
    const rows = Object.fromEntries(strikeRows(chk({ emFor: '2026-11-18', apex: [], earningsStatus: 'unknown' }), i).map((r) => [r.label, r.value]))
    expect(rows['Wall in front']).toBe('-')
    expect(rows['Event']).toBe('-')
    expect(rows['Expected move']).toContain('TM covers 2026-11-18, not 2026-11-20')
    expect(rows['EM vs ATR']).toBe('-')
    expect(rows['IV rank']).toBe('-')
    const ok = Object.fromEntries(strikeRows(chk({ ivRank: 37.868 }), { ...i, emFor: '2026-11-20' }).map((r) => [r.label, r.value]))
    expect(ok['Wall in front']).toBe('Apex 97')
    expect(ok['Expected move']).toBe('1.25 EM (outside 1 EM)')
    expect(ok['Distance']).toBe('5.0%')
    expect(ok['IV rank']).toBe('38')
  })
})

const row = (o: { strike?: number | null; exp?: string | null; type?: string | null; delta?: number | null } = {}): Pick<RhOptionRow, 'instrument' | 'quote'> => ({
  instrument: { id: 'i1', chain_id: 'c1', expiration_date: 'exp' in o ? o.exp! : '2026-11-20', strike_price: 'strike' in o ? o.strike! : 95, option_type: 'type' in o ? o.type! : 'put' },
  quote: { instrument_id: 'i1', bid: 1, ask: 1.2, mark: 1.1, delta: 'delta' in o ? o.delta! : -0.2, gamma: null, theta: null, vega: null, rho: null, implied_volatility: null, open_interest: null, volume: null },
})
const hz = (label: string, through: string, pct: number | null) => ({
  label, calendar_days: 7, through_date: through, trading_days: 5, expected_move_pct: pct, band68: null, band95: null, held68_pct: null, held95_pct: null, sample_days: null, extrapolated: false,
})
const move = (hs: ReturnType<typeof hz>[]): ExpectedMove => ({ symbol: 'AAA', spot: 100, as_of: null, horizons: hs, interpretation: null, open_url: null })
const apex = (strikes: number[], used: string[] = ['2026-11-13', '2026-11-20']): ApexLevels => ({
  symbol: 'AAA', spot: 100, snapshot_time: null, gamma_flip: null, net_gex: null, expirations_used: used, available_expirations: used, open_url: null,
  levels: strikes.map((s, i) => ({ strike: s, score: 100 - i, rank: i + 1, net_gex: null, total_oi: null, is_above_spot: s > 100 })),
})
const earn = (date: string | null): EarningsInfo => ({ next: date ? { date, timing: 'pm', verified: true } : null, last: null })

describe('buildStrikeInput', () => {
  const tm = (m: ExpectedMove | null, a: ApexLevels | null = apex([97])) => ({ apex: a, move: m, iv: null })
  const args = (o: Partial<Parameters<typeof buildStrikeInput>[0]> = {}) => ({
    side: 'sell' as const, row: row(), spot: 100, tm: tm(move([hz('1 week', '2026-11-20', 0.04)])), earnings: earn(null), earningsStatus: 'ok' as const, atr: 2, today: '2026-11-11', ...o,
  })

  it('maps the chain row, TM bits, earnings and ATR', () => {
    const i = buildStrikeInput(args({ earnings: earn('2026-12-10'), tm: { ...tm(move([hz('1 week', '2026-11-20', 0.04)])), iv: { symbol: 'AAA', source: null, iv_rank: 37.9, zone: null, clamped: null, as_of: null, freshness: null, interpretation: null, recent_change: null, reason: null, open_url: null } } }))!
    expect(i).toMatchObject({ side: 'sell', right: 'put', strike: 95, expiration: '2026-11-20', dte: 9, spot: 100, delta: -0.2, ivRank: 37.9, emPct: 0.04, emFor: '2026-11-20', apexThrough: '2026-11-20', earnings: { date: '2026-12-10' }, earningsStatus: 'ok', atr: 2 })
    expect(i.apex).toEqual([{ price: 97, kind: 'below' }])
    const r = strikeCheck(i)
    expect(r.emUnits).toBeCloseTo(1.25, 9)
    expect(r.verdict).toBe('protected')
  })
  it('TM horizon for another expiry: emFor flagged, emUnits omitted, never reused silently', () => {
    const i = buildStrikeInput(args({ tm: tm(move([hz('1 week', '2026-11-18', 0.036), hz('2 weeks', '2026-11-25', 0.046)])) }))!
    expect(i.emFor).toBe('2026-11-18')
    const r = strikeCheck(i)
    expect(r.emCoverage).toBe('mismatch')
    expect(r.emUnits).toBeNull()
  })
  it('prefers the horizon whose through_date IS the expiry', () => {
    expect(pickHorizon(move([hz('a', '2026-11-18', 0.03), hz('b', '2026-11-20', 0.05), hz('c', '2026-11-25', 0.07)]), '2026-11-20')).toEqual({ pct: 0.05, through: '2026-11-20' })
    expect(pickHorizon(move([hz('a', '2026-11-18', null)]), '2026-11-20')).toBeNull()
    expect(pickHorizon(null, '2026-11-20')).toBeNull()
  })
  it('missing TM, unanswered earnings, no ATR: everything unknown, no safety implied', () => {
    const i = buildStrikeInput(args({ tm: tm(null, null), earnings: null, earningsStatus: 'unknown', atr: null }))!
    expect(i.apex).toEqual([])
    expect(i.emPct).toBeNull()
    expect(i.earnings).toBeNull()
    const r = strikeCheck(i)
    expect(r.verdict).toBe('unknown')
    expect(r.emVsAtr).toBeNull()
    expect(r.eventInside).toBeNull()
  })
  it('apex that ends before the expiry is flagged', () => {
    const i = buildStrikeInput(args({ tm: tm(move([hz('x', '2026-11-20', 0.04)]), apex([97], ['2026-11-13'])) }))!
    expect(strikeCheck(i).apexCoverage).toBe('beyond')
  })
  it('an upcoming earnings date inside the DTE makes the verdict "event"', () => {
    const i = buildStrikeInput(args({ earnings: earn('2026-11-20') }))!
    expect(strikeCheck(i).verdict).toBe('event')
  })
  it('rows without a usable strike, expiry or right give null', () => {
    expect(buildStrikeInput(args({ row: row({ strike: null }) }))).toBeNull()
    expect(buildStrikeInput(args({ row: row({ exp: null }) }))).toBeNull()
    expect(buildStrikeInput(args({ row: row({ type: 'straddle' }) }))).toBeNull()
  })
  it('daysBetween', () => {
    expect(daysBetween('2026-11-11', '2026-11-20')).toBe(9)
    expect(daysBetween('2026-11-20', '2026-11-11')).toBe(-9)
    expect(daysBetween('x', '2026-11-11')).toBeNaN()
  })
})

describe('earnings candidates around the UTC rollover', () => {
  const tm = { apex: apex([97]), move: move([hz('x', '2026-11-20', 0.04)]), iv: null }
  const a = (e: EarningsInfo, today = '2026-11-11') => ({ side: 'sell' as const, row: row(), spot: 100, tm, earnings: e, earningsStatus: 'ok' as const, atr: null, today })
  it('a report dated today that the UTC-cut core put in `last` still counts', () => {
    const i = buildStrikeInput(a({ next: { date: '2026-12-10', timing: 'pm', verified: true }, last: { date: '2026-11-11', timing: 'pm', verified: true } }))!
    expect(i.earnings).toEqual({ date: '2026-11-11' })
    expect(strikeCheck(i).verdict).toBe('event')
  })
  it('a stale last row is ignored and the next one is used', () => {
    const i = buildStrikeInput(a({ next: { date: '2026-12-10', timing: 'pm', verified: true }, last: { date: '2026-08-01', timing: 'am', verified: true } }))!
    expect(i.earnings).toEqual({ date: '2026-12-10' })
  })
})

describe('positions', () => {
  const pos = (o: Partial<import('../src/lib/api').RhOptionPosition> = {}): import('../src/lib/api').RhOptionPosition => ({
    option_id: 'o1', chain_symbol: 'AAA', expiration_date: '2026-11-20', strike_price: 95, option_type: 'put', side: 'short', quantity: 1, average_price: 110,
    multiplier: 100, bid: 1, ask: 1.2, mark: 1.1, delta: -0.2, theta: -0.05, iv: 0.3, min_ticks: null, pending_buy: null, pending_sell: null, ...o,
  })
  it('a short position maps to a graded input; the dot reflects the verdict; a long one has no dot', async () => {
    const { rowFromPosition, verdictDot, localIsoDate } = await import('../src/lib/strikeCheck')
    const tm = { apex: apex([97]), move: move([hz('x', '2026-11-20', 0.04)]), iv: null }
    const i = buildStrikeInput({ side: 'sell', row: rowFromPosition(pos()), spot: 100, tm, earnings: earn(null), earningsStatus: 'ok', atr: null, today: '2026-11-11' })!
    expect(verdictDot(strikeCheck(i))).toMatchObject({ cls: 'sc-dot sc-protected' })
    const long = buildStrikeInput({ side: 'buy', row: rowFromPosition(pos({ side: 'long' })), spot: 100, tm, earnings: earn(null), earningsStatus: 'ok', atr: null, today: '2026-11-11' })!
    expect(verdictDot(strikeCheck(long))).toBeNull()
    expect(verdictDot(null)).toBeNull()
    expect(localIsoDate(new Date(2026, 10, 5))).toBe('2026-11-05')
  })
})
