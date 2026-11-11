/**
 * Fibonacci ladder from the HTF swing (swing-based retracement levels).
 * Direction: is_uptrend = (close - swingLow) / range > 0.55 on the CURRENT close (strict). Up: 0 at the swing low, 1 at the swing high.
 * Down: 0 at the swing HIGH, 1 at the swing low (the ladder is anchored on the trend end).
 *
 * DEVIATION from the Pine as written: the downtrend extensions in the script are computed as fib_bottom - fib_range * x with a
 * NEGATIVE fib_range, which lands ABOVE the swing high. The plan (and the intent) is extensions beyond the trend end, so here a
 * downtrend extends below the swing low. Everything else is ported as written, including the "golden zone" (uptrend 0.236-0.382,
 * downtrend 0.618-0.786), which is not the classic 0.618-0.65 pocket: the UI calls it the "script zone".
 */
export type FibKind = 'major' | 'standard' | 'golden' | 'ext'

export interface FibLevel {
  ratio: number
  price: number
  kind: FibKind
}

export interface Fib {
  up: boolean
  levels: FibLevel[]
  zone: { lo: number; hi: number }
  swingHigh: number
  swingLow: number
}

const fin = Number.isFinite

/** (close - low) / (high - low); NaN when the range is 0 or an input is not finite. */
export function rangePosition(close: number, swingHigh: number, swingLow: number): number {
  const r = swingHigh - swingLow
  if (!fin(close) || !fin(r) || r === 0) return NaN
  return (close - swingLow) / r
}

export function computeFib(swingHigh: number, swingLow: number, close: number, show886: boolean): Fib | null {
  const pos = rangePosition(close, swingHigh, swingLow)
  if (!fin(pos) || swingHigh <= swingLow) return null
  const up = pos > 0.55
  const bottom = up ? swingLow : swingHigh
  const top = up ? swingHigh : swingLow
  const range = top - bottom // signed: negative in a downtrend
  const at = (r: number) => bottom + range * r
  const ext = (r: number) => top + range * (r - 1) // beyond the trend end in both directions
  const levels: FibLevel[] = [
    { ratio: 0, price: at(0), kind: 'major' },
    { ratio: 0.236, price: at(0.236), kind: 'standard' },
    { ratio: 0.382, price: at(0.382), kind: 'standard' },
    { ratio: 0.5, price: at(0.5), kind: 'major' },
    { ratio: 0.618, price: at(0.618), kind: 'golden' },
    { ratio: 0.786, price: at(0.786), kind: 'standard' },
  ]
  if (show886) levels.push({ ratio: 0.886, price: at(0.886), kind: 'standard' })
  levels.push(
    { ratio: 1, price: at(1), kind: 'major' },
    { ratio: 1.272, price: ext(1.272), kind: 'ext' },
    { ratio: 1.414, price: ext(1.414), kind: 'ext' },
    { ratio: 1.618, price: ext(1.618), kind: 'ext' },
  )
  const za = up ? at(0.236) : at(0.618)
  const zb = up ? at(0.382) : at(0.786)
  return { up, levels, zone: { lo: Math.min(za, zb), hi: Math.max(za, zb) }, swingHigh, swingLow }
}
