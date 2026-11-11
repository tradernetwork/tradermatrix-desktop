import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeTm, TM_KEY_SLOT } from '../src/lib/api'
import { isPaused } from '../src/lib/tmQuota'
import { ALL_LEGS, SETTLE_MS, useTmStore } from '../src/stores/tm'

const KEY = 'td_live_TESTKEY' + '0'.repeat(10)
const S = () => useTmStore.getState()
const NOW = Date.UTC(2026, 11 - 1, 11, 15, 0, 0)
const MIDNIGHT = Date.UTC(2026, 11 - 1, 12, 0, 0, 0)

beforeEach(() => {
  fake.reset()
  fakeTm.reset()
  useTmStore.getState().reset()
  fake.secretSet(TM_KEY_SLOT, KEY)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Review Focus 2 (store side): a paused day sends nothing', () => {
  it('the store honors paused without calling the backend at all', async () => {
    fakeTm.quota.now = () => NOW
    fakeTm.quota.enforce = true
    fakeTm.quota.used = 200
    fakeTm.quota.paused = true
    await S().refreshQuota()
    expect(isPaused(S().quota, NOW)).toBe(true)
    const spies = [vi.spyOn(api, 'tmIvRank'), vi.spyOn(api, 'tmApexLevels'), vi.spyOn(api, 'tmExpectedMove'), vi.spyOn(api, 'tmSnapshot')]
    await S().loadSymbol('AAPL')
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    expect(fakeTm.calls).toEqual([])
    for (const l of ALL_LEGS) expect(S().bySymbol.AAPL![l].error).toMatch(/^TM paused until 2026-11-12T00:00:00Z: daily budget used \(200 of 200 calls\)/)
  })

  it('and when the store does not know yet, the backend refuses with zero requests and the store learns it', async () => {
    fakeTm.quota.now = () => NOW
    fakeTm.quota.enforce = true
    fakeTm.quota.used = 200
    fakeTm.quota.paused = true
    expect(S().quota).toBeNull()
    await S().loadSymbol('AAPL', ['iv'])
    expect(fakeTm.calls).toEqual([])
    expect(S().bySymbol.AAPL!.iv.error).toMatch(/^TM paused until/)
    expect(isPaused(S().quota, NOW)).toBe(true)
    // the next load does not even try
    const spy = vi.spyOn(api, 'tmIvRank')
    await S().loadSymbol('MSFT', ['iv'])
    expect(spy).not.toHaveBeenCalled()
  })

  it('when the pause ends the panes are told (epoch bump) and loading works again', async () => {
    let now = NOW
    fakeTm.quota.now = () => now
    fakeTm.quota.enforce = true
    fakeTm.quota.used = 200
    fakeTm.quota.paused = true
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await S().refreshQuota()
    const epoch = S().epoch
    now = MIDNIGHT + 1_000
    await S().refreshQuota()
    expect(isPaused(S().quota, now)).toBe(false)
    expect(S().epoch).toBe(epoch + 1)
    await S().loadSymbol('AAPL', ['iv'])
    expect(S().bySymbol.AAPL!.iv.data?.symbol).toBe('AAPL')
    expect(S().quota!.used).toBe(1)
  })

  it('fresh cached data is still served while paused', async () => {
    fakeTm.quota.now = () => NOW
    vi.spyOn(Date, 'now').mockImplementation(() => NOW)
    await S().loadSymbol('AAPL', ['iv'])
    expect(S().bySymbol.AAPL!.iv.data).not.toBeNull()
    fakeTm.quota.enforce = true
    fakeTm.quota.paused = true
    await S().refreshQuota()
    await S().loadSymbol('AAPL', ['iv'])
    expect(S().bySymbol.AAPL!.iv.data).not.toBeNull()
    expect(S().bySymbol.AAPL!.iv.error).toBe('')
  })
})

