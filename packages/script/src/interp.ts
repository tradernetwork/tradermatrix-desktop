import type { Expr, Program, Stmt } from './ast'
import { BUILTINS, NONE, VALUE_FNS, num, truthy, type CallCtx } from './builtins'
import { parse } from './parser'
import {
  ScriptError, type Bar, type FillOut, type HLineOut, type InputDef, type PlotOut, type PlotRef, type PlotType, type RunOptions, type ScriptOutput, type Value,
} from './types'

const BAR_FIELDS: Record<string, (b: Bar) => number> = {
  open: (b) => b.open, high: (b) => b.high, low: (b) => b.low, close: (b) => b.close, volume: (b) => b.volume,
  hl2: (b) => (b.high + b.low) / 2, hlc3: (b) => (b.high + b.low + b.close) / 3,
  hlcc4: (b) => (b.high + b.low + 2 * b.close) / 4, ohlc4: (b) => (b.open + b.high + b.low + b.close) / 4,
}
const isBarVar = (n: string) => n in BAR_FIELDS

function dotted(e: Expr): { name: string; root: Expr } | null {
  if (e.type === 'Ident') return { name: e.name, root: e }
  if (e.type === 'Member') {
    const o = dotted(e.obj)
    return o ? { name: `${o.name}.${e.name}`, root: o.root } : null
  }
  return null
}

function userNamesOf(p: Program): Set<string> {
  const names = new Set<string>()
  const walk = (ss: Stmt[]) => {
    for (const s of ss) {
      if (s.type === 'Assign') s.targets.forEach((t) => names.add(t))
      else if (s.type === 'For') { names.add(s.name); walk(s.body) }
      else if (s.type === 'While') walk(s.body)
      else if (s.type === 'If') { walk(s.then); if (s.else) walk(s.else) }
    }
  }
  walk(p.body)
  return names
}

/** Parse and statically check: unknown functions and undefined names fail here, with line and col. */
export function compile(src: string): Program {
  const p = parse(src)
  const users = userNamesOf(p)
  const fail = (e: Expr, msg: string): never => { throw new ScriptError(msg, e.line, e.col) }
  const expr = (e: Expr): void => {
    switch (e.type) {
      case 'Ident':
        if (!users.has(e.name) && !isBarVar(e.name) && !(e.name in BUILTINS)) fail(e, `undefined name '${e.name}'`)
        return
      case 'Member': {
        const d = dotted(e)
        if (!d) return expr(e.obj)
        if (users.has(d.root.type === 'Ident' ? d.root.name : '')) fail(d.root, `'${d.name}': members of script variables are not supported`)
        if (!(d.name in BUILTINS)) fail(d.root, `unknown function or constant '${d.name}'`)
        return
      }
      case 'Call': {
        const d = dotted(e.callee)
        if (d) {
          const rootName = d.root.type === 'Ident' ? d.root.name : ''
          if (users.has(rootName)) fail(d.root, `'${d.name}' is not a function`)
          const b = BUILTINS[d.name]
          if (!b) fail(d.root, `unknown function '${d.name}'`)
          else if (b.kind !== 'fn') fail(d.root, `'${d.name}' is a constant, not a function`)
        } else expr(e.callee)
        e.args.forEach(expr)
        e.kwargs.forEach((k) => expr(k.value))
        return
      }
      case 'Index': expr(e.expr); expr(e.index); return
      case 'Unary': expr(e.expr); return
      case 'Binary': expr(e.left); expr(e.right); return
      case 'Ternary': expr(e.cond); expr(e.a); expr(e.b); return
      case 'Tuple': e.items.forEach(expr); return
    }
  }
  const stmts = (ss: Stmt[]): void => {
    for (const s of ss) {
      switch (s.type) {
        case 'Assign': expr(s.expr); break
        case 'ExprStmt': expr(s.expr); break
        case 'If': expr(s.cond); stmts(s.then); if (s.else) stmts(s.else); break
        case 'For': expr(s.from); expr(s.to); if (s.by) expr(s.by); stmts(s.body); break
        case 'While': expr(s.cond); stmts(s.body); break
      }
    }
  }
  stmts(p.body)
  return p
}

