/**
 * KLineChart indicator that runs an @rebull/script program. ONE template named 'rebull-script' is
 * registered; per-instance state (source, inputs, cached output, error) lives in a module-level
 * registry keyed by the chart's indicator id, so two instances of the same script stay independent.
 * `calc` runs the script; `draw` paints everything itself and returns true, which suppresses the
 * default figures. `figures` exist only so the y-axis range includes the plot values.
 */
import { compile, run, ScriptError, type Bar, type Host, type Program, type ScriptOutput } from '@rebull/script'
import type { Chart, Indicator, IndicatorFigure, KLineData } from 'klinecharts'
import { planDraw } from './drawPlan'
import { paintOps } from './paint'

export interface ActiveIndicator {
  id: string
  scriptId: string
  label: string
  source: string
  inputs: Record<string, number | boolean | string>
}

export const SCRIPT_INDICATOR_NAME = 'rebull-script'
export const CANDLE_PANE_ID = 'candle_pane'

export function scriptToBars(data: KLineData[]): Bar[] {
  return data.map((d) => ({ time: d.timestamp, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume ?? 0 }))
}

interface Entry {
  a: ActiveIndicator
  host?: Host
  chart?: Chart
  program?: Program
  programSource?: string
  output: ScriptOutput | null
  error: string | null
  key: string
}

const registry = new Map<string, Entry>()
const listeners = new Set<(id: string) => void>()

