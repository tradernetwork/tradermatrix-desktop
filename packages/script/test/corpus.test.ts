import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile, run, type ScriptOutput } from '../src/index'
import { LEGACY, RIBBON, SUBCHART } from './fixtures/scripts'
import { walk } from './fixtures/walk'

const BUILTIN = new URL('../../../apps/desktop/src/chart/scripts/tm_ema_ribbon.webull', import.meta.url)
const bars = walk(600)
const runSrc = (src: string): ScriptOutput => run(compile(src), bars)
const noInf = (o: ScriptOutput) => {
  for (const p of o.plots) for (const x of p.values) expect(x === Infinity || x === -Infinity, p.name).toBe(false)
}
const firstFinite = (v: Float64Array) => v.findIndex((x) => Number.isFinite(x))

describe('built-in script and inline corpus fixtures', () => {
  it('tm_ema_ribbon (built-in): 5 plots, 2 fills, sparse crossover circles, slow EMA warms up at bar 49', () => {
    const o = runSrc(readFileSync(BUILTIN, 'utf8'))
    expect(o.plots).toHaveLength(5)
    expect(o.fills).toHaveLength(2)
    expect(o.inputs.map((i) => i.key)).toEqual(['fast_len', 'mid_len', 'slow_len'])
    const circles = o.plots.filter((p) => p.type === 'circles')
    expect(circles).toHaveLength(2)
    for (const e of circles) {
      const hits = e.values.filter((x) => Number.isFinite(x)).length
      expect(hits).toBeGreaterThan(0)
      expect(hits).toBeLessThan(150)
    }
    expect(firstFinite(o.plots[2].values)).toBe(49)
    expect(o.fills[0].color[100]).toMatch(/^#/) // iff() colour resolved per bar
    noInf(o)
  })
  it('ribbon fixture: 5 plots, 2 fills, same shape as the built-in', () => {
    const o = runSrc(RIBBON)
    expect(o.plots).toHaveLength(5)
    expect(o.fills).toHaveLength(2)
    expect(o.inputs.map((i) => i.key)).toEqual(['fast_len', 'mid_len', 'slow_len'])
    expect(firstFinite(o.plots[2].values)).toBe(49)
    noInf(o)
  })
  it('sub-chart fixture: stochastic stays within 0..100, 3 plots, 4 hlines, 1 fill', () => {
    const o = runSrc(SUBCHART)
    expect(o.plots).toHaveLength(3)
    expect(o.hlines).toHaveLength(4)
    expect(o.fills).toHaveLength(1)
    for (const x of o.plots[0].values) if (Number.isFinite(x)) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(100) }
    noInf(o)
  })
  it('legacy Pine-style names: 3 hidden plots, 2 fills, 3 inputs', () => {
    const o = runSrc(LEGACY)
    expect(o.plots).toHaveLength(3)
    expect(o.plots.every((p) => p.display === 'none')).toBe(true)
    expect(o.fills).toHaveLength(2)
    expect(o.inputs.map((i) => i.default)).toEqual([8, 21, 34])
    noInf(o)
  })
})
