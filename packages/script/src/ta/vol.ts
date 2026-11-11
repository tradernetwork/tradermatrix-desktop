import { Kernel, L, push, hasNaN, mean, div } from './kernel'
import { ema, rma } from './ma'

export const tr: Kernel<{ pc: number }, [], [number, number, number], number> = {
  init: () => ({ pc: NaN }),
  step(s, h, l, c) {
    if (hasNaN(h, l, c)) return NaN
    const r = Number.isNaN(s.pc) ? h - l : Math.max(h - l, Math.abs(h - s.pc), Math.abs(l - s.pc))
    s.pc = c
    return r
  },
}

type AtrState = { t: { pc: number }; r: any }
export const atr: Kernel<AtrState, [number], [number, number, number], number> = {
  init: n => ({ t: tr.init(), r: rma.init(n) }),
  step(s, h, l, c) {
    const t = tr.step(s.t, h, l, c)
    return rma.step(s.r, t)
  },
}

type BbState = { n: number; m: number; buf: number[] }
export const bb: Kernel<BbState, [number, number], [number], number[]> = {
  init: (n, mult) => ({ n: L(n), m: mult, buf: [] }),
  step(s, x) {
    if (Number.isNaN(x)) return [NaN, NaN, NaN]
    push(s.buf, x, s.n)
    if (s.buf.length < s.n) return [NaN, NaN, NaN]
    const mid = mean(s.buf)
    const sd = Math.sqrt(s.buf.reduce((a, c) => a + (c - mid) ** 2, 0) / s.n) // population
    return [mid, mid + s.m * sd, mid - s.m * sd]
  },
}

type KcState = { m: number; e: any; a: AtrState }
export const kc: Kernel<KcState, [number, number], [number, number, number, number], number[]> = {
  init: (n, mult) => ({ m: mult, e: ema.init(n), a: atr.init(n) }),
  step(s, x, h, l, c) {
    if (hasNaN(x, h, l, c)) return [NaN, NaN, NaN]
    const mid = ema.step(s.e, x)
    const a = atr.step(s.a, h, l, c)
    return [mid, mid + s.m * a, mid - s.m * a]
  },
}

type DmiState = { ph: number; pl: number; pc: number; p: any; q: any; t: any; x: any }
export const dmi: Kernel<DmiState, [number, number], [number, number, number], number[]> = {
  init: (di, adx) => ({ ph: NaN, pl: NaN, pc: NaN, p: rma.init(di), q: rma.init(di), t: rma.init(di), x: rma.init(adx) }),
  step(s, h, l, c) {
    if (hasNaN(h, l, c)) return [NaN, NaN, NaN]
    if (Number.isNaN(s.pc)) { s.ph = h; s.pl = l; s.pc = c; return [NaN, NaN, NaN] }
    const up = h - s.ph, dn = s.pl - l
    const trv = Math.max(h - l, Math.abs(h - s.pc), Math.abs(l - s.pc))
    s.ph = h; s.pl = l; s.pc = c
    const p = rma.step(s.p, up > dn && up > 0 ? up : 0)
    const q = rma.step(s.q, dn > up && dn > 0 ? dn : 0)
    const t = rma.step(s.t, trv)
    const pd = div(100 * p, t), md = div(100 * q, t)
    const dx = div(100 * Math.abs(pd - md), pd + md)
    const adx = rma.step(s.x, dx)
    return [pd, md, adx]
  },
}
