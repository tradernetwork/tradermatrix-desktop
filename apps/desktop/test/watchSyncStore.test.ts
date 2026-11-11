import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, fake, fakeRh, fakeTm, TM_KEY_SLOT } from '../src/lib/api'
import { classifyTmError } from '../src/lib/tmUi'
import { useWatchSyncStore } from '../src/stores/watchSync'

const st = () => useWatchSyncStore.getState()
const inst = (symbol: string, object_type = 'instrument') => ({ object_id: `o-${symbol}`, object_type, symbol })

function seed() {
  fake.secrets.add(TM_KEY_SLOT)
  fakeRh.connected = true
  fakeRh.watchlists = [
    { id: 'wl-mine', display_name: 'Mine', icon_emoji: null, item_count: 5, owner_type: 'custom', allowed_object_types: ['instrument'] },
    { id: 'wl-hot', display_name: 'Top Movers', icon_emoji: null, item_count: 1, owner_type: 'robinhood', allowed_object_types: ['instrument'] },
    { id: 'wl-opt', display_name: 'My Options', icon_emoji: null, item_count: 1, owner_type: 'custom', allowed_object_types: ['option_strategy'] },
  ]
  fakeRh.items = {
    'wl-mine': [inst('AAAA'), inst('BBBB'), inst('EEEE'), inst('BF-B'), inst('BTC', 'currency_pair')],
    'wl-hot': [inst('XXXX')],
  }
}

const tmAdds = () => fakeTm.wlLog.filter((l) => l.tool === 'add_to_watchlist')
const rhAdds = () => fakeRh.writeLog.filter((l) => l.tool === 'add_to_watchlist')
const noRemovals = () => {
  expect(fakeRh.writeLog.filter((l) => /remove|delete/.test(l.tool))).toEqual([])
  expect(fakeTm.wlLog.map((l) => l.tool).filter((t) => !['list_watchlists', 'add_to_watchlist', 'create_watchlist'].includes(t))).toEqual([])
}

async function pick(tm: string, rh: string, dir?: 'tm_to_rh' | 'rh_to_tm' | 'both') {
  await st().select('tm', tm)
  await st().select('rh', rh)
  if (dir) st().setDirection(dir)
}

beforeEach(async () => {
  fake.reset()
  useWatchSyncStore.getState().reset()
  seed()
})
afterEach(() => useWatchSyncStore.getState().reset())

describe('open and plan', () => {
  it('loads TM lists and only custom non-options Robinhood lists; nothing is selected yet', async () => {
    await st().openDialog()
    expect(st().open).toBe(true)
    expect(st().tmLists.map((l) => l.name)).toEqual(['My Watchlist', 'Desk CSP', 'Empty list'])
    expect(st().rhLists.map((l) => l.id)).toEqual(['wl-mine'])
    expect(st().tmError).toBe('')
    expect(st().tmSel).toBe('')
    expect(st().plan).toBeNull()
    expect(st().direction).toBe('both')
  })

  it('selecting both lists computes the diff, with skips and reasons', async () => {
    await st().openDialog()
    await pick('101', 'wl-mine')
    const p = st().plan!
    expect(p.both).toEqual(['AAAA', 'BBBB'])
    expect(p.onlyTm).toEqual([])
    expect(p.onlyRh).toEqual(['EEEE'])
    expect(p.skippedForTm.map((s) => s.symbol)).toEqual(['BF-B', 'BTC'])
    expect(p.skippedForTm.find((s) => s.symbol === 'BTC')!.reason).toContain('currency_pair')
  })

  it('the plan follows the selection and ignores a stale response', async () => {
    await st().openDialog()
    await st().select('rh', 'wl-mine')
    const a = st().select('tm', '101')
    const b = st().select('tm', '102')
    await Promise.all([a, b])
    expect(st().tmSel).toBe('102')
    expect(st().plan!.onlyTm).toEqual(['BRK.B', 'CCCC', 'DDDD'])
  })

  it('never exposes TM notes', async () => {
    await st().openDialog()
    await pick('102', 'wl-mine')
    const dump = JSON.stringify({ l: st().tmLists, p: st().plan })
    expect(dump).not.toMatch(/notes|private thesis|SELLING|WATCHING/)
  })

  it('capacity: only what fits goes to TM, the rest is reported', async () => {
    fakeTm.wl.tickers_per_list = 4 // Desk CSP holds 3, so one slot
    fakeRh.items['wl-mine'] = [inst('CCCC'), inst('QQQA'), inst('QQQB'), inst('QQQC')]
    await st().openDialog()
    await pick('102', 'wl-mine', 'rh_to_tm')
    expect(st().plan!.onlyRh).toEqual(['QQQA'])
    expect(st().plan!.skippedForTm.map((s) => s.symbol)).toEqual(['QQQB', 'QQQC'])
    await st().apply()
    expect(tmAdds().map((l) => l.args.ticker)).toEqual(['QQQA'])
    expect(st().result!.skipped.map((s) => s.symbol)).toEqual(['QQQB', 'QQQC'])
  })
})

