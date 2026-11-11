import { KERNELS, type KernelSpec } from './ta/index'
import { ScriptError, type Bar, type PlotRef, type PlotType, type Value } from './types'

/** What a builtin can see and do while evaluating one call. Implemented by the interpreter. */
export interface CallCtx {
  node: { id: number; line: number; col: number }
  bar: number
  bars: Bar[]
  isLast: boolean
  isUpdate: boolean
  timezone: string
  assignName?: string
  /** Per-call-site state, created on first use, snapshotted/restored by sessions. */
  state<T>(init: () => T): T
  err(msg: string): never
  defineInput(def: { name: string; type: string; default: number | boolean | string; min?: number; max?: number }): number | boolean | string
  plot(spec: { name: string; value: number; color: string | null; lineWidth: number; type: PlotType; opacity: number; display: 'all' | 'none' }): PlotRef
  hline(spec: { value: number; color: string; style: 'solid' | 'dashed' | 'dotted'; lineWidth: number }): PlotRef
  fill(spec: { a: PlotRef; b: PlotRef; color: string | null; opacity: number; name: string }): void
  requestBars(interval: string): Bar[]
}

export type Builtin =
  | { kind: 'const'; value: Value }
  | { kind: 'fn'; call(ctx: CallCtx, args: Value[], kw: Record<string, Value>): Value }

export const NONE = NaN
export const num = (v: Value | undefined): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN)
export const truthy = (v: Value | undefined): boolean => (typeof v === 'number' ? !Number.isNaN(v) && v !== 0 : typeof v === 'boolean' ? v : v != null && v !== '')
const fin = (x: number) => (Number.isFinite(x) ? x : NaN)

export const BUILTINS: Record<string, Builtin> = {}
const c = (name: string, value: Value) => (BUILTINS[name] = { kind: 'const', value })
const f = (name: string, call: (ctx: CallCtx, args: Value[], kw: Record<string, Value>) => Value) => (BUILTINS[name] = { kind: 'fn', call })

// ---- constants ----
c('none', NONE)
c('fill_none', null)
const COLORS: Record<string, string> = {
  aqua: '#00FFFF', black: '#000000', blue: '#0000FF', fuchsia: '#FF00FF', gray: '#808080', green: '#008000', lime: '#00FF00',
  maroon: '#800000', navy: '#000080', olive: '#808000', orange: '#FFA500', purple: '#800080', red: '#FF0000', silver: '#C0C0C0',
  teal: '#008080', white: '#FFFFFF', yellow: '#FFFF00', sys_up: '#10b981', sys_down: '#ef4444',
}
for (const [k, v] of Object.entries(COLORS)) c(`color.${k}`, v)
for (const k of ['bool', 'float', 'integer', 'source', 'string']) c(`define.${k}`, k)
c('display.all', 'all')
c('display.none', 'none')
for (const k of ['solid', 'dashed', 'dotted']) c(`hline.type_${k}`, k)
for (const k of ['line', 'linebr', 'stepline', 'area', 'circles', 'columns', 'cross', 'histogram']) c(`plt.type_${k}`, k)
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] // our guess: ISO numbering Mon=1..Sun=7
DAYS.forEach((d, i) => c(`time.${d}`, i + 1))
c('time.utc', 'UTC')

// ---- bar_check ----
f('bar_check.is_first', (x) => x.bar === 0)
f('bar_check.is_last', (x) => x.isLast)
f('bar_check.is_historical', (x) => !x.isLast)
f('bar_check.is_real_time', (x) => x.isLast)
f('bar_check.is_new', (x) => !x.isUpdate)
f('bar_check.is_last_update', (x) => x.isLast && x.isUpdate)
// those are variables in Webull; the interpreter treats a bare Member read of a zero-arg fn as a value (see interp.ts VALUE_FNS)
export const VALUE_FNS = new Set(['bar_check.is_first', 'bar_check.is_last', 'bar_check.is_historical', 'bar_check.is_real_time', 'bar_check.is_new', 'bar_check.is_last_update', 'time.current', 'time.current_bar'])

