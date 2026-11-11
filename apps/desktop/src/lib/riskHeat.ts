/**
 * Portfolio heat (M18): the sum of planned R across open positions. READ-ONLY and INFORMATIONAL: no threshold, no 6-8% rule, never a block.
 * A position without a recorded risk is listed as unknown and is never counted as zero.
 */
export interface HeatPosition {
  id: string
  plannedRiskUsd?: number | null
}

export interface HeatReadout {
  totalUsd: number
  /** Percent of equity, null when equity is unavailable. */
  pctOfEquity: number | null
  counted: number
  /** Ids of positions with no usable recorded risk. */
  unknown: string[]
}

export function heatReadout(equity: number | null | undefined, positions: readonly HeatPosition[]): HeatReadout {
  let total = 0
  let counted = 0
  const unknown: string[] = []
  for (const p of positions) {
    const r = p.plannedRiskUsd
    if (typeof r === 'number' && Number.isFinite(r) && r > 0) {
      total += r
      counted += 1
    } else {
      unknown.push(p.id)
    }
  }
  const totalUsd = Math.round(total * 100) / 100
  const ok = typeof equity === 'number' && Number.isFinite(equity) && equity > 0
  return { totalUsd, pctOfEquity: ok ? Number.parseFloat(((totalUsd / equity) * 100).toPrecision(12)) : null, counted, unknown }
}
