import type { Chart, KLineData } from 'klinecharts'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake } from '../src/lib/api'
import { parseStoredIndicators, SETTING_KEY, useIndicatorStore } from '../src/chart/indicatorStore'
import {
  attachScript,
  clearScriptRegistry,
  registerScriptIndicator,
  scriptStatus,
  scriptToBars,
  updateScript,
  type ActiveIndicator,
} from '../src/chart/scriptIndicator'
import { walk } from './fixtures/walk'

type Tpl = {
  name: string
  calc: (d: KLineData[], i: Record<string, unknown>) => Record<string, number>[]
  draw: (p: Record<string, unknown>) => boolean
  figures: { key: string }[]
}

/** Minimal stand-in for the klinecharts v10 surface we touch, behaving like the real one (calc on create and on calcParams/figures change). */
function fakeChart(data: KLineData[]) {
  const templates = new Map<string, Tpl>()
  const klc = { registerIndicator: (t: Tpl) => void templates.set(t.name, t) } as unknown as typeof import('klinecharts')
  const indicators = new Map<string, Record<string, unknown> & { id: string; result: Record<string, number>[]; figures: { key: string }[] }>()
  const created: Array<{ create: Record<string, unknown>; isStack: boolean }> = []
  const recalc = (ind: { name?: unknown; result: unknown }) => {
    const t = templates.get(ind.name as string)!
    ind.result = t.calc(data, ind as never)
  }
  const chart = {
    getDataList: () => data,
    createIndicator(create: Record<string, unknown>, isStack: boolean) {
      created.push({ create, isStack })
      const t = templates.get(create.name as string)
      if (!t) return null
      const ind = { figures: t.figures, ...create, result: [] } as never as ReturnType<typeof indicators.get> & object
      indicators.set(create.id as string, ind)
      recalc(ind)
      return create.id as string
    },
    overrideIndicator(o: Record<string, unknown>) {
      const ind = indicators.get(o.id as string)
      if (!ind) return false
      Object.assign(ind, o)
      recalc(ind)
      return true
    },
    removeIndicator(f: { id: string }) {
      return indicators.delete(f.id)
    },
    getIndicators: () => [...indicators.values()],
    getVisibleRange: () => ({ from: 0, to: data.length, realFrom: 0, realTo: data.length }),
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 6, halfGapBar: 3 }),
  } as unknown as Chart
  return { chart, klc, templates, indicators, created }
}