interface PlotAcc { id: number; name: string; values: number[]; color: (string | null)[]; lineWidth: number; type: PlotType; opacity: number; display: 'all' | 'none' }
interface FillAcc { a: PlotRef; b: PlotRef; name: string; opacity: number; color: (string | null)[] }
export interface Checkpoint { done: number; cur: Record<string, Value>; k: Record<number, unknown> }

const fin = (x: number) => (Number.isFinite(x) ? x : NaN)

export class Machine {
  bars: Bar[]
  private users: Set<string>
  private cur: Record<string, Value> = {}
  private hist: Record<string, Value[]> = {}
  private nodeHist: Record<number, Value[]> = {}
  private k: Record<number, unknown> = {}
  private plots = new Map<number, PlotAcc>()
  private hlines = new Map<number, HLineOut>()
  private fills = new Map<number, FillAcc>()
  private inputs = new Map<string, InputDef>()
  private htf = new Map<string, Bar[]>()
  private bar = 0
  private isUpdate = false
  private assignExpr: Expr | null = null
  private assignTarget: string | undefined
  private maxLoop: number
  private tz: string
  private ctx: CallCtx

  constructor(private p: Program, bars: Bar[], private opts: RunOptions = {}) {
    this.bars = bars.slice()
    this.users = userNamesOf(p)
    this.maxLoop = opts.maxLoopIterations ?? 10_000
    this.tz = opts.timezone ?? 'America/New_York'
    this.ctx = this.makeCtx()
  }

  get done(): number { return this.bars.length }

  /** Process every bar not yet run, up to but excluding `stopBefore` bars total. */
  runAll(stopBefore = this.bars.length): void {
    for (let i = this.progress; i < stopBefore; i++) this.runBar(i, false)
  }
  private progress = 0

  append(bar: Bar): void {
    this.bars.push(bar)
    this.runBar(this.bars.length - 1, false)
  }
  replaceLast(cp: Checkpoint, bar: Bar): void {
    this.restore(cp)
    this.bars.push(bar)
    this.runBar(this.bars.length - 1, true)
  }

  checkpoint(): Checkpoint {
    return { done: this.progress, cur: structuredClone(this.cur), k: structuredClone(this.k) }
  }
  private restore(cp: Checkpoint): void {
    this.bars.length = cp.done
    this.progress = cp.done
    this.cur = structuredClone(cp.cur)
    this.k = structuredClone(cp.k)
    for (const a of Object.values(this.hist)) a.length = cp.done
    for (const a of Object.values(this.nodeHist)) a.length = cp.done
    for (const a of this.plots.values()) { a.values.length = cp.done; a.color.length = cp.done }
    for (const a of this.fills.values()) a.color.length = cp.done
  }

  output(): ScriptOutput {
    const n = this.bars.length
    const plots: PlotOut[] = [...this.plots.values()].sort((a, b) => a.id - b.id).map((a) => {
      const values = new Float64Array(n).fill(NaN)
      for (let i = 0; i < Math.min(n, a.values.length); i++) values[i] = a.values[i] ?? NaN
      return { id: a.id, name: a.name, values, color: Array.from({ length: n }, (_, i) => a.color[i] ?? null), lineWidth: a.lineWidth, type: a.type, opacity: a.opacity, display: a.display }
    })
    const fills: FillOut[] = [...this.fills.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => ({
      a: f.a, b: f.b, name: f.name, opacity: f.opacity, color: Array.from({ length: n }, (_, i) => f.color[i] ?? null),
    }))
    return {
      inputs: [...this.inputs.values()],
      plots,
      hlines: [...this.hlines.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h),
      fills,
    }
  }

  // ---------------- execution ----------------
  private fail(node: { line: number; col: number }, msg: string): never {
    throw new ScriptError(msg, node.line, node.col, this.bar)
  }

  private runBar(i: number, isUpdate: boolean): void {
    this.bar = i
    this.isUpdate = isUpdate
    this.progress = i + 1
    this.block(this.p.body)
    for (const name of this.users) (this.hist[name] ??= [])[i] = this.cur[name] ?? NONE
  }

  private block(ss: Stmt[]): 'break' | 'continue' | undefined {
    for (const s of ss) {
      const r = this.stmt(s)
      if (r) return r
    }
    return undefined
  }