describe('priorities reach the core', () => {
  it('interactive spends the last calls; opportunistic and background are refused under 20% (alert polling never starves the screen)', async () => {
    fakeTm.quota.now = () => NOW
    fakeTm.quota.enforce = true
    fakeTm.quota.perMin = 12
    fakeTm.quota.used = 190 // 10 of 200 left
    await S().loadSymbol('AAA', ['iv'], false, 'opportunistic')
    await S().loadSymbol('BBB', ['iv'], false, 'background')
    expect(fakeTm.calls).toEqual([])
    expect(S().bySymbol.AAA!.iv.error).toMatch(/^TM paused until .*daily budget nearly used/)
    await S().loadSymbol('CCC', ['iv'])
    expect(fakeTm.calls.map((c) => c.symbol)).toEqual(['CCC'])
  })

  it('every TM read from the alerts feed goes out as opportunistic (source check)', () => {
    const src = readFileSync(new URL('../src/stores/alertFeeds.ts', import.meta.url), 'utf8')
    const loads = [...src.matchAll(/loadSymbol\(([^)]*)\)/g)].map((m) => m[1]!)
    expect(loads.length).toBeGreaterThanOrEqual(2)
    for (const l of loads) expect(l, l).toContain("'opportunistic'")
  })

  it('the positions pane loads its short underlyings as background (source check)', () => {
    const src = readFileSync(new URL('../src/workspace/PositionsPane.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/loadSymbol\(u, \['apex', 'move', 'iv'\], false, 'background'\)/)
  })
})

describe('Review Focus 4: five symbol switches in ten seconds', () => {
  const syms = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE']
  const settle = () => vi.advanceTimersByTimeAsync(SETTLE_MS + 500)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    fakeTm.quota.now = () => Date.now()
    fakeTm.quota.enforce = true
  })

  it('costs at most 4 calls for the final symbol, nothing for the symbols passed through, and never breaks the per-minute budget', async () => {
    for (const s of syms) {
      S().scheduleSymbol('insight', s)
      await vi.advanceTimersByTimeAsync(2000)
    }
    await settle()
    const bySym = (s: string) => fakeTm.calls.filter((c) => c.symbol === s).length
    expect(bySym('EEEE')).toBeLessThanOrEqual(4)
    expect(bySym('EEEE')).toBe(4)
    for (const s of ['BBBB', 'CCCC', 'DDDD']) expect(bySym(s), s).toBe(0)
    expect(fakeTm.calls.length).toBeLessThanOrEqual(8) // the surface's first symbol loads at once, then only the last one
    expect(fakeTm.quota.status().window_used).toBeLessThanOrEqual(10)
    expect(fakeTm.quota.used).toBe(fakeTm.calls.length)
  })

  it('the chart and the insight pane both following the same final symbol still cost its legs once (cache + in-flight dedupe)', async () => {
    fakeTm.delayMs = 50
    for (const s of syms) {
      S().scheduleSymbol('insight', s)
      S().scheduleSymbol('chart', s, ['apex', 'move'])
      await vi.advanceTimersByTimeAsync(2000)
    }
    await settle()
    const final = fakeTm.calls.filter((c) => c.symbol === 'EEEE')
    expect(final.length).toBeLessThanOrEqual(4)
    expect(new Set(final.map((c) => c.tool)).size).toBe(final.length)
  })

  it('switching to a symbol whose data is cached loads at once and costs nothing', async () => {
    S().scheduleSymbol('insight', 'AAAA')
    await vi.advanceTimersByTimeAsync(10)
    const n = fakeTm.calls.length
    S().scheduleSymbol('insight', 'BBBB')
    await settle()
    S().scheduleSymbol('insight', 'AAAA') // cached (within 5 min)
    await vi.advanceTimersByTimeAsync(10)
    expect(fakeTm.calls.filter((c) => c.symbol === 'AAAA').length).toBe(4)
    expect(fakeTm.calls.length).toBe(n + 4)
  })

  it('a reload after the cache was dropped (key saved) is immediate, not delayed', async () => {
    S().scheduleSymbol('insight', 'AAAA')
    await vi.advanceTimersByTimeAsync(10)
    S().invalidate()
    S().scheduleSymbol('insight', 'BBBB')
    await vi.advanceTimersByTimeAsync(10)
    expect(fakeTm.calls.some((c) => c.symbol === 'BBBB')).toBe(true)
  })

  it('wipe cancels a pending load', async () => {
    S().scheduleSymbol('insight', 'AAAA')
    await vi.advanceTimersByTimeAsync(10)
    S().scheduleSymbol('insight', 'BBBB')
    S().wipe()
    await settle()
    expect(fakeTm.calls.some((c) => c.symbol === 'BBBB')).toBe(false)
  })
})

describe('budgets', () => {
  it('saveBudgets validates in the core and the store takes the new numbers', async () => {
    expect(await S().saveBudgets(6, 80)).toBe('')
    expect(S().quota).toMatchObject({ per_min: 6, per_day: 80, limit: 80 })
    expect(await S().saveBudgets(13, 80)).toMatch(/calls per minute must be 1 to 12/)
    expect(S().quota).toMatchObject({ per_min: 6 })
  })
  it('the fake counts every call that reaches TM and the chip numbers follow', async () => {
    await S().loadSymbol('AAPL')
    expect(S().quota!.used).toBe(4)
    await S().loadSymbol('AAPL') // cached
    expect(S().quota!.used).toBe(4)
  })
})
