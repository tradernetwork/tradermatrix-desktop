import { normalizeSymbol } from '../chart/useChartData'

/** The chart symbol saved in a panel's params. Params come from a saved layout (untrusted): anything but a valid ticker string is ignored. */
export function savedChartSymbol(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null
  const s = (params as { symbol?: unknown }).symbol
  return typeof s === 'string' ? normalizeSymbol(s) : null
}