// ---- time ----
function parts(ms: number, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
  const o: Record<string, string> = {}
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value
  return o
}
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const tArg = (x: CallCtx, a: Value[]) => (typeof a[0] === 'number' && !Number.isNaN(a[0]) ? a[0] : x.bars[x.bar].time)
f('time.current', () => Date.now())
f('time.current_bar', (x) => x.bars[x.bar].time)
f('time.get_year', (x, a) => Number(parts(tArg(x, a), x.timezone).year))
f('time.get_month', (x, a) => Number(parts(tArg(x, a), x.timezone).month))
f('time.get_day', (x, a) => Number(parts(tArg(x, a), x.timezone).day))
f('time.get_hour', (x, a) => Number(parts(tArg(x, a), x.timezone).hour))
f('time.get_minute', (x, a) => Number(parts(tArg(x, a), x.timezone).minute))
f('time.get_weekday', (x, a) => WD.indexOf(parts(tArg(x, a), x.timezone).weekday) + 1)
f('time.get_week', (x, a) => {
  const t = tArg(x, a)
  const p = parts(t, x.timezone)
  const start = Date.UTC(Number(p.year), 0, 1)
  const day = Math.floor((Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) - start) / 86_400_000)
  return Math.floor(day / 7) + 1
})

// ---- math ----
const m1 = (name: string, fn: (x: number) => number) => f(`math.${name}`, (_x, a) => fin(fn(num(a[0]))))
m1('abs', Math.abs); m1('acos', Math.acos); m1('asin', Math.asin); m1('atan', Math.atan); m1('ceil', Math.ceil); m1('cos', Math.cos)
m1('exp', Math.exp); m1('floor', Math.floor); m1('log', Math.log); m1('log10', Math.log10); m1('round', Math.round)
m1('sign', Math.sign); m1('sin', Math.sin); m1('sqrt', Math.sqrt); m1('tan', Math.tan)
f('math.max', (_x, a) => (a.some((v) => Number.isNaN(num(v))) ? NaN : Math.max(...a.map(num))))
f('math.min', (_x, a) => (a.some((v) => Number.isNaN(num(v))) ? NaN : Math.min(...a.map(num))))
f('math.avg', (_x, a) => (a.some((v) => Number.isNaN(num(v))) ? NaN : a.reduce<number>((s, v) => s + num(v), 0) / a.length))
f('math.pow', (_x, a) => fin(Math.pow(num(a[0]), num(a[1]))))

// ---- control and none handling ----
f('iff', (_x, a) => (truthy(a[0]) ? (a[1] ?? NONE) : (a[2] ?? NONE)))
f('na', (_x, a) => (typeof a[0] === 'number' ? Number.isNaN(a[0]) : a[0] == null))
f('nz', (_x, a) => (typeof a[0] === 'number' && Number.isNaN(a[0]) ? (a[1] === undefined ? 0 : a[1]) : (a[0] ?? (a[1] === undefined ? 0 : a[1]))))
f('fixnan', (x, a) => {
  const s = x.state(() => ({ last: NaN }))
  const v = num(a[0])
  if (!Number.isNaN(v)) s.last = v
  return s.last
})
const cross = (name: string, up: boolean) =>
  f(name, (x, a) => {
    const s = x.state(() => ({ pa: NaN, pb: NaN }))
    const av = num(a[0]); const bv = num(a[1])
    const r = up ? av > bv && s.pa <= s.pb : av < bv && s.pa >= s.pb
    s.pa = av; s.pb = bv
    return r
  })
cross('crossover', true)
cross('crossunder', false)
f('study', () => null)
f('alertcondition', () => null)

