import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake, type RhPnlTrade } from '../src/lib/api'
import { DEFAULT_HELPER, helperView } from '../src/lib/riskHelper'
import { reviewDisabled } from '../src/lib/orderUi'
import { placeBlockedReason, ticketKey, useOrdersStore, type Ticket } from '../src/stores/orders'
import { useRiskStore } from '../src/stores/risk'

// M18 Tasks 5-8: the risk store (draft -> placed -> suggested -> user confirms), plus the "informational only" guarantees.

const UUID = '11111111-2222-4333-8444-555555555555'
const UUID2 = '22222222-2222-4333-8444-555555555555'
const ACCT = '••••1234'
const fields = (o: Record<string, unknown> = {}) => ({
  side: 'buy', account_masked: ACCT, symbol: 'AAA', instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: 250, qty: 10, entry_price: 100, stop_price: 75, multiplier: 1, ...o,
})
const trade = (key: string, o: Partial<RhPnlTrade> = {}): RhPnlTrade => ({
  trade_key: key, symbol: 'AAA', side: 'sell', quantity: 10, price: 110, realized_gain: 100, timestamp: new Date(Date.now() + 3_600_000).toISOString(), ...o,
})
const st = () => useRiskStore.getState()

beforeEach(() => {
  fake.reset()
  useRiskStore.getState().reset()
})

describe('settings and helper memory', () => {
  it('defaults: 1% risk, stop multiple 2, approximation off', async () => {
    await st().load()
    expect(st().settings).toEqual({ default_risk_pct: 1, default_option_stop_mult: 2, r_fallback_enabled: false })
  })
  it('the risk percent is remembered through risk_set and survives a reload', async () => {
    await st().load()
    expect(await st().setRiskPct(2.5)).toBe(true)
    st().reset()
    await st().load()
    expect(st().settings?.default_risk_pct).toBe(2.5)
    expect(st().helper.riskPct).toBe('2.5')
  })
  it('a bad percent is refused and the stored value stays', async () => {
    await st().load()
    expect(await st().setRiskPct(0)).toBe(false)
    expect(await st().setRiskPct(101)).toBe(false)
    expect(st().settings?.default_risk_pct).toBe(1)
  })
  it('the last basis and mode come back from the settings table', async () => {
    await st().load()
    await st().rememberHelper({ basis: 'stop_mult', mode: 'usd' })
    st().reset()
    await st().load()
    expect(st().helper.basis).toBe('stop_mult')
    expect(st().helper.mode).toBe('usd')
  })
  it('the approximation toggle is persisted and starts off', async () => {
    await st().load()
    expect(st().settings?.r_fallback_enabled).toBe(false)
    expect(await st().setApproximation(true)).toBe(true)
    expect(st().settings?.r_fallback_enabled).toBe(true)
  })
})

