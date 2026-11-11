/** Pure translation of a ScriptOutput into draw operations. No canvas and no KLineChart types in here. */
import type { FillOut, PlotOut, PlotRef, ScriptOutput } from '@rebull/script'

export interface Mapper {
  /** Pixel x of a data index (bar center). */
  x(index: number): number
  /** Pixel y of a value. */
  y(value: number): number
  /** Pixel y of value 0, clamped to the pane. */
  yBase: number
  /** Visible data index range, inclusive. */
  from: number
  to: number
  /** Pane pixel bounds, used to span hlines. Optional. */
  left?: number
  right?: number
  /** Vertical pane bounds in pixels (visible price range); the TM overlay clips to them. Optional. */
  top?: number
  bottom?: number
  /** Data index of the newest bar (the TM expected-move bands start there). Defaults to `to`. */
  last?: number
}

export type DrawOp =
  | { kind: 'polyline'; points: [number, number][]; color: string; width: number; step?: boolean; alpha?: number }
  | { kind: 'polygon'; points: [number, number][]; color: string; alpha: number }
  | { kind: 'circle'; x: number; y: number; r: number; color: string; alpha?: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string; alpha?: number }
  | { kind: 'hline'; y: number; color: string; width: number; dash: number[]; x0?: number; x1?: number; alpha?: number }
  | { kind: 'label'; text: string; x: number; y: number; color: string; align: 'left' | 'right' | 'center'; alpha?: number; halo?: string; font?: string }
  | { kind: 'chip'; text: string; x: number; y: number; color: string; ink: string; alpha?: number; /** 'right': x is the RIGHT edge (default 'left'). */ align?: 'left' | 'right' }
  | { kind: 'cross'; x: number; y: number; size: number; color: string; alpha?: number }

const fin = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v)
const alphaOf = (opacity: number) => (Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity / 100)) : 1)
const DASH = { solid: [] as number[], dashed: [6, 4], dotted: [2, 3] }

