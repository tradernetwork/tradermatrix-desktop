/** Small TA helpers matching Pine `ta.sma`, `ta.tr(true)` and `ta.rma`. Pure; NaN means "not enough data". */

export interface Hlc {
  high: number
  low: number
  close: number
}

/** Simple moving average by prefix sums. NaN for i < n-1 and for any window that contains a non-finite input. */
export function sma(xs: readonly number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN)
  if (!(n >= 1) || xs.length < n) return out
  const sum = new Array<number>(xs.length + 1).fill(0)
  const bad = new Array<number>(xs.length + 1).fill(0)
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!
    const ok = Number.isFinite(v)
    sum[i + 1] = sum[i]! + (ok ? v : 0)
    bad[i + 1] = bad[i]! + (ok ? 0 : 1)
  }
  for (let i = n - 1; i < xs.length; i++) {
    if (bad[i + 1]! - bad[i + 1 - n]! > 0) continue
    out[i] = (sum[i + 1]! - sum[i + 1 - n]!) / n
  }
  return out
}

/** True range; bar 0 is high - low (Pine handle_na = true). */
export function tr(bars: readonly Hlc[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low
    const pc = bars[i - 1]!.close
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))
  })
}

/** Wilder's RMA: NaN before index n-1, seeded with the SMA of the first n values, then (prev*(n-1)+x)/n. */
export function rma(xs: readonly number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN)
  if (!(n >= 1) || xs.length < n) return out
  let seed = 0
  for (let i = 0; i < n; i++) seed += xs[i]!
  out[n - 1] = seed / n
  for (let i = n; i < xs.length; i++) out[i] = (out[i - 1]! * (n - 1) + xs[i]!) / n
  return out
}