const kdata = (n = 120): KLineData[] =>
  walk(n).map((b) => ({ timestamp: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))

const EMA = 'n = define(3, name="Len", min=1)\nplt(ind.ema(close, n), name="ema", color=color.blue)\n'
const active = (id: string, source = EMA, inputs: ActiveIndicator['inputs'] = {}): ActiveIndicator => ({ id, scriptId: 'ema', label: 'EMA', source, inputs })

beforeEach(() => {
  clearScriptRegistry()
  fake.reset()
  useIndicatorStore.setState({ active: [], loaded: false })
})

describe('scriptToBars', () => {
  it('maps KLineData to Bar and defaults a missing volume to 0', () => {
    expect(scriptToBars([{ timestamp: 5, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 }, { timestamp: 6, open: 1, high: 1, low: 1, close: 1 }])).toEqual([
      { time: 5, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 },
      { time: 6, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    ])
  })
})

describe('registerScriptIndicator and attachScript', () => {
  it('registers one template named rebull-script, once per module', () => {
    const f = fakeChart(kdata())
    registerScriptIndicator(f.klc)
    registerScriptIndicator(f.klc)
    expect([...f.templates.keys()]).toEqual(['rebull-script'])
  })
  it('a valid overlay script attaches to the candle pane with figures for its plots', () => {
    const f = fakeChart(kdata())
    registerScriptIndicator(f.klc)
    const r = attachScript(f.chart, active('ema-1', EMA, { n: 5 }))
    expect(r.error).toBeNull()
    expect(r.indicatorId).toBe('ema-1')
    expect(f.created[0]!.create).toMatchObject({ name: 'rebull-script', id: 'ema-1', paneId: 'candle_pane' })
    expect(f.created[0]!.isStack).toBe(true)
    const k = `p${r.output!.plots[0]!.id}`
    expect((f.created[0]!.create.figures as { key: string }[]).map((x) => x.key)).toEqual([k])
    const ind = f.indicators.get('ema-1')!
    expect(Number.isFinite(ind.result[100]![k])).toBe(true)
    expect(ind.result[0]![k]).toBeUndefined() // warmup is none, omitted
  })
  it('a script far from price (rsi) gets its own sub-pane and hlines become range figures', () => {
    const f = fakeChart(kdata())
    registerScriptIndicator(f.klc)
    const src = 'plt(ind.rsi(close, 14), name="rsi")\nhline(30)\nhline(70)\n'
    const r = attachScript(f.chart, active('rsi-1', src))
    expect(r.error).toBeNull()
    expect(f.created[0]!.create.paneId).toBeUndefined()
    expect(f.created[0]!.isStack).toBe(false)
    const o = r.output!
    const keys = [`p${o.plots[0]!.id}`, `h${o.hlines[0]!.id}`, `h${o.hlines[1]!.id}`]
    expect((f.created[0]!.create.figures as { key: string }[]).map((x) => x.key)).toEqual(keys)
    expect(f.indicators.get('rsi-1')!.result[50]![keys[2]!]).toBe(70)
  })
  it('a broken script yields an error with a line, creates nothing and does not throw', () => {
    const f = fakeChart(kdata())
    registerScriptIndicator(f.klc)
    for (const src of ['plt(', 'plt(nosuchname)\n', 'x = foo(1)\n']) {
      const r = attachScript(f.chart, active('bad', src))
      expect(r.output).toBeNull()
      expect(r.error).toMatch(/^script error: /)
    }
    expect(attachScript(f.chart, active('bad', 'plt(nosuchname)\n')).error).toMatch(/line \d+/)
    expect(f.created).toHaveLength(0)
    expect(scriptStatus('bad').error).toMatch(/script error/)
  })
  it('empty and tiny data do not throw', () => {
    for (const n of [0, 1, 2]) {
      clearScriptRegistry()
      const f = fakeChart(kdata(n))
      registerScriptIndicator(f.klc)
      expect(() => attachScript(f.chart, active(`e${n}`))).not.toThrow()
    }
  })
  it('a draw call with an error entry paints nothing and returns true', () => {
    const f = fakeChart(kdata())
    registerScriptIndicator(f.klc)
    attachScript(f.chart, active('bad', 'plt('))
    const t = f.templates.get('rebull-script')!
    const calls: string[] = []
    const ctx = new Proxy({}, { get: (_t, k) => () => calls.push(String(k)), set: () => true })
    expect(t.draw({ ctx, chart: f.chart, indicator: { id: 'bad' }, bounding: { width: 100, height: 100 }, xAxis: {}, yAxis: {} })).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('inputs and instance isolation', () => {
  it('setInput then updateScript re-runs with the override (ema length changes the output)', () => {
    const f = fakeChart(kdata())
    registerScriptIndicator(f.klc)
    const id = useIndicatorStore.getState().add('ema', EMA)
    attachScript(f.chart, useIndicatorStore.getState().active[0]!)
    const k = `p${scriptStatus(id).output!.plots[0]!.id}`
    const before = f.indicators.get(id)!.result[100]![k]
    useIndicatorStore.getState().setInput(id, 'n', 40)
    const r = updateScript(f.chart, useIndicatorStore.getState().active[0]!)
    expect(r.error).toBeNull()
    const after = f.indicators.get(id)!.result[100]![k]
    expect(Number.isFinite(after)).toBe(true)
    expect(after).not.toBe(before)
    expect(f.indicators.get(id)!.result[20]![k]).toBeUndefined() // length 40 warmup now longer
  })
  it('two instances of the same script keep separate inputs', () => {
    const f = fakeChart(kdata())
    registerScriptIndicator(f.klc)
    const ra = attachScript(f.chart, active('a', EMA, { n: 3 }))
    attachScript(f.chart, active('b', EMA, { n: 30 }))
    const k = `p${ra.output!.plots[0]!.id}`
    const a = f.indicators.get('a')!.result.map((x) => ({ ...x }))
    const b = f.indicators.get('b')!.result.map((x) => ({ ...x }))
    expect(a[10]![k]).toBeDefined()
    expect(b[10]![k]).toBeUndefined()
    updateScript(f.chart, active('a', EMA, { n: 50 }))
    expect(f.indicators.get('b')!.result[60]![k]).toBe(b[60]![k])
    expect(f.indicators.get('a')!.result[60]![k]).not.toBe(a[60]![k])
  })
  it('an unattached id calcs to empty objects instead of throwing', () => {
    const f = fakeChart(kdata(5))
    registerScriptIndicator(f.klc)
    const t = f.templates.get('rebull-script')!
    expect(t.calc(kdata(5), { id: 'nope', figures: [] })).toEqual([{}, {}, {}, {}, {}])
  })
})

describe('indicator store persistence', () => {
  it('persists to chart.indicators and round-trips through load', async () => {
    const s = useIndicatorStore.getState()
    const id = s.add('ema', EMA, 'EMA test')
    s.setInput(id, 'n', 7)
    await new Promise((r) => setTimeout(r, 0))
    const raw = fake.settingGet(SETTING_KEY)!
    expect(JSON.parse(raw)[0]).toMatchObject({ id, scriptId: 'ema', label: 'EMA test', inputs: { n: 7 } })
    useIndicatorStore.setState({ active: [], loaded: false })
    await useIndicatorStore.getState().load()
    expect(useIndicatorStore.getState().active).toEqual([{ id, scriptId: 'ema', label: 'EMA test', source: EMA, inputs: { n: 7 } }])
    useIndicatorStore.getState().remove(id)
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(fake.settingGet(SETTING_KEY)!)).toEqual([])
  })
  it('add hands out unique ids per script', () => {
    const s = useIndicatorStore.getState()
    const a = s.add('ema', EMA)
    const b = s.add('ema', EMA)
    expect(a).not.toBe(b)
    s.remove(a)
    expect(s.add('ema', EMA)).not.toBe(b)
  })
  it('garbage or malformed stored JSON gives an empty list; bad entries are dropped individually', async () => {
    for (const bad of [null, '', 'not json', '{}', '"x"', '123', '[1,2]', '[{"id":1}]']) expect(parseStoredIndicators(bad)).toEqual([])
    const good = { id: 'a-1', scriptId: 'a', label: 'A', source: 'plt(close)', inputs: { n: 1, f: true, s: 'x' } }
    expect(parseStoredIndicators(JSON.stringify([good, { ...good, id: 'a-2', inputs: { n: null } }, { ...good, id: 'a-1' }, 7]))).toEqual([good])
    await api.settingSet(SETTING_KEY, 'garbage{')
    await useIndicatorStore.getState().load()
    expect(useIndicatorStore.getState().active).toEqual([])
    expect(useIndicatorStore.getState().loaded).toBe(true)
  })
})
