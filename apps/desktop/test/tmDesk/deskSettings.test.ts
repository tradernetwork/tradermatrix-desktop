import { describe, expect, it } from 'vitest'
import { createOverlayMemo } from '../../src/chart/tmDesk/overlay'
import { cycleLayer, DEFAULT_DESK_SETTINGS, DESK_SETTING_KEY, parseDeskSettings, resolveAtr, serializeDeskSettings, soloLayer } from '../../src/chart/tmDesk/deskSettings'
import { DESK_INDICATOR_NAME, registerDeskIndicator } from '../../src/chart/tmDesk/deskIndicator'

describe('deskSettings', () => {
  it('key and defaults', () => {
    expect(DESK_SETTING_KEY).toBe('tmdesk.overlay.v1')
    expect(DEFAULT_DESK_SETTINGS).toEqual({ fib: 'key', fvg: false, sma: { p20: false, p50: true, p200: true }, atr: 'auto', narrow: false, lookbackOverride: null, ladder: false })
  })
  it('round trip', () => {
    const s = { fib: 'all' as const, fvg: true, sma: { p20: true, p50: false, p200: true }, atr: 'on' as const, narrow: true, lookbackOverride: 150, ladder: true }
    expect(parseDeskSettings(serializeDeskSettings(s))).toEqual(s)
  })
  it('garbage, corrupt JSON and unknown versions give the defaults', () => {
    for (const raw of [null, undefined, '', 'nope{', '[]', '42', 'null', '{"v":2,"fib":"all"}', '{"fib":"all"}']) {
      expect(parseDeskSettings(raw)).toEqual(DEFAULT_DESK_SETTINGS)
    }
  })
  it('bad fields fall back one by one', () => {
    const r = parseDeskSettings('{"v":1,"fib":"zzz","fvg":"yes","sma":5,"atr":"on","narrow":true,"lookbackOverride":99999}')
    expect(r.fib).toBe('key')
    expect(r.fvg).toBe(false)
    expect(r.sma).toEqual(DEFAULT_DESK_SETTINGS.sma)
    expect(r.atr).toBe('on')
    expect(r.narrow).toBe(true)
    expect(r.lookbackOverride).toBe(500)
  })
  it('solo', () => {
    const f = soloLayer(DEFAULT_DESK_SETTINGS, 'fvg')
    expect(f.fvg).toBe(true)
    expect(f.fib).toBe('off')
    expect(f.atr).toBe('off')
    expect(f.sma).toEqual({ p20: false, p50: false, p200: false })
    expect(soloLayer(DEFAULT_DESK_SETTINGS, 'atr').atr).toBe('on')
    expect(soloLayer({ ...DEFAULT_DESK_SETTINGS, fib: 'all' }, 'fib').fib).toBe('all')
    expect(soloLayer(DEFAULT_DESK_SETTINGS, 'sma').sma).toEqual({ p20: true, p50: true, p200: true })
  })
})

describe('resolveAtr (side from the position sign)', () => {
  const pos = (symbol: string, quantity: number | null) => ({ symbol, quantity, average_buy_price: 1, shares_available_for_sells: 0, shares_held_for_sells: 0 })
  it('auto: off without a position, on with one, side from the sign', () => {
    expect(resolveAtr('auto', 'AAPL', [])).toEqual({ show: false, side: 'long' })
    expect(resolveAtr('auto', 'AAPL', [pos('MSFT', 5)])).toEqual({ show: false, side: 'long' })
    expect(resolveAtr('auto', 'AAPL', [pos('AAPL', 5)])).toEqual({ show: true, side: 'long' })
    expect(resolveAtr('auto', 'AAPL', [pos('AAPL', -3)])).toEqual({ show: true, side: 'short' })
    expect(resolveAtr('auto', 'AAPL', [pos('AAPL', 0)])).toEqual({ show: false, side: 'long' })
    expect(resolveAtr('auto', 'AAPL', [pos('AAPL', null)])).toEqual({ show: false, side: 'long' })
  })
  it('on: always shown, position side when there is one, else long; off never', () => {
    expect(resolveAtr('on', 'AAPL', [])).toEqual({ show: true, side: 'long' })
    expect(resolveAtr('on', 'AAPL', [pos('AAPL', -1)])).toEqual({ show: true, side: 'short' })
    expect(resolveAtr('off', 'AAPL', [pos('AAPL', 9)]).show).toBe(false)
  })
})

