import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fake, fakeRh, fakeTm, TM_KEY_SLOT } from '../src/lib/api'
import { useTmStore } from '../src/stores/tm'
import { useWatchSyncStore } from '../src/stores/watchSync'

const st = () => useWatchSyncStore.getState()
const NOW = Date.UTC(2026, 11 - 1, 11, 15, 0, 0)
const inst = (symbol: string) => ({ object_id: `o-${symbol}`, object_type: 'instrument', symbol })
const tmAdds = () => fakeTm.wlLog.filter((l) => l.tool === 'add_to_watchlist')
const rhAdds = () => fakeRh.writeLog.filter((l) => l.tool === 'add_to_watchlist')
const syms = (n: number) => Array.from({ length: n }, (_, i) => `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}Z`)

function seed(extra: string[] = []) {
  fake.secrets.add(TM_KEY_SLOT)
  fakeRh.connected = true
  fakeRh.watchlists = [{ id: 'wl-mine', display_name: 'Mine', icon_emoji: null, item_count: 2 + extra.length, owner_type: 'custom', allowed_object_types: ['instrument'] }]
  fakeRh.items = { 'wl-mine': [inst('AAAA'), inst('BBBB'), ...extra.map(inst)] }
}
async function pick(tm: string, rh: string, dir: 'tm_to_rh' | 'rh_to_tm' | 'both') {
  await st().select('tm', tm)
  await st().select('rh', rh)
  st().setDirection(dir)
}
/** A clock that moves 7 s every time the fake budget looks at it, so the per-minute window never gets in the way of the daily-budget tests. */
const slowClock = (start: number) => {
  let t = start
  fakeTm.quota.now = () => (t += 7_000)
  return { jump: (v: number) => (t = v) }
}

beforeEach(() => {
  fake.reset()
  useWatchSyncStore.getState().reset()
  useTmStore.getState().reset()
})
afterEach(() => useWatchSyncStore.getState().reset())

describe('Review Focus 3: a truncated or preview list is never diffed', () => {
  it('a preview response (free tier, lists cut to 3) computes no plan and Apply does nothing, in every direction', async () => {
    seed(['EEEE', 'FFFF'])
    fakeTm.quota.preview = true
    await st().openDialog()
    expect(st().tmTruncated).toBe(true)
    // even the Desk CSP list, whose 3 preview rows look complete, must not be diffed
    for (const dir of ['tm_to_rh', 'rh_to_tm', 'both'] as const) {
      await pick('102', 'wl-mine', dir)
      expect(st().plan).toBeNull()
      await st().apply()
      expect(tmAdds()).toEqual([])
      expect(rhAdds()).toEqual([])
      expect(st().result).toBeNull()
    }
  })

  it('a list that holds fewer rows than its own count is refused too, even without a preview marker', async () => {
    seed(['EEEE'])
    fakeTm.wl.lists[0]!.ticker_count = 7 // says 7, carries 2
    await st().openDialog()
    expect(st().tmTruncated).toBe(false)
    await pick('101', 'wl-mine', 'both')
    expect(st().plan).toBeNull()
    await st().apply()
    expect(tmAdds()).toEqual([])
    expect(rhAdds()).toEqual([])
  })

  it('once the full lists are readable again the plan is computed', async () => {
    seed(['EEEE'])
    fakeTm.quota.preview = true
    await st().openDialog()
    await pick('101', 'wl-mine', 'rh_to_tm')
    expect(st().plan).toBeNull()
    fakeTm.quota.preview = false
    await st().refresh()
    expect(st().tmTruncated).toBe(false)
    expect(st().plan!.onlyRh).toEqual(['EEEE'])
  })
})

describe('budget-aware pacing (adds only, nothing removed)', () => {
  it('stops cleanly when the daily budget runs low: "N of M done, paused: TM daily budget, resume tomorrow", then resumes after rollover', async () => {
    const extra = syms(30)
    seed(extra)
    fakeTm.quota.enforce = true
    fakeTm.quota.perDay = 20
    fakeTm.quota.perMin = 12
    const clock = slowClock(NOW)
    fakeTm.delayMs = 0
    await st().openDialog()
    await pick('101', 'wl-mine', 'rh_to_tm')
    expect(st().plan!.onlyRh).toHaveLength(30)
    await st().apply()
    const r = st().result!
    const done = r.tmAdded.length + r.already.length
    expect(done).toBeGreaterThan(0)
    expect(done).toBeLessThan(30)
    expect(r.stopped).toMatch(new RegExp(`^${done} of 30 done, paused: TM daily budget, resume tomorrow\\.`))
    expect(r.failed).toEqual([]) // nothing was sent for the rest: not a failure of the symbols
    expect(r.notRun).toBe(30 - done)
    expect(tmAdds()).toHaveLength(done)
    // background calls stop at 20% of the day, so the symbol on screen keeps its calls
    expect(fakeTm.quota.status().remaining).toBeLessThan(20 / 5 + 1)
    expect(fakeTm.quota.status().remaining).toBeGreaterThan(0)
    // tomorrow: the rest, without re-adding what is there
    clock.jump(Date.UTC(2026, 11 - 1, 12, 0, 5, 0))
    fakeTm.quota.perDay = 200
    await st().refresh()
    expect(st().plan!.onlyRh).toHaveLength(30 - done)
    await st().apply()
    const r2 = st().result!
    expect(r2.tmAdded).toHaveLength(30 - done)
    expect(r2.stopped).toBe('')
    expect(new Set(tmAdds().map((l) => l.args.ticker as string)).size).toBe(30)
    expect(fakeTm.wlLog.map((l) => l.tool).filter((t) => !['list_watchlists', 'add_to_watchlist', 'create_watchlist'].includes(t))).toEqual([])
    expect(fakeRh.writeLog.filter((l) => /remove|delete/.test(l.tool))).toEqual([])
  })

  it('sync adds go out as BACKGROUND (they leave 2 per-minute slots free), and the per-minute wall ends the run politely', async () => {
    seed(syms(6))
    fakeTm.quota.enforce = true
    fakeTm.quota.perMin = 4 // background cap 2: the list read took one slot, so exactly one add fits
    fakeTm.quota.now = () => NOW
    await st().openDialog() // the list read is interactive (1 call)
    await pick('101', 'wl-mine', 'rh_to_tm')
    await st().apply()
    const r = st().result!
    expect(r.tmAdded).toHaveLength(1)
    expect(r.stopped).toMatch(/^1 of 6 done, paused: TM per-minute limit, run Apply again in a minute\./)
    expect(r.failed).toEqual([])
    expect(r.notRun).toBe(5)
  })

  it('a paused day at the start: no adds, nothing reported as failed', async () => {
    seed(syms(3))
    fakeTm.quota.enforce = true
    fakeTm.quota.now = () => NOW
    await st().openDialog()
    await pick('101', 'wl-mine', 'rh_to_tm')
    fakeTm.quota.used = 200
    fakeTm.quota.paused = true
    await st().apply()
    const r = st().result!
    expect(tmAdds()).toEqual([])
    expect(r.stopped).toMatch(/^0 of 3 done, paused: TM daily budget, resume tomorrow\./)
    expect(r.failed).toEqual([])
  })

  it('a paused day also shows on the dialog load as the degraded message, not a wall of errors', async () => {
    seed()
    fakeTm.quota.enforce = true
    fakeTm.quota.now = () => NOW
    fakeTm.quota.used = 200
    fakeTm.quota.paused = true
    await st().openDialog()
    expect(st().tmError).toMatch(/^TM paused until 2026-11-12T00:00:00Z/)
    expect(fakeTm.wlLog).toEqual([])
  })
})