describe('apply: directions', () => {
  it('TM to Robinhood adds only to Robinhood, once, and nothing to TM', async () => {
    await st().openDialog()
    await pick('102', 'wl-mine', 'tm_to_rh')
    await st().apply()
    expect(rhAdds()).toEqual([{ tool: 'add_to_watchlist', args: { list_id: 'wl-mine', symbols: ['BRK.B', 'CCCC', 'DDDD'] } }])
    expect(tmAdds()).toEqual([])
    expect(st().result!.rhAdded).toEqual(['BRK.B', 'CCCC', 'DDDD'])
    expect(fakeRh.items['wl-mine'].map((i) => i.symbol)).toContain('CCCC')
    noRemovals()
  })

  it('Robinhood to TM adds one symbol per call, by list id, never with notes', async () => {
    await st().openDialog()
    await pick('101', 'wl-mine', 'rh_to_tm')
    await st().apply()
    expect(tmAdds()).toEqual([{ tool: 'add_to_watchlist', args: { ticker: 'EEEE', list: '101' } }])
    expect(rhAdds()).toEqual([])
    expect(st().result!.tmAdded).toEqual(['EEEE'])
    noRemovals()
  })

  it('Both ways does both and then reloads: nothing left to do', async () => {
    await st().openDialog()
    await pick('102', 'wl-mine', 'both')
    await st().apply()
    expect(rhAdds().length).toBe(1)
    expect(tmAdds().map((l) => l.args.ticker)).toEqual(['AAAA', 'BBBB', 'EEEE'])
    expect(st().tmLists.find((l) => l.id === 102)!.tickers).toContain('EEEE')
    expect(st().plan!.onlyTm).toEqual([])
    expect(st().plan!.onlyRh).toEqual([])
    expect(st().phase).toBe('done')
    noRemovals()
  })

  it('Apply with nothing to do makes no write', async () => {
    await st().openDialog()
    await pick('101', 'wl-mine', 'tm_to_rh')
    await st().apply()
    expect(rhAdds()).toEqual([])
    expect(tmAdds()).toEqual([])
    expect(st().result!.rhAdded).toEqual([])
  })

  it('Apply needs both sides chosen', async () => {
    await st().openDialog()
    await st().select('tm', '101')
    await st().apply()
    expect(fakeTm.wlLog.filter((l) => l.tool !== 'list_watchlists')).toEqual([])
    expect(st().result).toBeNull()
  })
})

describe('apply: Robinhood chunks', () => {
  it('120 symbols go in three calls of 50, 50 and 20', async () => {
    const syms = Array.from({ length: 120 }, (_, i) => `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`)
    fakeTm.wl.lists[2].tickers = syms
    fakeTm.wl.lists[2].ticker_count = 120
    await st().openDialog()
    await pick('103', 'wl-mine', 'tm_to_rh')
    await st().apply()
    expect(rhAdds().map((l) => (l.args.symbols as string[]).length)).toEqual([50, 50, 20])
    expect(st().result!.rhAdded.length).toBe(120)
  })

  it('a failed chunk is reported per symbol and the next chunk still runs', async () => {
    const syms = Array.from({ length: 60 }, (_, i) => `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`)
    fakeTm.wl.lists[2].tickers = syms
    fakeTm.wl.lists[2].ticker_count = 60
    await st().openDialog()
    await pick('103', 'wl-mine', 'tm_to_rh')
    let n = 0
    const orig = api.rhWatchlistAdd
    api.rhWatchlistAdd = (id, s) => (++n === 1 ? Promise.reject(new Error('tool error: boom')) : orig(id, s))
    try {
      await st().apply()
    } finally {
      api.rhWatchlistAdd = orig
    }
    expect(st().result!.failed.length).toBe(50)
    expect(st().result!.failed[0]).toMatchObject({ side: 'rh', error: 'tool error: boom' })
    expect(st().result!.rhAdded.length).toBe(10)
  })
})