// ---- outputs ----
const colorArg = (v: Value | undefined, dflt: string | null): string | null => (v === undefined ? dflt : typeof v === 'string' ? v : null)
const pick = (kw: Record<string, Value>, args: Value[], i: number, ...names: string[]): Value | undefined => {
  for (const n of names) if (n in kw) return kw[n]
  return args[i]
}
const plt = (x: CallCtx, a: Value[], kw: Record<string, Value>): Value => {
  const data = pick(kw, a, 0, 'data', 'series')
  const name = pick(kw, a, 1, 'name', 'title')
  return x.plot({
    name: typeof name === 'string' ? name : `plot ${x.node.id}`,
    value: num(data),
    color: colorArg(pick(kw, a, 2, 'color'), '#808080'),
    lineWidth: num(pick(kw, a, 3, 'line_width', 'linewidth')) || 1,
    type: (typeof pick(kw, a, 4, 'type') === 'string' ? pick(kw, a, 4, 'type') : 'line') as PlotType,
    opacity: kw.opacity === undefined ? 100 : num(kw.opacity),
    display: kw.display === 'none' ? 'none' : 'all',
  })
}
f('plt', plt)
f('plot', plt)
f('hline', (x, a, kw) =>
  x.hline({
    value: num(pick(kw, a, 0, 'price', 'value')),
    color: colorArg(pick(kw, a, 1, 'color'), '#808080') ?? '#808080',
    style: (['solid', 'dashed', 'dotted'].includes(String(pick(kw, a, 2, 'type', 'linestyle'))) ? pick(kw, a, 2, 'type', 'linestyle') : 'dashed') as 'dashed',
    lineWidth: num(pick(kw, a, 3, 'line_width', 'linewidth')) || 1,
  }),
)
const fillFn = (x: CallCtx, a: Value[], kw: Record<string, Value>): Value => {
  const ra = a[0]; const rb = a[1]
  const isRef = (v: Value | undefined): v is PlotRef => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isRef(ra) || !isRef(rb)) x.err('plt.fill_between needs two plot or hline references')
  x.fill({ a: ra, b: rb, color: colorArg(kw.color, '#808080'), opacity: kw.opacity === undefined ? 100 : num(kw.opacity), name: typeof kw.name === 'string' ? kw.name : 'fill' })
  return null
}
f('plt.fill_between', fillFn)
f('fill', fillFn)
f('define', (x, a, kw) => {
  const dflt = a[0] ?? kw.defval
  if (typeof dflt !== 'number' && typeof dflt !== 'boolean' && typeof dflt !== 'string') return x.err('define needs a default value')
  const typeKw = typeof kw.type === 'string' ? kw.type : undefined
  const type = typeKw ?? (typeof dflt === 'number' ? (Number.isInteger(dflt) ? 'integer' : 'float') : typeof dflt === 'boolean' ? 'bool' : 'string')
  const name = kw.name ?? kw.title
  const v = x.defineInput({
    name: typeof name === 'string' ? name : (x.assignName ?? 'input'),
    type,
    default: dflt,
    min: typeof (kw.min ?? kw.minval) === 'number' ? (kw.min ?? kw.minval) as number : undefined,
    max: typeof (kw.max ?? kw.maxval) === 'number' ? (kw.max ?? kw.maxval) as number : undefined,
  })
  return v
})
BUILTINS.input = BUILTINS.define

// ---- indicators: kernels ----
/** Webull's ind.* argument order is undocumented. Rule we use: explicit series args (src, src2) come first, then params;
 *  high/low/close/volume come implicitly from the bar (matches `ind.atr(len)` in real scripts). */
