import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeTm, TM_KEY_SLOT, type ApexLevels } from '../src/lib/api'
import { buildOverlayData, selectOverlay, useTmStore } from '../src/stores/tm'
import { TM_DEFAULT_SETTINGS } from '../src/lib/tmUi'

const KEY = 'td_live_TESTKEY' + '0'.repeat(10)
const S = () => useTmStore.getState()
const tools = () => fakeTm.calls.map((c) => c.tool)
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  fake.reset()
  fakeTm.reset()
  useTmStore.getState().reset()
})
afterEach(() => vi.restoreAllMocks())

describe('fake backend serves the REAL fixtures in the Rust (snake_case) shapes', () => {
  beforeEach(() => fake.secretSet(TM_KEY_SLOT, KEY))

  it('apex levels', async () => {
    const a = await api.tmApexLevels('AAPL')
    expect(a).toMatchObject({ symbol: 'AAPL', spot: 348.51, gamma_flip: 343.59, snapshot_time: '2026-11-11T13:11:18.780Z' })
    expect(a.levels).toHaveLength(8)
    expect(a.levels[0]).toMatchObject({ strike: 355, score: 100, rank: 1, total_oi: 72181, is_above_spot: true })
    expect(a.levels[0]!.net_gex).toBeCloseTo(232679707.14, 0)
    expect(a.levels[4]).toMatchObject({ strike: 340, is_above_spot: false })
    expect(a.expirations_used).toHaveLength(5)
    expect(a.available_expirations).toHaveLength(10)
    expect(a.net_gex).toBeCloseTo(507641364.7, 0)
    expect(a.open_url).toContain('/ticker-search/AAPL/gex')
    expect(Object.keys(a)).not.toContain('spotPrice')
    expect(Object.keys(a.levels[0]!)).not.toContain('netGEX')
  })
  it('expected move', async () => {
    const m = await api.tmExpectedMove('AAPL')
    expect(m.horizons).toHaveLength(5)
    const w = m.horizons.find((h) => h.label === '1 week')!
    expect(w).toMatchObject({ calendar_days: 7, trading_days: 5, expected_move_pct: 0.036, band68: { low: 336, high: 362 }, band95: { low: 324, high: 375 }, held68_pct: 0.66, held95_pct: 0.94, sample_days: 1253, extrapolated: false })
    expect(m.spot).toBe(348.51)
    expect(m.as_of).toBe('2026-11-11T09:29:07.403Z')
  })
  it('iv rank keeps 0-100 and the recent change', async () => {
    const v = await api.tmIvRank('AAPL')
    expect(v.iv_rank).toBeCloseTo(37.868, 2)
    expect(v).toMatchObject({ zone: 'mid', source: 'cboe', clamped: null, freshness: 'last_session', as_of: '2026-11-10', reason: null })
    expect(v.recent_change).toMatchObject({ direction: 'down', sessions: 5, from_iv: 0.2443, to_iv: 0.2236, comparable_to_atm_iv: false })
    expect(v.open_url).toContain('/volatility')
  })
  it('snapshot legs', async () => {
    const s = await api.tmSnapshot('AAPL')
    expect(s.quality).toMatchObject({ quality_score: 82, quality_label: 'High quality', sector: 'Technology' })
    expect(s.gamma).toMatchObject({ regime: 'positive_gamma', gamma_flip_level: 342.18, spot_vs_flip: 'above_flip' })
    expect(s.apex?.nearest_level).toMatchObject({ strike: 350, score: 73, side: 'above_spot' })
    expect(s.apex).toMatchObject({ dominant_level_strike: 355, level_count: 8 })
    expect(s.flow).toMatchObject({ bias: 'balanced', conviction: 0.04 })
    expect(s.iv_rank?.iv_rank).toBeCloseTo(37.868, 2)
    expect(s.market_health).toMatchObject({ composite_score: 3.5, label: 'HIGH', alert_count: 3 })
    expect(s.missing).toEqual([])
  })
  it('uppercases the symbol, validates it, and passes the expiration', async () => {
    expect((await api.tmIvRank('msft')).symbol).toBe('MSFT')
    await expect(api.tmIvRank('TOOLONGSYM')).rejects.toThrow(/invalid input/)
    await expect(api.tmApexLevels('AAPL', '11/20/2026')).rejects.toThrow(/invalid input/)
    await api.tmApexLevels('AAPL', '2026-11-20')
    expect(fakeTm.calls.at(-1)).toMatchObject({ tool: 'apex', symbol: 'AAPL', expiration: '2026-11-20' })
  })
})