describe('apply: TM pacing, cancel and failures', () => {
  const fiveOnlyRh = () => {
    fakeRh.items['wl-mine'] = ['QQQA', 'QQQB', 'QQQC', 'QQQD', 'QQQE'].map((s) => inst(s))
  }

  it('reports progress n of m', async () => {
    fiveOnlyRh()
    await st().openDialog()
    await pick('103', 'wl-mine', 'rh_to_tm')
    const seen: string[] = []
    const un = useWatchSyncStore.subscribe((s) => {
      if (s.progress) seen.push(`${s.progress.side}:${s.progress.done}/${s.progress.total}`)
    })
    await st().apply()
    un()
    expect(seen).toContain('tm:0/5')
    expect(seen).toContain('tm:3/5')
    expect(seen[seen.length - 1]).toBe('tm:5/5')
    expect(st().progress).toBeNull()
    expect(st().result!.tmAdded.length).toBe(5)
  })

  it('Cancel is honored between symbols', async () => {
    fiveOnlyRh()
    await st().openDialog()
    await pick('103', 'wl-mine', 'rh_to_tm')
    fakeTm.onWrite = (n) => {
      if (n === 2) st().cancel()
    }
    await st().apply()
    expect(tmAdds().length).toBe(2)
    expect(st().result!.cancelled).toBe(true)
    expect(st().result!.notRun).toBe(3)
    expect(st().result!.tmAdded).toEqual(['QQQA', 'QQQB'])
    // The reload ran: a re-run does only the remaining three.
    expect(st().plan!.onlyRh).toEqual(['QQQC', 'QQQD', 'QQQE'])
  })

  it('one failing symbol never aborts the others', async () => {
    fiveOnlyRh()
    fakeTm.failTickers = new Set(['QQQB', 'QQQD'])
    await st().openDialog()
    await pick('103', 'wl-mine', 'rh_to_tm')
    await st().apply()
    expect(tmAdds().length).toBe(5)
    expect(st().result!.failed.map((f) => f.symbol)).toEqual(['QQQB', 'QQQD'])
    expect(st().result!.tmAdded).toEqual(['QQQA', 'QQQC', 'QQQE'])
    expect(st().result!.stopped).toBe('')
  })

  it('three consecutive TM failures stop the run with a clear message', async () => {
    fiveOnlyRh()
    fakeTm.failAdds = 'tool error: List cap reached (synthetic)'
    await st().openDialog()
    await pick('103', 'wl-mine', 'rh_to_tm')
    await st().apply()
    expect(tmAdds().length).toBe(3)
    expect(st().result!.failed.length).toBe(3)
    expect(st().result!.notRun).toBe(2)
    expect(st().result!.stopped).toMatch(/3 .*in a row/i)
  })

  it('a success resets the consecutive-failure counter', async () => {
    fakeRh.items['wl-mine'] = ['QQQA', 'QQQB', 'QQQC', 'QQQD', 'QQQE', 'QQQF', 'QQQG'].map((s) => inst(s))
    fakeTm.failTickers = new Set(['QQQA', 'QQQB', 'QQQD', 'QQQE'])
    await st().openDialog()
    await pick('103', 'wl-mine', 'rh_to_tm')
    await st().apply()
    expect(tmAdds().length).toBe(7)
    expect(st().result!.stopped).toBe('')
  })

  it('a rejected, missing or locked key stops at once with its own message', async () => {
    fiveOnlyRh()
    await st().openDialog()
    await pick('103', 'wl-mine', 'rh_to_tm')
    fakeTm.mode = 'rejected'
    await st().apply()
    expect(tmAdds().length).toBe(1)
    expect(st().result!.stopped).toMatch(/rejected/i)
    expect(st().result!.notRun).toBe(4)
  })

  it('partial failure, then a re-run does only the remaining work', async () => {
    fiveOnlyRh()
    fakeTm.failTickers = new Set(['QQQC'])
    await st().openDialog()
    await pick('103', 'wl-mine', 'rh_to_tm')
    await st().apply()
    expect(st().result!.failed.map((f) => f.symbol)).toEqual(['QQQC'])
    expect(st().plan!.onlyRh).toEqual(['QQQC'])
    fakeTm.wlLog.length = 0
    fakeTm.failTickers = new Set()
    await st().apply()
    expect(tmAdds().map((l) => l.args.ticker)).toEqual(['QQQC'])
    expect(st().result!.tmAdded).toEqual(['QQQC'])
    expect(st().plan!.onlyRh).toEqual([])
  })

  it('added:false counts as already there, not as an error', async () => {
    await st().openDialog()
    await pick('101', 'wl-mine', 'rh_to_tm')
    expect(st().plan!.onlyRh).toEqual(['EEEE'])
    // Somebody else adds it between the diff and Apply.
    await api.tmWatchlistAdd('101', 'EEEE')
    fakeTm.wlLog.length = 0
    await st().apply()
    expect(tmAdds().length).toBe(1)
    expect(st().result!.already).toEqual(['EEEE'])
    expect(st().result!.failed).toEqual([])
    expect(st().result!.tmAdded).toEqual([])
  })

  it('a second Apply while one is running is ignored', async () => {
    fiveOnlyRh()
    await st().openDialog()
    await pick('103', 'wl-mine', 'rh_to_tm')
    await Promise.all([st().apply(), st().apply()])
    expect(tmAdds().length).toBe(5)
  })
})