  private stmt(s: Stmt): 'break' | 'continue' | undefined {
    switch (s.type) {
      case 'Assign': {
        if (s.isVar && this.bar !== 0) return undefined
        this.assignExpr = s.expr
        this.assignTarget = s.targets[0]
        const v = this.eval(s.expr)
        this.assignExpr = null
        if (s.tuple) {
          const arr = Array.isArray(v) ? v : []
          s.targets.forEach((t, j) => (this.cur[t] = arr[j] ?? NONE))
        } else this.cur[s.targets[0]] = Array.isArray(v) ? (v[0] ?? NONE) : v
        return undefined
      }
      case 'ExprStmt': this.eval(s.expr); return undefined
      case 'If': {
        if (truthy(this.eval(s.cond))) return this.block(s.then)
        return s.else ? this.block(s.else) : undefined
      }
      case 'Break': return 'break'
      case 'Continue': return 'continue'
      case 'While': {
        let n = 0
        while (truthy(this.eval(s.cond))) {
          if (++n > this.maxLoop) this.fail(s, 'loop limit exceeded')
          const r = this.block(s.body)
          if (r === 'break') break
        }
        return undefined
      }
      case 'For': {
        const from = num(this.eval(s.from)); const to = num(this.eval(s.to))
        const by = s.by ? num(this.eval(s.by)) : 1
        if (Number.isNaN(from) || Number.isNaN(to) || Number.isNaN(by) || by === 0) this.fail(s, 'for loop bounds must be finite numbers and step must not be 0')
        let n = 0
        for (let v = from; by > 0 ? v <= to : v >= to; v += by) {
          if (++n > this.maxLoop) this.fail(s, 'loop limit exceeded')
          this.cur[s.name] = v
          const r = this.block(s.body)
          if (r === 'break') break
        }
        return undefined
      }
    }
  }

  private eval(e: Expr): Value {
    switch (e.type) {
      case 'Num': return e.value
      case 'Str': return e.value
      case 'Color': return e.value
      case 'Bool': return e.value
      case 'Ident': return this.ident(e.name, e)
      case 'Member': {
        const d = dotted(e)!
        const b = BUILTINS[d.name]
        if (!b) this.fail(e, `unknown '${d.name}'`)
        if (b.kind === 'const') return b.value
        if (VALUE_FNS.has(d.name)) { this.ctx.node = e; return b.call(this.ctx, [], {}) }
        return this.fail(e, `'${d.name}' is a function, call it with ()`)
      }
      case 'Call': return this.call(e)
      case 'Index': return this.index(e)
      case 'Unary': {
        const v = this.eval(e.expr)
        return e.op === '-' ? -num(v) : !truthy(v)
      }
      case 'Ternary': return truthy(this.eval(e.cond)) ? this.eval(e.a) : this.eval(e.b)
      case 'Tuple': return e.items.map((x) => this.eval(x))
      case 'Binary': return this.binary(e)
    }
  }

  private ident(name: string, at: { line: number; col: number }): Value {
    if (this.users.has(name)) return this.cur[name] ?? NONE
    if (isBarVar(name)) return BAR_FIELDS[name](this.bars[this.bar])
    if (name === 'na') return NONE
    const b = BUILTINS[name]
    if (b?.kind === 'const') return b.value
    if (b && VALUE_FNS.has(name)) { this.ctx.node = { id: -1, ...at }; return b.call(this.ctx, [], {}) }
    return this.fail(at, `'${name}' cannot be used as a value`)
  }

  private index(e: Extract<Expr, { type: 'Index' }>): Value {
    const nv = num(this.eval(e.index))
    if (!(nv >= 0)) return NONE
    const n = Math.trunc(nv)
    const inner = e.expr
    if (inner.type === 'Ident') {
      if (this.users.has(inner.name)) return n === 0 ? (this.cur[inner.name] ?? NONE) : (this.hist[inner.name]?.[this.bar - n] ?? NONE)
      if (isBarVar(inner.name)) { const b = this.bars[this.bar - n]; return b ? BAR_FIELDS[inner.name](b) : NONE }
    }
    const v = this.eval(inner)
    const h = (this.nodeHist[e.id] ??= [])
    h[this.bar] = v
    return n === 0 ? v : (h[this.bar - n] ?? NONE)
  }

