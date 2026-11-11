/**
 * ESTIMATED buy/sell split of a bar's volume. Robinhood bars carry TOTAL volume only: there is no side split and no
 * tick tape. So the "buy" share is guessed from where the bar closed inside its own range:
 *   buy share = (close - low) / (high - low), 0.5 when high == low (or the prices are unusable), clamped to 0..1.
 * It is a heuristic (a close near the high is read as buying pressure), NOT trade-side data: every place that shows it
 * must say "est.". Aggregated bars (3m/15m/2h) are split from the aggregated bar's own high/low/close.
 */
export interface SplitInput {
  high: number
  low: number
  close: number
  volume: number
}

export interface VolumeSplit {
  total: number
  buy: number
  sell: number
}

/** Estimated buy share in 0..1. */
export function buyShare(b: Pick<SplitInput, 'high' | 'low' | 'close'>): number {
  const range = b.high - b.low
  if (!Number.isFinite(b.high) || !Number.isFinite(b.low) || !Number.isFinite(b.close) || !(range > 0)) return 0.5
  return Math.min(1, Math.max(0, (b.close - b.low) / range))
}

/** Zero, negative or non-finite volume is an empty split. buy + sell === total. */
export function splitVolume(b: SplitInput): VolumeSplit {
  const total = Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0
  if (total === 0) return { total: 0, buy: 0, sell: 0 }
  const buy = total * buyShare(b)
  return { total, buy, sell: total - buy }
}