describe('create new lists', () => {
  it('TM new: the new TM list is named like the Robinhood list, created first and only because it is needed', async () => {
    await st().openDialog()
    await pick('new', 'wl-mine', 'rh_to_tm')
    await st().apply()
    const log = fakeTm.wlLog.filter((l) => l.tool !== 'list_watchlists')
    expect(log[0]).toEqual({ tool: 'create_watchlist', args: { name: 'Mine' } })
    expect(log.slice(1).map((l) => l.args.ticker)).toEqual(['AAAA', 'BBBB', 'EEEE'])
    expect(log[1].args.list).toBe('104')
    expect(st().tmSel).toBe('104')
    expect(st().tmLists.some((l) => l.name === 'Mine')).toBe(true)
    noRemovals()
  })

  it('TM new with a direction that does not fill it creates nothing', async () => {
    await st().openDialog()
    await pick('new', 'wl-mine', 'tm_to_rh')
    await st().apply()
    expect(fakeTm.wlLog.filter((l) => l.tool === 'create_watchlist')).toEqual([])
    expect(st().tmSel).toBe('new')
  })

  it('Robinhood new: named like the TM list, created, then filled in chunks', async () => {
    await st().openDialog()
    await pick('102', 'new', 'tm_to_rh')
    await st().apply()
    expect(fakeRh.writeLog.map((l) => l.tool)).toEqual(['create_watchlist', 'add_to_watchlist'])
    expect(fakeRh.writeLog[0].args).toEqual({ display_name: 'Desk CSP' })
    expect(st().rhSel).not.toBe('new')
    expect(fakeRh.watchlists.find((w) => w.display_name === 'Desk CSP')).toBeTruthy()
    expect(st().rhLists.some((l) => l.display_name === 'Desk CSP')).toBe(true)
    expect(st().result!.rhAdded).toEqual(['BRK.B', 'CCCC', 'DDDD'])
    noRemovals()
  })

  it('TM list creation failure aborts before any add', async () => {
    fakeTm.wl.max_lists = 3
    await st().openDialog()
    await pick('new', 'wl-mine', 'rh_to_tm')
    await st().apply()
    expect(tmAdds()).toEqual([])
    expect(rhAdds()).toEqual([])
    expect(st().result!.aborted).toMatch(/cap/i)
    expect(st().tmSel).toBe('new')
  })

  it('Robinhood list creation failure aborts before any add', async () => {
    fakeRh.failWrite = 'tool error: boom'
    await st().openDialog()
    await pick('102', 'new', 'tm_to_rh')
    await st().apply()
    expect(rhAdds()).toEqual([])
    expect(st().result!.aborted).toMatch(/boom/)
  })

  it('a TM name Robinhood would refuse aborts with the reason and sends nothing', async () => {
    fakeTm.wl.lists[1].name = 'x'.repeat(55)
    await st().openDialog()
    await pick('102', 'new', 'tm_to_rh')
    await st().apply()
    expect(fakeRh.writeLog).toEqual([])
    expect(st().result!.aborted).toMatch(/50/)
  })
})

