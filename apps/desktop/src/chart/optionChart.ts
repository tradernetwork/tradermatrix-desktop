/** Option mode for the chart: one contract's price history in place of the underlying equity. */
import type { RhOptionPosition } from '../lib/api'
import { optionLabel } from '../lib/optionPositions'
import { isEquityTicker } from '../lib/symbols'

/** Option contract instrument id (uuid), the only thing the Rust read accepts. */
export const OPTION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export interface ChartOption {
  id: string
  /** e.g. "AAPL 2026-11-13 85 C" */
  label: string
  /** The equity the contract is on ("back to AAPL"). */
  underlying: string
}

export function chartOptionFromPosition(p: Pick<RhOptionPosition, 'option_id' | 'chain_symbol' | 'expiration_date' | 'strike_price' | 'option_type'>): ChartOption | null {
  const underlying = p.chain_symbol.trim().toUpperCase()
  if (!OPTION_ID_RE.test(p.option_id) || !isEquityTicker(underlying)) return null
  return { id: p.option_id, label: optionLabel(p), underlying }
}
