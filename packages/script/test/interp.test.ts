import { describe, expect, it } from 'vitest'
import { compile, run } from '../src/index'
import { KERNELS, batch } from '../src/ta/index'
import { ScriptError } from '../src/types'
import { SUBCHART } from './fixtures/scripts'
import { fromCloses, walk } from './fixtures/walk'

const go = (src: string, bars = walk(40)) => run(compile(src), bars)
const vals = (src: string, bars = walk(40)) => Array.from(go(src, bars).plots[0].values)

describe('history and state', () => {
  it('x[n] reads n bars back, NaN before the start', () => {
    const bars = walk(10)
    const v = vals('a = close\nb = a[1]\nplt(b)', bars)
    expect(v[0]).toBeNaN()
    expect(v[1]).toBe(bars[0].close)
    expect(v[5]).toBe(bars[4].close)
  })
  it('close[2] reads bar fields', () => {
    const bars = walk(10)
    expect(vals('plt(close[2])', bars)[4]).toBe(bars[2].close)
  })
  it('var initialises once and := mutates', () => {
    expect(vals('var n = 0\nn := n + 1\nplt(n)', walk(5))).toEqual([1, 2, 3, 4, 5])
  })
  it('if/else picks a branch per bar', () => {
    const bars = fromCloses([10, 11, 9, 12])
    expect(vals('x = 0\nif close > open\n  x = 1\nelse\n  x = 2\nplt(x)', bars)).toEqual([2, 1, 2, 1])
  })
  it('for loop with break and continue', () => {
    expect(vals('s = 0\nfor i = 1 to 3\n  s := s + i\nplt(s)', walk(3))).toEqual([6, 6, 6])
    expect(vals('s = 0\nfor i = 1 to 10\n  if i == 4\n    break\n  s := s + i\nplt(s)', walk(2))).toEqual([6, 6])
    expect(vals('s = 0\nfor i = 1 to 3\n  if i == 2\n    continue\n  s := s + i\nplt(s)', walk(2))).toEqual([4, 4])
  })
  it('two call sites of the same indicator keep independent state', () => {
    const bars = walk(40)
    const o = go('a = ind.ema(close, 3)\nb = ind.ema(open, 3)\nplt(a)\nplt(b)', bars)
    const ema = (xs: number[]) => batch(KERNELS.ema.kernel, [3], xs.map((x) => [x]))
    expect(Array.from(o.plots[0].values)).toEqual(ema(bars.map((b) => b.close)))
    expect(Array.from(o.plots[1].values)).toEqual(ema(bars.map((b) => b.open)))
  })
  it('tuple assignment from ind.bb', () => {
    const bars = walk(30)
    const o = go('[m, u, l] = ind.bb(close, 5, 2)\nplt(u)\nplt(l)', bars)
    expect(o.plots[0].values[10]).toBeGreaterThan(o.plots[1].values[10])
  })
})

describe('errors', () => {
  it('unknown function is a compile error with line and col', () => {
    try {
      compile('x = 1\ny = ind.emaa(close, 3)')
      throw new Error('no throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptError)
      expect((e as ScriptError).line).toBe(2)
      expect((e as ScriptError).col).toBe(5)
    }
  })
  it('undefined identifier is a compile error', () => {
    expect(() => compile('x = foo + 1')).toThrowError(/foo/)
  })
  it('runaway while loop stops with the loop line and bar', () => {
    try {
      run(compile('x = 1\nwhile true\n  x = x + 1'), walk(3))
      throw new Error('no throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptError)
      expect((e as ScriptError).message).toMatch(/loop limit exceeded/)
      expect((e as ScriptError).line).toBe(2)
      expect((e as ScriptError).bar).toBe(0)
    }
  })
})

describe('outputs', () => {
  it('sub-chart fixture: 3 plots (one display none), 4 hlines, 1 fill, per-bar color by threshold', () => {
    const o = go(SUBCHART, walk(100))
    expect(o.plots).toHaveLength(3)
    expect(o.plots.filter((p) => p.display === 'none')).toHaveLength(1)
    expect(o.hlines).toHaveLength(4)
    expect(o.fills).toHaveLength(1)
    const k = o.plots.find((p) => p.name === 'Slow Stoch %K')!
    for (let i = 20; i < 100; i++) {
      const v = k.values[i]
      const want = v >= 60 ? 'green' : v <= 40 ? 'yellow' : 'gray'
      expect(k.color[i], `bar ${i} v=${v}`).toBe({ green: '#008000', yellow: '#FFFF00', gray: '#808080' }[want])
    }
  })
  it('define registers an input and clamps overrides to min', () => {
    const p = compile('fast = define(8, name="Fast EMA", min=1)\nplt(fast)')
    const o = run(p, walk(3), { inputs: { fast: 0 } })
    expect(o.inputs).toEqual([{ key: 'fast', name: 'Fast EMA', type: 'integer', default: 8, min: 1 }])
    expect(Array.from(o.plots[0].values)).toEqual([1, 1, 1])
    expect(Array.from(run(p, walk(3)).plots[0].values)).toEqual([8, 8, 8])
  })
  it('iff with none gives NaN where the condition is false (circles)', () => {
    const bars = fromCloses([10, 11, 9, 12])
    const o = go('plt(iff(close > open, low, none), type=plt.type_circles, color=color.lime)', bars)
    expect(o.plots[0].type).toBe('circles')
    expect(Array.from(o.plots[0].values).map((x) => (Number.isNaN(x) ? null : x))).toEqual([null, 10, null, 9])
  })
  it('flat bars never produce Infinity (division by zero is none)', () => {
    const flat = Array.from({ length: 5 }, (_, i) => ({ time: i * 1000, open: 5, high: 5, low: 5, close: 5, volume: 1 }))
    const o = run(compile('plt((close - low) / (high - low))\nplt(math.log(0))\nplt(1 % 0)'), flat)
    for (const p of o.plots) for (const x of p.values) expect(x === Infinity || x === -Infinity).toBe(false)
  })
  it('hline returns a ref usable in fill_between', () => {
    const o = go('a = hline(10)\nb = hline(20)\nplt.fill_between(a, b, color=color.gray, opacity=10, name="f")')
    expect(o.hlines.map((h) => h.value)).toEqual([10, 20])
    expect(o.fills[0]).toMatchObject({ name: 'f', opacity: 10 })
    expect(o.fills[0].a).toMatchObject({ kind: 'hline' })
  })
})