describe('draft -> placed -> suggested -> confirmed (no automatic promotion)', () => {
  it('a draft is stored under the review id, then the order id is attached on `placed`', async () => {
    expect(await st().putDraft(UUID, fields())).toBe(true)
    await st().load()
    expect(st().drafts).toHaveLength(1)
    expect(st().drafts[0]).toMatchObject({ review_id: UUID, order_id: null, symbol: 'AAA' })
    expect(await st().attachOrder(UUID, 'ord-1')).toBe(true)
    expect(st().drafts[0]).toMatchObject({ order_id: 'ord-1' })
  })
  it('an order whose draft never existed simply has no R (Review Focus 5): no error thrown, a plain note, nothing recorded', async () => {
    expect(await st().attachOrder(UUID2, 'ord-9')).toBe(false)
    expect(st().drafts).toHaveLength(0)
    expect(st().note).toMatch(/no R/i)
  })
  it('a refused draft shows the reason and stores nothing', async () => {
    expect(await st().putDraft(UUID, fields({ planned_risk_usd: 0 }))).toBe(false)
    expect(st().error).toMatch(/planned risk/)
    expect(await st().putDraft('not-a-uuid', fields())).toBe(false)
    await st().load()
    expect(st().drafts).toHaveLength(0)
  })
  it('a closing trade that matches exactly one placed draft is SUGGESTED, never linked on its own', async () => {
    await st().putDraft(UUID, fields())
    await st().attachOrder(UUID, 'ord-1')
    const t = trade('t_close_1')
    await st().refreshStats([t], ACCT)
    expect(st().stats?.suggestions).toEqual([{ review_id: UUID, trade_key: 't_close_1' }])
    expect(st().stats?.with_risk).toBe(0)
    expect((await api.riskGet()).risk).toHaveLength(0)
  })
  it('confirming the suggestion links the draft (source draft, not "after the fact") and the stats pick it up', async () => {
    await st().putDraft(UUID, fields())
    await st().attachOrder(UUID, 'ord-1')
    const t = trade('t_close_1', { realized_gain: 500 })
    await st().refreshStats([t], ACCT)
    expect(await st().confirmSuggestion('t_close_1', UUID)).toBe(true)
    expect(st().stats?.with_risk).toBe(1)
    expect(st().stats?.suggestions).toEqual([])
    expect(st().risk['t_close_1']).toMatchObject({ source: 'draft', after_the_fact: false, planned_risk_usd: 250 })
    expect(st().drafts).toHaveLength(0)
  })
  it('ambiguous matches produce no suggestion (two equal drafts)', async () => {
    await st().putDraft(UUID, fields())
    await st().attachOrder(UUID, 'ord-1')
    await st().putDraft(UUID2, fields())
    await st().attachOrder(UUID2, 'ord-2')
    await st().refreshStats([trade('t_close_1')], ACCT)
    expect(st().stats?.suggestions).toEqual([])
  })
  it('a fill that is not after the order, a different size or the same side is not suggested', async () => {
    await st().putDraft(UUID, fields())
    await st().attachOrder(UUID, 'ord-1')
    await st().refreshStats([trade('a', { timestamp: '2020-01-01T00:00:00Z' }), trade('b', { quantity: 9 }), trade('c', { side: 'buy' })], ACCT)
    expect(st().stats?.suggestions).toEqual([])
  })
  it('manual R any time: stored as source manual and flagged after the fact', async () => {
    await st().refreshStats([trade('t_any')], ACCT)
    const r = await st().saveManual('t_any', { symbol: 'AAA', instrument: 'equity', risk_basis: 'manual_dollars', planned_risk_usd: 120, account_masked: ACCT })
    expect(r).toBe(true)
    expect(st().risk['t_any']).toMatchObject({ source: 'manual', after_the_fact: true, planned_risk_usd: 120 })
    expect(st().stats?.with_risk).toBe(1)
  })
  it('a refused manual entry keeps the old value and shows the reason', async () => {
    await st().saveManual('t_any', { symbol: 'AAA', instrument: 'equity', risk_basis: 'manual_dollars', planned_risk_usd: 120 })
    expect(await st().saveManual('t_any', { symbol: 'AAA', instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: -1 })).toBe(false)
    expect(st().error).toMatch(/planned risk/)
    expect(st().risk['t_any']?.planned_risk_usd).toBe(120)
  })
  it('the stats call carries only the fields it needs and the masked account', async () => {
    await st().refreshStats([trade('t1')], ACCT)
    expect(st().lastTrades).toHaveLength(1)
    await st().refreshStats([trade('t1')], 'AGEN00001234')
    expect(st().error).toMatch(/masked/)
  })
  it('a stale stats answer never overwrites a newer one', async () => {
    const a = st().refreshStats([trade('t1')], ACCT)
    const b = st().refreshStats([trade('t1'), trade('t2')], ACCT)
    await Promise.all([a, b])
    expect(st().stats?.trades_total).toBe(2)
  })
})

describe('session wipe', () => {
  it('drops the trade-derived stats and the held trades; the stored settings stay', async () => {
    await st().load()
    await st().refreshStats([trade('t1')], ACCT)
    st().wipe()
    expect(st().stats).toBeNull()
    expect(st().lastTrades).toEqual([])
    await st().load()
    expect(st().settings?.default_risk_pct).toBe(1)
  })
})

