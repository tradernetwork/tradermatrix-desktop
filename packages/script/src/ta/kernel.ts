// Indicator kernels. Webull's exact indicator semantics are unverified; we follow the Pine v5
// reference implementations (EMA/RMA seeded with the SMA of the first len values, population
// stdev, Pine-style highestbars offsets).
//
// Contract:
//  - S is plain structuredClone-able data (numbers, arrays, plain objects). No closures/Maps/classes,
//    so a session can snapshot/restore it. step() MUTATES S and returns this bar's output.
//  - Missing value is NaN on input and output. NaN RULE: a NaN input (any input) yields NaN output
//    for that bar and does NOT advance windows/seeds, so one bad bar never poisons state permanently.
//    (Pine would also skip na in most of these; the bar simply does not count.)
//  - Division by zero (or any non-finite result) yields NaN, never Infinity.
//  - Fewer bars than the length: every bar is NaN, no throw.

export interface Kernel<S, P extends unknown[], I extends unknown[], O> {
  init(...params: P): S
  step(s: S, ...inputs: I): O
}

/** Test helper: run a kernel over a list of per-bar input tuples. */
export function batch<S, P extends unknown[], I extends unknown[], O>(
  k: Kernel<S, P, I, O>,
  params: P,
  inputs: I[],
): O[] {
  const s = k.init(...params)
  return inputs.map(i => k.step(s, ...i))
}

/** Normalise a length param to an integer >= 1. */
export const L = (n: number | undefined, d = 1): number => {
  const v = n === undefined || Number.isNaN(n) ? d : Math.floor(n)
  return v < 1 ? 1 : v
}

/** Append to a rolling window capped at n. */
export function push(buf: number[], x: number, n: number): void {
  buf.push(x)
  if (buf.length > n) buf.shift()
}

export const hasNaN = (...xs: number[]): boolean => xs.some(Number.isNaN)

/** a/b, NaN when b is 0 or the result is not finite. */
export function div(a: number, b: number): number {
  if (b === 0) return NaN
  const r = a / b
  return Number.isFinite(r) ? r : NaN
}

export const mean = (b: number[]): number => b.reduce((a, c) => a + c, 0) / b.length
