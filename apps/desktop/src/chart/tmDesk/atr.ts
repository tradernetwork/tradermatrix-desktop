/** ATR risk levels from the last close (ATR risk levels): wide SL 1.5 / TP 2.0, 3.5, 5.5; narrow SL 1.0 / TP 1.5, 2.5, 4.0. */
export type Side = 'long' | 'short'

export interface AtrLevels {
  side: Side
  sl: number
  tp1: number
  tp2: number
  tp3: number
}

export function atrLevels(close: number, atr: number, side: Side, narrow: boolean): AtrLevels | null {
  if (!Number.isFinite(close) || !Number.isFinite(atr) || atr <= 0) return null
  const sl = narrow ? 1.0 : 1.5
  const tp = narrow ? [1.5, 2.5, 4.0] : [2.0, 3.5, 5.5]
  const s = side === 'long' ? 1 : -1
  return { side, sl: close - s * atr * sl, tp1: close + s * atr * tp[0]!, tp2: close + s * atr * tp[1]!, tp3: close + s * atr * tp[2]! }
}
