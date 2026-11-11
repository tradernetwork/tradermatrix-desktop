/**
 * The one equity-symbol rule for the whole UI (chart, ticket, watchlist writes, quote poller, watchlist rows):
 * `^[A-Z][A-Z0-9.\-]{0,9}$` after trim + uppercase. It matches the Rust core (rh/orders.rs, rh/watch_writes.rs).
 * Exception that stays separate on purpose: TraderMatrix accepts only `^[A-Z]{1,6}(\.[A-Z])?$` (stores/tm.ts).
 */
export const EQUITY_SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/

export function isEquityTicker(s: string): boolean {
  return EQUITY_SYMBOL.test(s)
}