describe('TM unavailable or limited', () => {
  it.each([
    ['missing', (): void => void fake.secrets.delete(TM_KEY_SLOT), 'key_missing'],
    ['rejected', (): void => void (fakeTm.mode = 'rejected'), 'rejected'],
    ['locked', (): void => void (fakeTm.mode = 'locked'), 'locked'],
    ['tier', (): void => void (fakeTm.mode = 'tier'), 'tier'],
  ] as const)('%s: a distinct kind, the Robinhood side still loads and nothing is applied', async (_n, setup, kind) => {
    setup()
    await st().openDialog()
    expect(classifyTmError(st().tmError)).toBe(kind)
    expect(st().tmLists).toEqual([])
    expect(st().rhLists.map((l) => l.id)).toEqual(['wl-mine'])
    await st().select('rh', 'wl-mine')
    expect(st().plan).toBeNull()
    await st().apply()
    expect(rhAdds()).toEqual([])
    expect(st().result).toBeNull()
  })

  it('TM writes failing never block the TM to Robinhood direction', async () => {
    fakeTm.failAdds = 'tool error: List cap reached (synthetic)'
    await st().openDialog()
    await pick('102', 'new', 'tm_to_rh')
    await st().apply()
    expect(st().result!.rhAdded).toEqual(['BRK.B', 'CCCC', 'DDDD'])
    expect(tmAdds()).toEqual([])
  })
})

describe('remembered pairing', () => {
  it('round-trips through settings and is restored on open', async () => {
    await st().openDialog()
    await pick('102', 'wl-mine', 'rh_to_tm')
    expect(JSON.parse((await api.settingGet('watch.sync.pair'))!)).toEqual({ tm: '102', rh: 'wl-mine' })
    st().reset()
    await st().openDialog()
    expect(st().tmSel).toBe('102')
    expect(st().rhSel).toBe('wl-mine')
    expect(st().plan).not.toBeNull()
  })

  it('garbage and stale ids are ignored per side', async () => {
    await api.settingSet('watch.sync.pair', 'not json')
    await st().openDialog()
    expect([st().tmSel, st().rhSel]).toEqual(['', ''])
    st().reset()
    await api.settingSet('watch.sync.pair', JSON.stringify({ tm: '999', rh: 'wl-mine' }))
    await st().openDialog()
    expect([st().tmSel, st().rhSel]).toEqual(['', 'wl-mine'])
    st().reset()
    await api.settingSet('watch.sync.pair', JSON.stringify({ tm: 5, rh: { a: 1 } }))
    await st().openDialog()
    expect([st().tmSel, st().rhSel]).toEqual(['', ''])
  })

  it('a created list replaces "new" in the remembered pair', async () => {
    await st().openDialog()
    await pick('new', 'wl-mine', 'rh_to_tm')
    await st().apply()
    expect(JSON.parse((await api.settingGet('watch.sync.pair'))!)).toEqual({ tm: '104', rh: 'wl-mine' })
  })
})

describe('no removal path exists', () => {
  it('api has no TM remove/delete/update/move wrapper', () => {
    const names = Object.keys(api).filter((k) => k.startsWith('tm'))
    expect(names).toEqual(expect.arrayContaining(['tmWatchlists', 'tmWatchlistAdd', 'tmWatchlistCreate']))
    expect(names.filter((k) => /remove|delete|update|move.*watchlist/i.test(k))).toEqual([])
  })
  it('the sync store source never references a removal wrapper', () => {
    const src = readFileSync(new URL('../src/stores/watchSync.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/rhWatchlistRemove|rhWatchlistUpdate|rhOptionWatchlist|remove_|delete_|update_watchlist/)
  })
  it('the fake TM refuses a removal-shaped call (the mock must fail on one)', () => {
    expect(() => (fakeTm as unknown as { callTool(t: string): void }).callTool('remove_from_watchlist')).toThrow(/not allowed/)
    expect(() => (fakeTm as unknown as { callTool(t: string): void }).callTool('delete_watchlist')).toThrow(/not allowed/)
  })
})
