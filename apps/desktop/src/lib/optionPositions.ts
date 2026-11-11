/**
 * Pure helpers for the Options section of the Positions pane.
 *
 * UNITS RULE (get_option_positions / get_option_quotes schema descriptions, the Robinhood MCP tool schemas):
 *  - `quantity` is a positive count of contracts; long/short is in `side`.
 *  - `average_price` is the "signed cost basis per contract": DOLLARS PER CONTRACT (per-share premium x multiplier),
 *    negative for a credit received on a short. Per-share average = |average_price| / multiplier.
 *  - bid / ask / mark are PER SHARE premiums. One contract is worth mark x multiplier dollars.
 * So: cost basis = |average_price| x contracts; market value = mark x multiplier x contracts;
 *   long P&L = value - cost; short P&L = cost (credit received) - value (cost to buy back).
 * The schema text for average_price is terse; this reading matches Robinhood's public API. Verify with a real capture.
 */
import type { RhOptionPosition } from './api'

export interface OptionPnl {
  /** Per-share average premium (positive for both sides). */
  avgPerShare: number | null
  /** Dollars paid (long) or credit received (short), for all contracts. */
  cost: number | null
  /** Dollars to close at the mark, for all contracts. */
  value: number | null
  pnl: number | null
  pnlPct: number | null
}

export function optionPnl(r: RhOptionPosition): OptionPnl {
  const mult = r.multiplier > 0 ? r.multiplier : 100
  const avgPerContract = r.average_price === null ? null : Math.abs(r.average_price)
  const cost = avgPerContract === null ? null : avgPerContract * r.quantity
  const value = r.mark === null ? null : r.mark * mult * r.quantity
  let pnl: number | null = null
  if (cost !== null && value !== null) pnl = r.side === 'short' ? cost - value : value - cost
  const pnlPct = pnl !== null && cost !== null && cost > 0 ? (pnl / cost) * 100 : null
  return { avgPerShare: avgPerContract === null ? null : avgPerContract / mult, cost, value, pnl, pnlPct }
}

export function fmtStrike(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?'
  return String(Number(n.toFixed(4)))
}

/** `SYM 2026-11-20 150 C` */
export function optionLabel(r: Pick<RhOptionPosition, 'chain_symbol' | 'expiration_date' | 'strike_price' | 'option_type'>): string {
  const t = r.option_type === 'call' ? 'C' : r.option_type === 'put' ? 'P' : '?'
  return `${r.chain_symbol} ${r.expiration_date ?? '?'} ${fmtStrike(r.strike_price)} ${t}`
}

/** Calendar days from the local date of `now` to the expiration date (negative once expired); null for a bad date. */
export function dteOf(expiration: string | null, now: Date): number | null {
  const m = expiration ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiration) : null
  if (!m) return null
  const exp = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((exp - today) / 86_400_000)
}

/** Expiry, then strike, then symbol; rows with an unknown expiry or strike go last. Returns a new array. */
export function sortOptionPositions(rows: readonly RhOptionPosition[]): RhOptionPosition[] {
  const num = (n: number | null) => (n === null ? Number.POSITIVE_INFINITY : n)
  return [...rows].sort((a, b) => {
    const ea = a.expiration_date ?? '9999-99-99'
    const eb = b.expiration_date ?? '9999-99-99'
    if (ea !== eb) return ea < eb ? -1 : 1
    if (num(a.strike_price) !== num(b.strike_price)) return num(a.strike_price) < num(b.strike_price) ? -1 : 1
    return a.chain_symbol.localeCompare(b.chain_symbol)
  })
}
