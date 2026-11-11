import { Kernel, L, push, hasNaN, div } from './kernel'

export const cumsum: Kernel<{ t: number }, [], [number], number> = {
  init: () => ({ t: 0 }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    s.t += x
    return s.t
  },
}

export const diff: Kernel<{ n: number; buf: number[] }, [number?], [number], number> = {
  init: (n = 1) => ({ n: L(n), buf: [] }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    push(s.buf, x, s.n + 1)
    return s.buf.length < s.n + 1 ? NaN : x - s.buf[0]
  },
}

// Accumulation/distribution; a bar with high == low adds 0.
export const accdist: Kernel<{ t: number }, [], [number, number, number, number], number> = {
  init: () => ({ t: 0 }),
  step(s, h, l, c, v) {
    if (hasNaN(h, l, c, v)) return NaN
    const r = h === l ? 0 : div(((c - l) - (h - c)) * v, h - l)
    s.t += Number.isNaN(r) ? 0 : r
    return s.t
  },
}

type Run = { n: number; buf: number[] }
// 1 when src rose (or fell) strictly on each of the last len bars (needs len+1 values), else 0.
// Our guess at Webull semantics; unverified against a live Webull chart.
function trend(sign: 1 | -1): Kernel<Run, [number], [number], number> {
  return {
    init: n => ({ n: L(n), buf: [] }),
    step(s, x) {
      if (Number.isNaN(x)) return NaN
      push(s.buf, x, s.n + 1)
      if (s.buf.length < s.n + 1) return NaN
      for (let i = 1; i < s.buf.length; i++) if (sign * (s.buf[i] - s.buf[i - 1]) <= 0) return 0
      return 1
    },
  }
}
export const upTrend = trend(1)
export const downTrend = trend(-1)
