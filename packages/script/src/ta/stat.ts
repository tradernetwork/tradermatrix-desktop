import { Kernel, L, push, hasNaN, div } from './kernel'

type Win = { n: number; buf: number[] }
const win = (n: number): Win => ({ n: L(n), buf: [] })
/** Build a single-input window kernel: f gets the full window (oldest first). */
function windowed(f: (b: number[]) => number): Kernel<Win, [number], [number], number> {
  return {
    init: win,
    step(s, x) {
      if (Number.isNaN(x)) return NaN
      push(s.buf, x, s.n)
      if (s.buf.length < s.n) return NaN
      const r = f(s.buf)
      return Number.isFinite(r) ? r : NaN
    },
  }
}
const sumOf = (b: number[]) => b.reduce((a, c) => a + c, 0)
const varOf = (b: number[]) => {
  const m = sumOf(b) / b.length
  return b.reduce((a, c) => a + (c - m) ** 2, 0) / b.length // population (Pine default)
}
export const highest = windowed(b => Math.max(...b))
export const lowest = windowed(b => Math.min(...b))
export const sum = windowed(sumOf)
export const variance = windowed(varOf)
export const std = windowed(b => Math.sqrt(varOf(b)))
export const dev = windowed(b => {
  const m = sumOf(b) / b.length
  return b.reduce((a, c) => a + Math.abs(c - m), 0) / b.length // mean absolute deviation
})
// Offset in bars as Pine highestbars/lowestbars: 0 = current bar, -k = k bars ago; ties pick the most recent.
export const highestOffset = windowed(b => {
  let k = 0
  for (let i = 1; i < b.length; i++) if (b[i] >= b[k]) k = i
  return k - (b.length - 1)
})
export const lowestOffset = windowed(b => {
  let k = 0
  for (let i = 1; i < b.length; i++) if (b[i] <= b[k]) k = i
  return k - (b.length - 1)
})

type Pair = { n: number; a: number[]; b: number[] }
export const correlation: Kernel<Pair, [number], [number, number], number> = {
  init: n => ({ n: L(n), a: [], b: [] }),
  step(s, x, y) {
    if (hasNaN(x, y)) return NaN
    push(s.a, x, s.n)
    push(s.b, y, s.n)
    if (s.a.length < s.n) return NaN
    const ma = sumOf(s.a) / s.n, mb = sumOf(s.b) / s.n
    let c = 0, va = 0, vb = 0
    for (let i = 0; i < s.n; i++) {
      const da = s.a[i] - ma, db = s.b[i] - mb
      c += da * db; va += da * da; vb += db * db
    }
    return div(c, Math.sqrt(va * vb))
  },
}