describe('key state in the fake', () => {
  it('status is presence only and never carries the key', async () => {
    expect(await api.tmStatus()).toEqual({ key_present: false, last_error: null })
    await api.secretSet(TM_KEY_SLOT, KEY)
    const st = await api.tmStatus()
    expect(st.key_present).toBe(true)
    expect(JSON.stringify(st)).not.toContain('td_live_')
  })
  it('a read without a key fails with the Rust message and makes no "request"', async () => {
    await expect(api.tmApexLevels('AAPL')).rejects.toThrow('TraderMatrix key not set')
    expect(fakeTm.calls).toEqual([])
  })
  it('modes: rejected, tier, transport, locked', async () => {
    await api.secretSet(TM_KEY_SLOT, KEY)
    fakeTm.mode = 'rejected'
    await expect(api.tmIvRank('AAPL')).rejects.toThrow('rejected the key')
    expect((await api.tmStatus()).last_error).toContain('rejected the key')
    fakeTm.mode = 'tier'
    await expect(api.tmIvRank('AAPL')).rejects.toThrow(/limit/i)
    fakeTm.mode = 'transport'
    await expect(api.tmIvRank('AAPL')).rejects.toThrow(/transport error/)
    fakeTm.mode = 'locked'
    await expect(api.tmIvRank('AAPL')).rejects.toThrow('vault locked')
    expect(await api.tmStatus()).toMatchObject({ key_present: false })
  })
})

describe('store: loading, cache, de-dupe', () => {
  beforeEach(() => fake.secrets.add(TM_KEY_SLOT))

  it('loads all four legs for a symbol', async () => {
    await S().loadSymbol('aapl')
    const e = S().bySymbol.AAPL!
    expect(e.apex.data?.levels).toHaveLength(8)
    expect(e.move.data?.horizons).toHaveLength(5)
    expect(e.iv.data?.iv_rank).toBeCloseTo(37.87, 1)
    expect(e.snapshot.data?.quality?.sector).toBe('Technology')
    expect(Object.values(e).every((l) => l.error === '' && !l.loading)).toBe(true)
    expect(tools().sort()).toEqual(['apex', 'iv_rank', 'move', 'snapshot'])
  })
  it('only the requested legs are fetched (chart needs apex + move)', async () => {
    await S().loadSymbol('AAPL', ['apex', 'move'])
    expect(tools().sort()).toEqual(['apex', 'move'])
  })
  it('caches: zero calls within the TTL, every leg (apex too, since M20a) refetched after 5 min, force bypasses', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await S().loadSymbol('AAPL')
    expect(fakeTm.calls).toHaveLength(4)
    await S().loadSymbol('AAPL')
    expect(fakeTm.calls).toHaveLength(4)
    now += 61_000 // apex used to expire here (60 s)
    await S().loadSymbol('AAPL')
    expect(fakeTm.calls).toHaveLength(4)
    now += 240_000 // 301 s since the first load
    await S().loadSymbol('AAPL')
    expect(tools().slice(4).sort()).toEqual(['apex', 'iv_rank', 'move', 'snapshot'])
    await S().loadSymbol('AAPL', undefined, true)
    expect(fakeTm.calls).toHaveLength(12)
  })
  it('de-duplicates identical in-flight calls', async () => {
    fakeTm.delayMs = 5
    await Promise.all([S().loadSymbol('AAPL'), S().loadSymbol('AAPL'), S().loadSymbol('AAPL', ['apex'])])
    expect(fakeTm.calls).toHaveLength(4)
  })
  it('different symbols keep separate entries; a slow old symbol never shows under the new one', async () => {
    const slow = new Map<string, (v: ApexLevels) => void>()
    vi.spyOn(api, 'tmApexLevels').mockImplementation((sym) => new Promise((res) => slow.set(sym, res)))
    const a = S().loadSymbol('AAA', ['apex'])
    const b = S().loadSymbol('BBB', ['apex'])
    const mk = (symbol: string): ApexLevels => ({ symbol, spot: 1, snapshot_time: null, gamma_flip: null, net_gex: null, levels: [], expirations_used: [], available_expirations: [], open_url: null })
    await flush()
    slow.get('BBB')!(mk('BBB'))
    await b
    slow.get('AAA')!(mk('AAA'))
    await a
    expect(S().bySymbol.BBB!.apex.data?.symbol).toBe('BBB')
    expect(S().bySymbol.AAA!.apex.data?.symbol).toBe('AAA')
  })
  it('a response that lands after the cache was invalidated is dropped', async () => {
    let first: ((v: ApexLevels) => void) | null = null
    const real = api.tmApexLevels
    const spy = vi.spyOn(api, 'tmApexLevels').mockImplementationOnce(() => new Promise((res) => (first = res)))
    const old = S().loadSymbol('AAPL', ['apex'])
    await flush()
    S().invalidate()
    spy.mockImplementation(real)
    await S().loadSymbol('AAPL', ['apex'])
    const fresh = S().bySymbol.AAPL!.apex.data!
    first!({ ...fresh, spot: 1 })
    await old
    expect(S().bySymbol.AAPL!.apex.data?.spot).toBe(348.51)
  })
  it('rejects an invalid symbol locally with no call', async () => {
    await S().loadSymbol('123', ['apex'])
    expect(S().bySymbol['123']!.apex.error).toMatch(/invalid input/)
    expect(fakeTm.calls).toEqual([])
  })
})