describe('informational only (Review Focus 2)', () => {
  const eqTicket = (o: Record<string, unknown> = {}): Ticket => ({
    kind: 'equity', args: { account_number: 'AGEN0002', symbol: 'AAA', side: 'buy', type: 'limit', quantity: '1', limit_price: '90', time_in_force: 'gfd', market_hours: 'regular_hours', ...o },
  })
  const weird = ['', ' ', '-1', '0', 'NaN', 'Infinity', '-Infinity', '1e999', '9'.repeat(400), 'abc', '\u0000', '5%']

  it('Review and Place state is IDENTICAL with every weird helper input, with and without the helper', () => {
    const t = eqTicket()
    const key = ticketKey(t)
    useOrdersStore.setState({ phase: 'reviewed', ticket: t, reviewKey: key, error: '', outcome: null })
    const snap = () => ({
      blocked: placeBlockedReason(useOrdersStore.getState().ticket),
      key: ticketKey(useOrdersStore.getState().ticket!),
      phase: useOrdersStore.getState().phase,
      review: reviewDisabled({ problem: null, phase: useOrdersStore.getState().phase, key, reviewKey: useOrdersStore.getState().reviewKey }),
      reviewWithProblem: reviewDisabled({ problem: 'x', phase: 'idle', key, reviewKey: null }),
    })
    const before = snap()
    for (const a of weird) {
      for (const b of weird) {
        st().setHelper({ ...DEFAULT_HELPER, kind: 'equity', symbol: 'AAA', side: 'buy', riskPct: a, riskUsd: b, stop: b, entry: a, mode: a === '' ? 'usd' : 'pct' })
        void helperView(st().helper, { equity: null, entryHint: null, creditHint: null, increment: 1, defaultStopMult: 2 })
        st().setHelper({ ...DEFAULT_HELPER, kind: 'option', symbol: 'AAA', side: 'sell', width: a, credit: b, stopBuyback: a, riskUsd: b })
        expect(snap()).toEqual(before)
      }
    }
    expect(useOrdersStore.getState().error).toBe('')
  })
  it('the same table with the helper never touching phase for any phase', () => {
    for (const phase of ['idle', 'reviewing', 'reviewed', 'placing', 'placed', 'awaitingApproval', 'rejected', 'unknown'] as const) {
      useOrdersStore.setState({ phase, ticket: eqTicket(), reviewKey: ticketKey(eqTicket()) })
      st().setHelper({ ...DEFAULT_HELPER, riskPct: 'NaN', stop: '1e999' })
      expect(useOrdersStore.getState().phase).toBe(phase)
    }
  })
  it('reviewDisabled mirrors the ticket button rule', () => {
    const key = 'k'
    expect(reviewDisabled({ problem: null, phase: 'idle', key, reviewKey: null })).toBe(false)
    expect(reviewDisabled({ problem: 'bad', phase: 'idle', key, reviewKey: null })).toBe(true)
    expect(reviewDisabled({ problem: null, phase: 'reviewing', key, reviewKey: null })).toBe(true)
    expect(reviewDisabled({ problem: null, phase: 'placing', key, reviewKey: null })).toBe(true)
    expect(reviewDisabled({ problem: null, phase: 'unknown', key, reviewKey: null })).toBe(true)
    expect(reviewDisabled({ problem: null, phase: 'awaitingApproval', key, reviewKey: key })).toBe(true)
    expect(reviewDisabled({ problem: null, phase: 'awaitingApproval', key, reviewKey: 'other' })).toBe(false)
  })

  const SRC = join(__dirname, '..', 'src')
  const own = ['lib/riskHelper.ts', 'lib/riskUi.ts', 'lib/riskFake.ts', 'lib/riskSizing.ts', 'lib/riskStats.ts', 'lib/riskHeat.ts', 'stores/risk.ts', 'workspace/RiskHelper.tsx', 'workspace/RStatsPane.tsx', 'workspace/TradeRiskEditor.tsx', 'workspace/HeatPanel.tsx', 'workspace/riskDev.tsx']
  const code = (f: string) => readFileSync(join(SRC, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  it('every R file exists and none imports orders, the ticket, fill helpers or any order command', () => {
    const banned = [/from ['"][^'"]*stores\/orders['"]/, /ticketIntent/, /fillTicket/, /cancelAndEdit/, /orderUi/, /orderValidation/, /OrderTicket/, /OrderReview/, /OrdersPane/, /rh_place/, /rh_review/, /rh_cancel/, /rh_decline/, /rhPlaceOrder/, /rhReview/, /rhCancel/, /rhDecline/, /\bplaceOrder\b/, /useOrdersStore/]
    for (const f of own) {
      const c = code(f)
      for (const b of banned) expect(c, `${f} matches ${b}`).not.toMatch(b)
    }
    expect(own.length).toBeGreaterThanOrEqual(12)
  })
  it('the risk store talks to the R commands and the settings table only', () => {
    const calls = [...code('stores/risk.ts').matchAll(/api\.(\w+)/g)].map((m) => m[1]!)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c, c).toMatch(/^(risk[A-Z]|settingGet|settingSet)/)
  })
  it('RiskHelper takes no ticket, phase or problem: its only outward call is onUse(quantity text)', () => {
    const c = code('workspace/RiskHelper.tsx')
    expect(c).not.toMatch(/\b(phase|problem|reviewKey|ticketKey|ticketEdited)\b/)
    expect(c).toMatch(/onUse\(/)
    expect(c).not.toMatch(/disabled=\{[^}]*(problem|phase|blocked)/)
  })
  it('the ticket host never lets a helper value reach the Review button state', () => {
    const host = readFileSync(join(SRC, 'workspace', 'OrderTicketPane.tsx'), 'utf8')
    const m = host.match(/reviewDisabled\(\{[^}]*\}\)/)
    expect(m).not.toBeNull()
    expect(m![0]).not.toMatch(/helper|risk/i)
  })
  it('the R lib/store/panel files have no gate wording or threshold language', () => {
    for (const f of own) expect(code(f), f).not.toMatch(/\b(6-8%|too risky|exceeds your limit|max(imum)? heat|heat limit|risk limit)\b/i)
  })
  it('no new webview command beyond the five R commands in api.ts', () => {
    const src = readFileSync(join(SRC, 'lib', 'api.ts'), 'utf8')
    const cmds = [...src.matchAll(/'(risk_[a-z_]+)'/g)].map((m) => m[1]!)
    expect([...new Set(cmds)].sort()).toEqual(['risk_draft_put', 'risk_get', 'risk_promote', 'risk_set', 'risk_stats'])
  })
  it('the R pane files are all present in workspace/ (no unlisted R file is skipped)', () => {
    const all = [...readdirSync(join(SRC, 'workspace')), ...readdirSync(join(SRC, 'lib')), ...readdirSync(join(SRC, 'stores'))].filter((n) => /^(risk|RStats|RiskHelper|TradeRisk|Heat)/i.test(n))
    for (const n of all) expect(own.some((f) => f.endsWith(n)), n).toBe(true)
  })
})
