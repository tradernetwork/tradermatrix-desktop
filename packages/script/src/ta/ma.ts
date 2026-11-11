import { Kernel, L, push, hasNaN, div, mean } from './kernel'

type WinState = { n: number; buf: number[] }

export const sma: Kernel<WinState, [number], [number], number> = {
  init: n => ({ n: L(n), buf: [] }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    push(s.buf, x, s.n)
    return s.buf.length < s.n ? NaN : mean(s.buf)
  },
}

type EmaState = { n: number; a: number; buf: number[]; v: number }
function smoothed(alphaOf: (n: number) => number): Kernel<EmaState, [number], [number], number> {
  return {
    init: n => ({ n: L(n), a: alphaOf(L(n)), buf: [], v: NaN }),
    step(s, x) {
      if (Number.isNaN(x)) return NaN
      if (Number.isNaN(s.v)) {
        s.buf.push(x)
        if (s.buf.length < s.n) return NaN
        s.v = mean(s.buf)
        s.buf = []
        return s.v
      }
      s.v += s.a * (x - s.v)
      return s.v
    },
  }
}
export const ema = smoothed(n => 2 / (n + 1))
export const rma = smoothed(n => 1 / n)

export const wma: Kernel<WinState, [number], [number], number> = {
  init: n => ({ n: L(n), buf: [] }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    push(s.buf, x, s.n)
    if (s.buf.length < s.n) return NaN
    let acc = 0
    for (let i = 0; i < s.n; i++) acc += s.buf[i] * (i + 1)
    return acc / ((s.n * (s.n + 1)) / 2)
  },
}

type HmaState = { w1: WinState; w2: WinState; w3: WinState }
export const hma: Kernel<HmaState, [number], [number], number> = {
  init(n) {
    const len = L(n)
    return {
      w1: wma.init(L(Math.floor(len / 2))),
      w2: wma.init(len),
      w3: wma.init(L(Math.round(Math.sqrt(len)))),
    }
  },
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    const a = wma.step(s.w1, x)
    const b = wma.step(s.w2, x)
    if (hasNaN(a, b)) return NaN
    return wma.step(s.w3, 2 * a - b)
  },
}

type VwmaState = { n: number; pv: number[]; v: number[] }
export const vwma: Kernel<VwmaState, [number], [number, number], number> = {
  init: n => ({ n: L(n), pv: [], v: [] }),
  step(s, x, vol) {
    if (hasNaN(x, vol)) return NaN
    push(s.pv, x * vol, s.n)
    push(s.v, vol, s.n)
    if (s.v.length < s.n) return NaN
    return div(s.pv.reduce((a, c) => a + c, 0), s.v.reduce((a, c) => a + c, 0))
  },
}

type AlmaState = { n: number; w: number[]; buf: number[] }
export const alma: Kernel<AlmaState, [number, number?, number?], [number], number> = {
  init(n, offset = 0.85, sigma = 6) {
    const len = L(n)
    const m = Math.floor(offset * (len - 1))
    const sg = len / sigma
    const w = Array.from({ length: len }, (_, i) => Math.exp(-((i - m) ** 2) / (2 * sg * sg)))
    const tot = w.reduce((a, c) => a + c, 0)
    return { n: len, w: w.map(x => x / tot), buf: [] }
  },
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    push(s.buf, x, s.n)
    if (s.buf.length < s.n) return NaN
    let acc = 0
    for (let i = 0; i < s.n; i++) acc += s.buf[i] * s.w[i]
    return acc
  },
}

export const swma: Kernel<{ buf: number[] }, [], [number], number> = {
  init: () => ({ buf: [] }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    push(s.buf, x, 4)
    if (s.buf.length < 4) return NaN
    const [a, b, c, d] = s.buf
    return (a + 2 * b + 2 * c + d) / 6
  },
}