describe('store: failure states', () => {
  it('missing key: every leg says so, zero reads, data null', async () => {
    await S().loadSymbol('AAPL')
    const e = S().bySymbol.AAPL!
    for (const l of [e.apex, e.move, e.iv, e.snapshot]) {
      expect(l.error).toBe('TraderMatrix key not set')
      expect(l.data).toBeNull()
    }
    expect(fakeTm.calls).toEqual([])
    expect(S().status).toEqual({ key_present: false, last_error: null })
  })
  it('rejected key: errors carry the rejected text and the overlay data is gone', async () => {
    fake.secrets.add(TM_KEY_SLOT)
    fakeTm.mode = 'rejected'
    await S().loadSymbol('AAPL')
    expect(S().bySymbol.AAPL!.apex.error).toContain('rejected the key')
    expect(selectOverlay(S(), 'AAPL')).toBeNull()
  })
  it('tier-limit text from TM is passed through plainly', async () => {
    fake.secrets.add(TM_KEY_SLOT)
    fakeTm.mode = 'tier'
    await S().loadSymbol('AAPL', ['iv'])
    expect(S().bySymbol.AAPL!.iv.error).toMatch(/limit/i)
  })
  it('an error clears previous data; a later success restores it; failures are not cached', async () => {
    fake.secrets.add(TM_KEY_SLOT)
    await S().loadSymbol('AAPL', ['apex'])
    fakeTm.mode = 'transport'
    await S().loadSymbol('AAPL', ['apex'], true)
    expect(S().bySymbol.AAPL!.apex.data).toBeNull()
    fakeTm.mode = 'ok'
    await S().loadSymbol('AAPL', ['apex'])
    expect(S().bySymbol.AAPL!.apex.data?.levels).toHaveLength(8)
  })
  it('a snapshot with null legs and a missing list loads fine', async () => {
    fake.secrets.add(TM_KEY_SLOT)
    fakeTm.mutate = (tool, p) => (tool === 'snapshot' ? { ...(p as object), gamma: null, flow: null, missing: ['gamma', 'flow'] } : p)
    await S().loadSymbol('AAPL', ['snapshot'])
    const s = S().bySymbol.AAPL!.snapshot
    expect(s.error).toBe('')
    expect(s.data?.gamma).toBeNull()
    expect(s.data?.missing).toEqual(['gamma', 'flow'])
    expect(s.data?.quality?.quality_score).toBe(82)
  })
})

