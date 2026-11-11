import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fake, fakeRh } from '../src/lib/api'
import { EARNINGS_TTL_MS, earningsStatus, useEarningsStore } from '../src/stores/earnings'
import { useRhStore } from '../src/stores/rh'
import { wipeSession } from '../src/stores/session'

const S = () => useEarningsStore.getState()
const NEXT = { next: { date: '2026-12-10', timing: 'pm', verified: true }, last: { date: '2026-08-01', timing: 'am', verified: true } }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  fake.reset()
  useEarningsStore.setState({ bySymbol: {} })
  await useRhStore.getState().connect()
  fakeRh.earningsBySymbol = { AAA: NEXT }
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('earnings store', () => {
  it('loads once and serves the cache until the TTL (5 min) passes', async () => {
    await S().load('aaa')
    expect(S().bySymbol.AAA!.data).toEqual(NEXT)
    expect(S().bySymbol.AAA!.error).toBe('')
    await S().load('AAA')
    expect(fakeRh.earningsCalls).toEqual(['AAA'])
    vi.setSystemTime(Date.now() + EARNINGS_TTL_MS - 1)
    await S().load('AAA')
    expect(fakeRh.earningsCalls).toHaveLength(1)
    vi.setSystemTime(Date.now() + 2)
    await S().load('AAA')
    expect(fakeRh.earningsCalls).toHaveLength(2)
    await S().load('AAA', true)
    expect(fakeRh.earningsCalls).toHaveLength(3)
  })
  it('de-duplicates concurrent loads of the same symbol', async () => {
    await Promise.all([S().load('AAA'), S().load('AAA'), S().load('aaa')])
    expect(fakeRh.earningsCalls).toEqual(['AAA'])
  })
  it('an error is kept as unknown (no data, message), failures are not cached, and the next call retries', async () => {
    fakeRh.failEarnings = 'tool error: nope'
    await S().load('AAA')
    expect(S().bySymbol.AAA).toMatchObject({ data: null, error: 'tool error: nope', loading: false })
    expect(earningsStatus(S().bySymbol.AAA)).toBe('unknown')
    fakeRh.failEarnings = null
    await S().load('AAA')
    expect(S().bySymbol.AAA!.data).toEqual(NEXT)
    expect(earningsStatus(S().bySymbol.AAA)).toBe('ok')
    expect(earningsStatus(undefined)).toBe('unknown')
  })
  it('an invalid symbol sends nothing', async () => {
    await S().load('A B; x')
    expect(fakeRh.earningsCalls).toEqual([])
  })
  it('a symbol with no row answers ok with next null (known: no scheduled earnings)', async () => {
    await S().load('ZZZ')
    expect(S().bySymbol.ZZZ!.data).toEqual({ next: null, last: null })
    expect(earningsStatus(S().bySymbol.ZZZ)).toBe('ok')
  })
  it('wipeSession drops the cache and an answer that lands afterwards is ignored', async () => {
    await S().load('AAA')
    const pending = S().load('BBB')
    wipeSession()
    await pending
    expect(S().bySymbol).toEqual({})
  })
})
