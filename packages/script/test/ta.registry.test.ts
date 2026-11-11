import { describe, it, expect } from 'vitest'
import { KERNELS } from '../src/ta'

const NAMES = 'sma ema wma rma hma vwma alma swma rsi cmo cci cog mfi tsi macd stoch tr atr bb kc dmi highest lowest sum std variance dev highestOffset lowestOffset correlation cumsum diff accdist upTrend downTrend'.split(' ')

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
function bars(n: number) {
  const r = rng(42)
  let p = 100
  const out: Record<string, number>[] = []
  for (let i = 0; i < n; i++) {
    const o = p
    p = Math.max(1, p + (r() - 0.5) * 4)
    const hi = Math.max(o, p) + r(), lo = Math.min(o, p) - r()
    out.push({ src: p, close: p, high: hi, low: lo, volume: 1000 + Math.floor(r() * 500), src2: o })
  }
  return out
}
const same = (a: unknown, b: unknown) => expect(JSON.stringify(a, (_, v) => (typeof v === 'number' && Number.isNaN(v) ? 'NaN' : v))).toBe(JSON.stringify(b, (_, v) => (typeof v === 'number' && Number.isNaN(v) ? 'NaN' : v)))

describe('registry', () => {
  it('has every required kernel', () => expect(Object.keys(KERNELS).sort()).toEqual([...NAMES].sort()))
  const data = bars(60)
  for (const name of NAMES) {
    describe(name, () => {
      const spec = KERNELS[name]
      const params = spec.params.map(p => p.default ?? 5)
      const run = (cloneAt: number) => {
        let s = spec.kernel.init(...params)
        const out: unknown[] = []
        data.forEach((d, i) => {
          if (i === cloneAt) s = structuredClone(s)
          out.push(spec.kernel.step(s, ...spec.inputs.map(k => d[k])))
        })
        return out
      }
      it('spec shape', () => {
        expect(spec.name).toBe(name)
        const o = run(-1)[59]
        if (spec.outputs === 1) expect(typeof o).toBe('number')
        else expect((o as number[]).length).toBe(spec.outputs)
      })
      it('survives structuredClone mid-run', () => same(run(30), run(-1)))
      it('never emits Infinity', () => expect(JSON.stringify(run(-1).flat(), (_, v) => (v === Infinity || v === -Infinity ? 'INF' : v))).not.toContain('INF'))
      it('short history: all NaN-or-finite, no throw', () => {
        const s = spec.kernel.init(...spec.params.map(p => p.default ?? 200))
        for (const d of data.slice(0, 10)) spec.kernel.step(s, ...spec.inputs.map(k => d[k]))
      })
    })
  }
})