/** Notified (indicator id) whenever a calc finishes, so the pane can show error text. */
export function onScriptResult(cb: (id: string) => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export function scriptStatus(id: string): { output: ScriptOutput | null; error: string | null } {
  const e = registry.get(id)
  return { output: e?.output ?? null, error: e?.error ?? null }
}

export function formatScriptError(e: unknown): string {
  if (e instanceof ScriptError) return `script error: ${e.message}`
  return `script error: ${e instanceof Error ? e.message : String(e)}`
}

function dataKey(e: Entry, data: KLineData[]): string {
  const last = data[data.length - 1]
  const first = data[0]
  return [
    e.a.source,
    JSON.stringify(e.a.inputs),
    data.length,
    first?.timestamp,
    last?.timestamp,
    last?.open,
    last?.high,
    last?.low,
    last?.close,
    last?.volume,
  ].join('|')
}

/** Compile once per source, run per (inputs, data). Never throws. */
function runEntry(e: Entry, data: KLineData[]): void {
  const key = dataKey(e, data)
  if (key === e.key && (e.output !== null || e.error !== null)) return
  e.key = key
  try {
    if (!e.program || e.programSource !== e.a.source) {
      e.program = undefined
      e.program = compile(e.a.source)
      e.programSource = e.a.source
    }
    e.output = run(e.program, scriptToBars(data), { inputs: e.a.inputs, host: e.host })
    e.error = null
  } catch (err) {
    e.output = null
    e.error = formatScriptError(err)
  }
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Plots that need an axis range: visible ones plus any that a fill uses as an edge. */
function rangePlotIds(out: ScriptOutput): number[] {
  const ref = new Set<number>()
  for (const f of out.fills) {
    if (f.a.kind === 'plot') ref.add(f.a.id)
    if (f.b.kind === 'plot') ref.add(f.b.id)
  }
  return out.plots.filter((p) => p.display !== 'none' || ref.has(p.id)).map((p) => p.id)
}

/** Overlay hint: every visible plot and every hline sits within 50% of the median close. No plotted values means sub-pane. */
export function isOverlayOutput(out: ScriptOutput, bars: Bar[]): boolean {
  const mc = median(bars.map((b) => b.close).filter(Number.isFinite))
  if (!Number.isFinite(mc) || mc === 0) return false
  let any = false
  for (const p of out.plots) {
    if (p.display === 'none') continue
    const vals: number[] = []
    for (const v of p.values) if (Number.isFinite(v)) vals.push(v)
    if (vals.length === 0) continue
    any = true
    if (Math.abs(median(vals) - mc) / Math.abs(mc) >= 0.5) return false
  }
  // oscillator levels (hline 30/70 and the like) mean a sub-pane even when a value happens to sit near price
  for (const h of out.hlines) if (Number.isFinite(h.value) && Math.abs(h.value - mc) / Math.abs(mc) >= 0.5) return false
  return any
}

export function figuresFor(out: ScriptOutput | null): IndicatorFigure[] {
  if (!out) return []
  const ids = new Set(rangePlotIds(out))
  const figs: IndicatorFigure[] = out.plots.filter((p) => ids.has(p.id)).map((p) => ({ key: `p${p.id}`, title: `${p.name}: `, type: 'line' }))
  for (const h of out.hlines) figs.push({ key: `h${h.id}`, title: '', type: 'line' })
  return figs
}

const figSig = (fs: IndicatorFigure[]) => fs.map((f) => f.key).join(',')

function buildResult(out: ScriptOutput | null, n: number): Record<string, number>[] {
  const res: Record<string, number>[] = Array.from({ length: n }, () => ({}))
  if (!out) return res
  const ids = new Set(rangePlotIds(out))
  for (const p of out.plots) {
    if (!ids.has(p.id)) continue
    for (let i = 0; i < n; i++) {
      const v = p.values[i]
      if (v !== undefined && Number.isFinite(v)) res[i]![`p${p.id}`] = v
    }
  }
  for (const h of out.hlines) if (Number.isFinite(h.value)) for (let i = 0; i < n; i++) res[i]![`h${h.id}`] = h.value
  return res
}

const registered = new WeakSet<object>()

export function registerScriptIndicator(klinecharts: typeof import('klinecharts')): void {
  if (registered.has(klinecharts)) return
  registered.add(klinecharts)
  klinecharts.registerIndicator<Record<string, number>, string, string>({
    name: SCRIPT_INDICATOR_NAME,
    shortName: 'Script',
    series: 'normal',
    precision: 2,
    figures: [],
    calcParams: [],
    calc: (dataList: KLineData[], indicator: Indicator<Record<string, number>, string, string>) => {
      const e = registry.get(indicator.id)
      if (!e) return dataList.map(() => ({}))
      runEntry(e, dataList)
      const figs = figuresFor(e.output)
      // the plot set is only known after the first run; push it to the chart once, off the calc stack
      if (e.chart && e.output && figSig(figs) !== figSig(indicator.figures as IndicatorFigure[])) {
        const chart = e.chart
        setTimeout(() => {
          if (registry.get(indicator.id) === e) chart.overrideIndicator({ name: SCRIPT_INDICATOR_NAME, id: indicator.id, figures: figs })
        }, 0)
      }
      for (const cb of listeners) cb(indicator.id)
      return buildResult(e.output, dataList.length)
    },
    draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
      const e = registry.get(indicator.id)
      if (!e || !e.output || e.error) return true
      try {
        const n = chart.getDataList().length
        if (n === 0) return true
        const r = chart.getVisibleRange()
        const from = Math.max(0, r.from)
        const to = Math.min(n - 1, r.to)
        const yBase = Math.min(bounding.height, Math.max(0, yAxis.convertToPixel(0)))
        const ops = planDraw(
          e.output,
          {
            x: (i) => xAxis.convertToPixel(i),
            y: (v) => yAxis.convertToPixel(v),
            yBase: Number.isFinite(yBase) ? yBase : bounding.height,
            from,
            to,
            left: 0,
            right: bounding.width,
          },
          Math.max(1, chart.getBarSpace().gapBar),
        )
        paintOps(ctx, ops)
      } catch (err) {
        e.error = formatScriptError(err)
      }
      return true
    },
  })
}

export interface AttachResult {
  indicatorId: string
  output: ScriptOutput | null
  error: string | null
}

/**
 * Runs the script on the chart's current data and, if it is sound, creates the chart indicator
 * (candle pane for overlay scripts, own sub-pane otherwise). A script that fails to compile or run
 * yields `error` and creates nothing. Attach after the chart holds data, so the overlay hint can see prices.
 */
export function attachScript(chart: Chart, a: ActiveIndicator, host?: Host): AttachResult {
  const e: Entry = { a: { ...a, inputs: { ...a.inputs } }, host, chart, output: null, error: null, key: '' }
  registry.set(a.id, e)
  const data = chart.getDataList()
  runEntry(e, data)
  if (e.error || !e.output) return { indicatorId: '', output: null, error: e.error ?? 'script error: no output' }
  const overlay = isOverlayOutput(e.output, scriptToBars(data))
  const create = {
    name: SCRIPT_INDICATOR_NAME,
    id: a.id,
    shortName: a.label,
    calcParams: [JSON.stringify(a.inputs)],
    figures: figuresFor(e.output),
    ...(overlay ? { paneId: CANDLE_PANE_ID } : {}),
  }
  const id = chart.createIndicator(create, overlay)
  if (!id) {
    registry.delete(a.id)
    return { indicatorId: '', output: e.output, error: 'could not create the indicator' }
  }
  return { indicatorId: id, output: e.output, error: null }
}

/** Apply new inputs (or source) to an attached instance and recalc. */
export function updateScript(chart: Chart, a: ActiveIndicator): AttachResult {
  const e = registry.get(a.id)
  if (!e) return { indicatorId: '', output: null, error: 'script error: not attached' }
  e.a = { ...a, inputs: { ...a.inputs } }
  e.chart = chart
  runEntry(e, chart.getDataList())
  if (e.output) {
    chart.overrideIndicator({ name: SCRIPT_INDICATOR_NAME, id: a.id, calcParams: [JSON.stringify(a.inputs)], figures: figuresFor(e.output) })
  }
  return { indicatorId: a.id, output: e.output, error: e.error }
}

export function detachScript(chart: Chart | null, id: string): void {
  registry.delete(id)
  chart?.removeIndicator({ id })
}

/** Test and teardown helper. */
export function clearScriptRegistry(): void {
  registry.clear()
  listeners.clear()
}