describe('overlay memo (5 s live updates)', () => {
  const opts = { lookbackOverride: null, narrow: false, side: 'long' as const, fvg: true }
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: i * 86_400_000, open: 10, high: 11, low: 9, close: 10 + (i % 3), volume: 1 }))
  it('recomputes only when opts, tf, count, first ts or the last bar change', () => {
    const memo = createOverlayMemo()
    const bars = mk(150)
    const a = memo.get(bars, '1D', opts)
    expect(memo.get(bars, '1D', opts)).toBe(a) // pan: same inputs
    expect(memo.computes).toBe(1)
    const mutated = bars.map((b, i) => (i === 149 ? { ...b, close: b.close + 0.5 } : b))
    expect(memo.get(mutated, '1D', opts)).not.toBe(a)
    expect(memo.computes).toBe(2)
    memo.get(mutated, '1W', opts)
    expect(memo.computes).toBe(3)
    memo.get(mutated, '1W', { ...opts, narrow: true })
    expect(memo.computes).toBe(4)
    memo.get(mk(151), '1W', { ...opts, narrow: true })
    expect(memo.computes).toBe(5)
  })
})

describe('rebull-tmdesk indicator', () => {
  it('registers once with NO figures (never stretches the y-axis)', () => {
    const reg: { t?: Record<string, unknown>; n: number } = { n: 0 }
    const klc = { registerIndicator: (t: Record<string, unknown>) => { reg.t = t; reg.n++ } } as unknown as typeof import('klinecharts')
    registerDeskIndicator(klc)
    registerDeskIndicator(klc)
    expect(reg.n).toBe(1)
    expect(reg.t!.name).toBe(DESK_INDICATOR_NAME)
    expect(DESK_INDICATOR_NAME).toBe('rebull-tmdesk')
    expect(reg.t!.figures).toEqual([])
    expect((reg.t!.calc as (d: unknown[]) => unknown[])([1, 2])).toEqual([{}, {}])
  })
})

describe('cycleLayer and anyLayer', () => {
  it('cycles', async () => {
    const { cycleLayer, anyLayer } = await import('../../src/chart/tmDesk/deskSettings')
    const s = DEFAULT_DESK_SETTINGS
    expect(cycleLayer(s, 'fib').fib).toBe('all')
    expect(cycleLayer(cycleLayer(s, 'fib'), 'fib').fib).toBe('off')
    expect(cycleLayer({ ...s, fib: 'off' }, 'fib').fib).toBe('key')
    expect(cycleLayer(s, 'fvg').fvg).toBe(true)
    expect(cycleLayer(s, 'sma').sma).toEqual({ p20: false, p50: false, p200: false })
    expect(cycleLayer(cycleLayer(s, 'sma'), 'sma').sma).toEqual(DEFAULT_DESK_SETTINGS.sma)
    expect(cycleLayer(s, 'atr').atr).toBe('on')
    expect(cycleLayer({ ...s, atr: 'on' }, 'atr').atr).toBe('off')
    expect(anyLayer({ ...s, fib: 'off', sma: { p20: false, p50: false, p200: false } }, false)).toBe(false)
    expect(anyLayer({ ...s, fib: 'off', sma: { p20: false, p50: false, p200: false } }, true)).toBe(true)
  })
})

describe('ladder setting (M13)', () => {
  it('defaults off, round-trips, falls back per field, and survives solo/cycle', () => {
    expect(DEFAULT_DESK_SETTINGS.ladder).toBe(false)
    const on = { ...DEFAULT_DESK_SETTINGS, ladder: true }
    expect(parseDeskSettings(serializeDeskSettings(on)).ladder).toBe(true)
    expect(parseDeskSettings('{"v":1,"ladder":"yes"}').ladder).toBe(false)
    expect(parseDeskSettings('{"v":1,"fib":"all"}').ladder).toBe(false)
    expect(soloLayer(on, 'fvg').ladder).toBe(true)
    expect(cycleLayer(on, 'fib').ladder).toBe(true)
  })
})