function kernelFn(name: string, spec: KernelSpec): (ctx: CallCtx, args: Value[], kw: Record<string, Value>) => Value {
  const explicit = spec.inputs.filter((i) => i === 'src' || i === 'src2')
  return (x, a, kw) => {
    const series: Record<string, number> = {}
    explicit.forEach((nm, i) => (series[nm] = num(a[i])))
    const params = spec.params.map((p, i) => {
      const v = kw[p.name] ?? a[explicit.length + i]
      if (v === undefined) {
        if (p.default === undefined) x.err(`${name}: missing parameter '${p.name}'`)
        return p.default
      }
      return num(v)
    })
    const b = x.bars[x.bar]
    series.high = b.high; series.low = b.low; series.close = b.close; series.volume = b.volume
    const st = x.state(() => spec.kernel.init(...params))
    const out = spec.kernel.step(st, ...spec.inputs.map((i) => series[i]))
    return out as Value
  }
}
const KERNEL_PREFIX: Record<string, string[]> = {
  highest: ['math.highest'], lowest: ['math.lowest'], sum: ['math.sum'], std: ['math.std'], variance: ['math.variance'], dev: ['math.dev'],
  cumsum: ['math.cumsum'], diff: ['math.diff'], stoch: ['math.stoch'], highestOffset: ['bar_check.highest_offset'], lowestOffset: ['bar_check.lowest_offset'],
  upTrend: ['ind.up_trend'], downTrend: ['ind.down_trend'],
}
for (const [name, spec] of Object.entries(KERNELS)) {
  const fn = kernelFn(name, spec)
  const names = KERNEL_PREFIX[name] ?? [`ind.${name}`]
  for (const n of names) BUILTINS[n] = { kind: 'fn', call: fn }
  if (!(name in BUILTINS) && !['sum', 'diff', 'std', 'variance', 'dev', 'cumsum', 'highest', 'lowest', 'stoch', 'tr'].includes(name)) BUILTINS[name] = { kind: 'fn', call: fn } // bare legacy alias: ema(close, 8)
}
// up/down trend come back 1/0 from the kernel; make them boolean
for (const n of ['ind.up_trend', 'ind.down_trend']) {
  const inner = (BUILTINS[n] as Extract<Builtin, { kind: 'fn' }>).call
  BUILTINS[n] = { kind: 'fn', call: (x, a, kw) => { const r = inner(x, a, kw) as number; return Number.isNaN(r) ? NONE : r === 1 } }
}
delete BUILTINS.upTrend; delete BUILTINS.downTrend; delete BUILTINS.highestOffset; delete BUILTINS.lowestOffset

// ---- multi timeframe (signature is our guess: requestbar(interval, source)) ----
function intervalMs(iv: string, at: CallCtx): number {
  const m = /^(\d+)?\s*(s|m|min|h|H|d|D|w|W)?$/.exec(iv.trim())
  if (!m) at.err(`requestbar: unknown interval '${iv}'`)
  const n = m[1] ? Number(m[1]) : 1
  const u = m[2] ?? (m[1] ? 'm' : 'd')
  const unit: Record<string, number> = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, H: 3_600_000, d: 86_400_000, D: 86_400_000, w: 604_800_000, W: 604_800_000 }
  return n * unit[u]
}
const FIELD: Record<string, (b: Bar) => number> = {
  open: (b) => b.open, high: (b) => b.high, low: (b) => b.low, close: (b) => b.close, volume: (b) => b.volume,
  hl2: (b) => (b.high + b.low) / 2, hlc3: (b) => (b.high + b.low + b.close) / 3, ohlc4: (b) => (b.open + b.high + b.low + b.close) / 4, hlcc4: (b) => (b.high + b.low + 2 * b.close) / 4,
}
f('requestbar', (x, a) => {
  const iv = a[0]
  if (typeof iv !== 'string') return x.err('requestbar: first argument must be an interval string like "1D"')
  const src = typeof a[1] === 'string' ? a[1] : 'close'
  const pickField = FIELD[src]
  if (!pickField) return x.err(`requestbar: unknown source '${src}'`)
  const htf = x.requestBars(iv)
  const dur = intervalMs(iv, x)
  const s = x.state(() => ({ i: -1 }))
  const t = x.bars[x.bar].time
  while (s.i + 1 < htf.length && htf[s.i + 1].time + dur <= t) s.i++
  return s.i < 0 ? NaN : pickField(htf[s.i])
})
// requestbar(close) style: interpreter passes numbers for bar-field idents, so allow requestbar("1D", close) by recovering the field via ctx.
export { ScriptError }