export function planDraw(out: ScriptOutput, m: Mapper, barWidthPx: number): DrawOp[] {
  const fills: DrawOp[] = []
  const bodies: DrawOp[] = []
  const lineOps: DrawOp[] = []
  const hlineOps: DrawOp[] = []
  const marks: DrawOp[] = []

  let n = 0
  for (const p of out.plots) n = Math.max(n, p.values.length)
  for (const f of out.fills) n = Math.max(n, f.color.length)
  const lo = Math.max(0, Math.floor(m.from) - 1)
  const hi = Math.min(n - 1, Math.ceil(m.to) + 1)
  const bw = Number.isFinite(barWidthPx) && barWidthPx > 0 ? barWidthPx : 6

  const plotById = new Map<number, PlotOut>(out.plots.map((p) => [p.id, p]))
  const hlineById = new Map(out.hlines.map((h) => [h.id, h]))
  const edge = (r: PlotRef): ((i: number) => number) => {
    if (r.kind === 'hline') {
      const v = hlineById.get(r.id)?.value ?? NaN
      return () => v
    }
    const p = plotById.get(r.id)
    return (i) => p?.values[i] ?? NaN
  }

  // ---- fills ----
  const planFill = (f: FillOut) => {
    const va = edge(f.a)
    const vb = edge(f.b)
    const col = (i: number) => f.color[i] ?? null
    const ya = (i: number) => m.y(va(i))
    const yb = (i: number) => m.y(vb(i))
    const both = (i: number) => i >= 0 && i < n && fin(ya(i)) && fin(yb(i)) && fin(m.x(i))
    const ok = (i: number) => both(i) && col(i) !== null
    const alpha = alphaOf(f.opacity)
    let i = lo
    while (i <= hi) {
      if (!ok(i)) {
        i++
        continue
      }
      const s = i
      const color = col(s)!
      let e = s
      while (e + 1 <= hi && ok(e + 1) && col(e + 1) === color) e++
      i = e + 1
      const A: [number, number][] = []
      const B: [number, number][] = []
      const mid = (p: number, q: number): [[number, number], [number, number]] => [
        [(m.x(p) + m.x(q)) / 2, (ya(p) + ya(q)) / 2],
        [(m.x(p) + m.x(q)) / 2, (yb(p) + yb(q)) / 2],
      ]
      // left boundary: only against a finite neighbour with a different non-null color
      const hasLeft = ok(s - 1) && col(s - 1) !== color
      const hasRight = ok(e + 1) && col(e + 1) !== color
      if (hasLeft) {
        const [a, b] = mid(s - 1, s)
        A.push(a)
        B.push(b)
      } else if (s === e && !hasRight) {
        const h = Math.max(bw / 2, 1)
        A.push([m.x(s) - h, ya(s)])
        B.push([m.x(s) - h, yb(s)])
      }
      for (let k = s; k <= e; k++) {
        A.push([m.x(k), ya(k)])
        B.push([m.x(k), yb(k)])
      }
      if (hasRight) {
        const [a, b] = mid(e, e + 1)
        A.push(a)
        B.push(b)
      } else if (s === e && !hasLeft) {
        const h = Math.max(bw / 2, 1)
        A.push([m.x(s) + h, ya(s)])
        B.push([m.x(s) + h, yb(s)])
      }
      fills.push({ kind: 'polygon', points: [...A, ...B.reverse()], color, alpha })
    }
  }
  for (const f of out.fills) planFill(f)

  // ---- plots ----
  const half = Math.max(1, bw * 0.4)
  for (const p of out.plots) {
    if (p.display === 'none') continue
    const alpha = alphaOf(p.opacity)
    const valid = (i: number) => {
      const v = p.values[i]
      return fin(v) && p.color[i] != null && fin(m.y(v)) && fin(m.x(i))
    }
    const t = p.type
    if (t === 'line' || t === 'linebr' || t === 'stepline' || t === 'area') {
      let i = lo
      while (i <= hi) {
        if (!valid(i)) {
          i++
          continue
        }
        let e = i
        while (e + 1 <= hi && valid(e + 1)) e++
        // split the run on per-bar color changes, sharing the joint point
        let segStart = i
        const flush = (a: number, b: number) => {
          if (b <= a) return
          const color = p.color[b]!
          const pts: [number, number][] = []
          for (let k = a; k <= b; k++) {
            const pt: [number, number] = [m.x(k), m.y(p.values[k]!)]
            if (t === 'stepline' && pts.length) {
              const prev = pts[pts.length - 1]!
              pts.push([pt[0], prev[1]])
            }
            pts.push(pt)
          }
          const op: DrawOp = { kind: 'polyline', points: pts, color, width: p.lineWidth || 1, alpha }
          if (t === 'stepline') op.step = true
          lineOps.push(op)
        }
        for (let k = i + 1; k <= e; k++) {
          if (p.color[k] !== p.color[k - 1]) {
            flush(segStart, k)
            segStart = k
          }
        }
        flush(segStart, e)
        if (t === 'area') {
          let a = i
          for (let k = i; k <= e; k++) {
            if (k === e || p.color[k + 1] !== p.color[k]) {
              const top: [number, number][] = []
              for (let q = a; q <= k; q++) top.push([m.x(q), m.y(p.values[q]!)])
              if (top.length === 1) {
                top.unshift([top[0]![0] - half, top[0]![1]])
                top.push([top[1]![0] + half, top[1]![1]])
              }
              const first = top[0]!
              const last = top[top.length - 1]!
              bodies.push({ kind: 'polygon', points: [...top, [last[0], m.yBase], [first[0], m.yBase]], color: p.color[k]!, alpha })
              a = k + 1
            }
          }
        }
        i = e + 1
      }
    } else if (t === 'columns' || t === 'histogram') {
      const w = Math.max(1, t === 'columns' ? bw * 0.8 : bw * 0.6)
      for (let i = lo; i <= hi; i++) {
        if (!valid(i)) continue
        const y = m.y(p.values[i]!)
        bodies.push({ kind: 'rect', x: m.x(i) - w / 2, y: Math.min(y, m.yBase), w, h: Math.abs(y - m.yBase), color: p.color[i]!, alpha })
      }
    } else if (t === 'circles') {
      const r = Math.min(5, Math.max(3, bw / 3))
      for (let i = lo; i <= hi; i++) if (valid(i)) marks.push({ kind: 'circle', x: m.x(i), y: m.y(p.values[i]!), r, color: p.color[i]!, alpha })
    } else if (t === 'cross') {
      const size = Math.min(5, Math.max(3, bw / 3))
      for (let i = lo; i <= hi; i++) if (valid(i)) marks.push({ kind: 'cross', x: m.x(i), y: m.y(p.values[i]!), size, color: p.color[i]!, alpha })
    }
  }

  // ---- hlines ----
  for (const h of out.hlines) {
    const y = m.y(h.value)
    if (!fin(y)) continue
    const x0 = m.left ?? m.x(m.from) - bw
    const x1 = m.right ?? m.x(m.to) + bw
    hlineOps.push({ kind: 'hline', y, color: h.color, width: h.lineWidth || 1, dash: DASH[h.style] ?? [], ...(fin(x0) && fin(x1) ? { x0, x1 } : {}) })
  }

  return [...fills, ...bodies, ...lineOps, ...hlineOps, ...marks]
}