describe('store: key handling', () => {
  it('a bad key is rejected locally: nothing stored, nothing sent', async () => {
    const spy = vi.spyOn(api, 'secretSet')
    expect(await S().saveKey('nope')).not.toBe('')
    expect(spy).not.toHaveBeenCalled()
  })
  it('saving writes the slot, flips status, drops caches, and the key is in no store state', async () => {
    await S().loadSymbol('AAPL', ['apex'])
    const epoch = S().epoch
    expect(await S().saveKey(KEY)).toBe('')
    expect(fake.secrets.has(TM_KEY_SLOT)).toBe(true)
    expect(S().status?.key_present).toBe(true)
    expect(S().epoch).toBe(epoch + 1)
    expect(S().bySymbol).toEqual({})
    expect(JSON.stringify(S())).not.toContain('td_live_')
    expect(JSON.stringify(fake.settings.get('chart.tm') ?? '')).not.toContain('td_live_')
  })
  it('a failing secret_set surfaces its message without echoing the key', async () => {
    vi.spyOn(api, 'secretSet').mockRejectedValue(new Error('vault locked: unlock it first'))
    const err = await S().saveKey(KEY)
    expect(err).toContain('vault locked')
    expect(err).not.toContain(KEY)
  })
  it('removing the key clears the slot and the cache', async () => {
    fake.secrets.add(TM_KEY_SLOT)
    await S().loadSymbol('AAPL', ['apex'])
    await S().removeKey()
    expect(fake.secrets.has(TM_KEY_SLOT)).toBe(false)
    expect(S().status?.key_present).toBe(false)
    expect(S().bySymbol).toEqual({})
  })
})

describe('store: chart settings', () => {
  it('defaults, then persist toggles and horizon under chart.tm and restore them', async () => {
    expect(S().settings).toEqual(TM_DEFAULT_SETTINGS)
    S().setToggle('apex', true)
    S().setHorizon('2 weeks')
    await flush()
    expect(JSON.parse(fake.settings.get('chart.tm')!)).toMatchObject({ apex: true, horizon: '2 weeks' })
    useTmStore.getState().reset()
    await S().loadSettings()
    expect(S().settings).toMatchObject({ apex: true, horizon: '2 weeks' })
    expect(S().settingsLoaded).toBe(true)
  })
  it('garbage persisted JSON is ignored', async () => {
    fake.settings.set('chart.tm', '{{{ not json')
    await S().loadSettings()
    expect(S().settings).toEqual(TM_DEFAULT_SETTINGS)
  })
})

describe('overlay data selection', () => {
  const apexLeg = (l: ReturnType<typeof S>['bySymbol'][string]) => l
  it('null when every toggle is off or there is no data; present when on and data loaded', async () => {
    fake.secrets.add(TM_KEY_SLOT)
    await S().loadSymbol('AAPL', ['apex', 'move'])
    expect(selectOverlay(S(), 'AAPL')).toBeNull() // defaults: all off
    S().setToggle('apex', true)
    const o = selectOverlay(S(), 'AAPL')!
    expect(o.apex?.levels).toHaveLength(8)
    expect(o.show).toEqual({ apex: true, flip: false, move: false })
    expect(selectOverlay(S(), 'MSFT')).toBeNull()
    void apexLeg
  })
  it('buildOverlayData needs data for an enabled toggle', () => {
    const show = { ...TM_DEFAULT_SETTINGS, flip: true }
    expect(buildOverlayData(show, null, null)).toBeNull()
    expect(buildOverlayData({ ...TM_DEFAULT_SETTINGS, move: true }, null, null)).toBeNull()
  })
})