  private binary(e: Extract<Expr, { type: 'Binary' }>): Value {
    if (e.op === 'and') return truthy(this.eval(e.left)) && truthy(this.eval(e.right))
    if (e.op === 'or') return truthy(this.eval(e.left)) || truthy(this.eval(e.right))
    const l = this.eval(e.left); const r = this.eval(e.right)
    if (e.op === '==' || e.op === '!=') {
      const eq = typeof l === 'string' || typeof r === 'string' ? l === r : num(l) === num(r)
      return e.op === '==' ? eq : !eq
    }
    const a = num(l); const b = num(r)
    switch (e.op) {
      case '+': return fin(a + b)
      case '-': return fin(a - b)
      case '*': return fin(a * b)
      case '/': return b === 0 ? NONE : fin(a / b)
      case '%': return b === 0 ? NONE : fin(a % b)
      case '<': return a < b
      case '>': return a > b
      case '<=': return a <= b
      case '>=': return a >= b
    }
    return this.fail(e, `unknown operator ${e.op}`)
  }

  private call(e: Extract<Expr, { type: 'Call' }>): Value {
    const d = dotted(e.callee)
    if (!d) return this.fail(e, 'only named functions can be called')
    const b = BUILTINS[d.name]
    if (!b || b.kind !== 'fn') return this.fail(d.root, `unknown function '${d.name}'`)
    const args = e.args.map((a, i) => (d.name === 'requestbar' && i === 1 && a.type === 'Ident' && isBarVar(a.name) ? a.name : this.eval(a)))
    const kw: Record<string, Value> = {}
    for (const k of e.kwargs) kw[k.name] = this.eval(k.value)
    this.ctx.node = d.root
    this.ctx.node = { id: e.id, line: d.root.line, col: d.root.col }
    this.ctx.assignName = e === this.assignExpr ? this.assignTarget : undefined
    return b.call(this.ctx, args, kw)
  }

  private makeCtx(): CallCtx {
    const m = this
    const ctx: CallCtx = {
      node: { id: -1, line: 0, col: 0 },
      get bar() { return m.bar },
      get bars() { return m.bars },
      get isLast() { return m.bar === m.bars.length - 1 },
      get isUpdate() { return m.isUpdate },
      get timezone() { return m.tz },
      assignName: undefined,
      state<T>(init: () => T): T { return (m.k[ctx.node.id] ??= init()) as T },
      err(msg: string): never { return m.fail(ctx.node, msg) },
      defineInput(def) {
        const key = ctx.assignName ?? def.name
        let v: number | boolean | string = m.opts.inputs?.[key] ?? def.default
        if (typeof v === 'number') {
          if (def.min !== undefined) v = Math.max(def.min, v)
          if (def.max !== undefined) v = Math.min(def.max, v)
        }
        if (!m.inputs.has(key)) {
          m.inputs.set(key, { key, name: def.name, type: def.type as InputDef['type'], default: def.default, ...(def.min !== undefined ? { min: def.min } : {}), ...(def.max !== undefined ? { max: def.max } : {}) })
        }
        return v
      },
      plot(s) {
        const id = ctx.node.id
        let a = m.plots.get(id)
        if (!a) m.plots.set(id, (a = { id, name: s.name, values: [], color: [], lineWidth: s.lineWidth, type: s.type, opacity: s.opacity, display: s.display }))
        a.values[m.bar] = fin(s.value)
        a.color[m.bar] = s.color
        return { kind: 'plot', id }
      },
      hline(s) {
        const id = ctx.node.id
        if (!m.hlines.has(id)) m.hlines.set(id, { id, value: s.value, color: s.color, style: s.style, lineWidth: s.lineWidth })
        return { kind: 'hline', id }
      },
      fill(s) {
        const id = ctx.node.id
        let f = m.fills.get(id)
        if (!f) m.fills.set(id, (f = { a: s.a, b: s.b, name: s.name, opacity: s.opacity, color: [] }))
        f.color[m.bar] = s.color
      },
      requestBars(interval) {
        const host = m.opts.host
        if (!host) return m.fail(ctx.node, 'requestbar needs a host that can supply higher-timeframe bars')
        let bars = m.htf.get(interval)
        if (!bars) m.htf.set(interval, (bars = host.requestBars(interval)))
        return bars
      },
    }
    return ctx
  }
}
