import { describe, expect, it } from 'vitest'
import { compile, createSession, run } from '../src/index'
import type { Bar } from '../src/types'
import { walk } from './fixtures/walk'

const SRC = [
  'var n = 0',
  'n := n + 1',
  'e = ind.ema(close, 5)',
  'r = ind.rsi(close, 7)',
  'x = iff(crossover(close, e), 1, 0)',
  'plt(n, name="n")',
  'plt(e, name="e")',
  'plt(r, name="r")',
  'plt(x, name="x")',
].join('\n')

describe('live session', () => {
  it('50x updateLast then append equals a full run (var not double counted)', () => {
    const bars = walk(301)
    const s = createSession(compile(SRC), bars.slice(0, 300))
    let last = bars[299]
    for (let i = 0; i < 50; i++) {
      last = { ...bars[299], close: bars[299].close * (1 + (i % 7) * 0.001), high: bars[299].high * 1.01 }
      s.updateLast(last)
    }
    s.updateLast(bars[299])
    const got = s.append(bars[300])
    const want = run(compile(SRC), bars)
    expect(got.plots.map((p) => Array.from(p.values))).toEqual(want.plots.map((p) => Array.from(p.values)))
    expect(got.plots[0].values[300]).toBe(301)
  })
  it('append many bars one at a time equals batch', () => {
    const bars = walk(120)
    const s = createSession(compile(SRC), bars.slice(0, 20))
    let out = s.output()
    for (const b of bars.slice(20)) out = s.append(b)
    expect(out.plots.map((p) => Array.from(p.values))).toEqual(run(compile(SRC), bars).plots.map((p) => Array.from(p.values)))
  })
})

describe('requestbar', () => {
  it('returns the previous completed daily close for hourly bars', () => {
    const day = 86_400_000
    const t0 = Date.UTC(2026, 0, 5, 0, 0)
    const daily: Bar[] = [0, 1, 2].map((d) => ({ time: t0 + d * day, open: 10 + d, high: 20 + d, low: 5, close: 100 + d, volume: 1 }))
    const hourly: Bar[] = Array.from({ length: 72 }, (_, h) => ({ time: t0 + h * 3_600_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }))
    const o = run(compile('plt(requestbar("1D", close))'), hourly, { host: { requestBars: () => daily } })
    const v = Array.from(o.plots[0].values)
    expect(v[0]).toBeNaN() // day 0 not complete
    expect(v[23]).toBeNaN()
    expect(v[24]).toBe(100) // first bar of day 1 sees day 0's close
    expect(v[47]).toBe(100)
    expect(v[48]).toBe(101)
  })
  it('without a host it is a clear error', () => {
    expect(() => run(compile('plt(requestbar("1D", close))'), walk(3))).toThrowError(/requestbar/)
  })
})
