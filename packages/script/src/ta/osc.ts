import { Kernel, L, push, hasNaN, div } from './kernel'
import { ema, rma, sma } from './ma'

type RsiState = { n: number; prev: number; cnt: number; sg: number; sl: number; ag: number; al: number }
function rsiVal(ag: number, al: number): number {
  if (al === 0) return ag === 0 ? NaN : 100 // flat = 0/0 -> NaN
  return 100 - 100 / (1 + ag / al)
}
export const rsi: Kernel<RsiState, [number], [number], number> = {
  init: n => ({ n: L(n), prev: NaN, cnt: 0, sg: 0, sl: 0, ag: NaN, al: NaN }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    if (Number.isNaN(s.prev)) { s.prev = x; return NaN }
    const d = x - s.prev
    s.prev = x
    const g = Math.max(d, 0), l = Math.max(-d, 0)
    if (Number.isNaN(s.ag)) {
      s.sg += g; s.sl += l; s.cnt++
      if (s.cnt < s.n) return NaN
      s.ag = s.sg / s.n; s.al = s.sl / s.n
    } else {
      s.ag += (g - s.ag) / s.n
      s.al += (l - s.al) / s.n
    }
    return rsiVal(s.ag, s.al)
  },
}

type CmoState = { n: number; buf: number[] }
export const cmo: Kernel<CmoState, [number], [number], number> = {
  init: n => ({ n: L(n), buf: [] }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    push(s.buf, x, s.n + 1)
    if (s.buf.length < s.n + 1) return NaN
    let up = 0, dn = 0
    for (let i = 1; i < s.buf.length; i++) {
      const d = s.buf[i] - s.buf[i - 1]
      if (d > 0) up += d; else dn -= d
    }
    return div((up - dn) * 100, up + dn)
  },
}

export const cci: Kernel<CmoState, [number], [number], number> = {
  init: n => ({ n: L(n), buf: [] }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    push(s.buf, x, s.n)
    if (s.buf.length < s.n) return NaN
    const m = s.buf.reduce((a, c) => a + c, 0) / s.n
    const md = s.buf.reduce((a, c) => a + Math.abs(c - m), 0) / s.n
    return div(x - m, 0.015 * md)
  },
}

export const cog: Kernel<CmoState, [number], [number], number> = {
  init: n => ({ n: L(n), buf: [] }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    push(s.buf, x, s.n)
    if (s.buf.length < s.n) return NaN
    let num = 0, den = 0
    for (let i = 0; i < s.n; i++) {
      const v = s.buf[s.n - 1 - i] // i = 0 is the current bar
      num += v * (i + 1)
      den += v
    }
    return div(-num, den)
  },
}

type MfiState = { n: number; prev: number; pos: number[]; neg: number[] }
export const mfi: Kernel<MfiState, [number], [number, number], number> = {
  init: n => ({ n: L(n), prev: NaN, pos: [], neg: [] }),
  step(s, x, vol) {
    if (hasNaN(x, vol)) return NaN
    if (Number.isNaN(s.prev)) { s.prev = x; return NaN }
    const f = x * vol
    push(s.pos, x > s.prev ? f : 0, s.n)
    push(s.neg, x < s.prev ? f : 0, s.n)
    s.prev = x
    if (s.pos.length < s.n) return NaN
    const p = s.pos.reduce((a, c) => a + c, 0), q = s.neg.reduce((a, c) => a + c, 0)
    if (q === 0) return p === 0 ? NaN : 100
    return 100 - 100 / (1 + p / q)
  },
}

type TsiState = { prev: number; a1: any; a2: any; b1: any; b2: any }
export const tsi: Kernel<TsiState, [number, number], [number], number> = {
  init: (short, long) => ({
    prev: NaN,
    a1: ema.init(long), a2: ema.init(short), b1: ema.init(long), b2: ema.init(short),
  }),
  step(s, x) {
    if (Number.isNaN(x)) return NaN
    if (Number.isNaN(s.prev)) { s.prev = x; return NaN }
    const m = x - s.prev
    s.prev = x
    // ema.step returns NaN without advancing on NaN input, so the chain is safe
    const num = ema.step(s.a2, ema.step(s.a1, m))
    const den = ema.step(s.b2, ema.step(s.b1, Math.abs(m)))
    return div(num, den)
  },
}

type MacdState = { f: any; s: any; g: any }
export const macd: Kernel<MacdState, [number, number, number], [number], number[]> = {
  init: (fast, slow, sig) => ({ f: ema.init(fast), s: ema.init(slow), g: ema.init(sig) }),
  step(st, x) {
    if (Number.isNaN(x)) return [NaN, NaN, NaN]
    const f = ema.step(st.f, x), sl = ema.step(st.s, x)
    const m = f - sl // NaN while either is warming
    const sg = ema.step(st.g, m)
    return [m, sg, m - sg]
  },
}

type StochState = { n: number; h: number[]; l: number[] }
export const stoch: Kernel<StochState, [number], [number, number, number], number> = {
  init: n => ({ n: L(n), h: [], l: [] }),
  step(s, x, hi, lo) {
    if (hasNaN(x, hi, lo)) return NaN
    push(s.h, hi, s.n)
    push(s.l, lo, s.n)
    if (s.h.length < s.n) return NaN
    const H = Math.max(...s.h), Lo = Math.min(...s.l)
    return div((x - Lo) * 100, H - Lo)
  },
}
