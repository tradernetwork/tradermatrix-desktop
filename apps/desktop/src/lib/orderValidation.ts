/**
 * Instant UI feedback for order tickets. This mirrors the validation in src-tauri/src/rh/orders.rs rule for rule
 * (same case table in test/orderValidation.test.ts). Rust stays authoritative: it re-validates everything before
 * any request is made. Each validator returns the first problem as a message, or null when the order is valid.
 */
import type { EquityOrderArgs, OptionOrderArgs } from './api'
import { isEquityTicker } from './symbols'

type Opt = string | null | undefined

/** ^[0-9]+(\.[0-9]{1,8})?$ and strictly positive. No sign, exponent, spaces, NaN or inf. */
export function isDecimal(s: string): boolean {
  return /^[0-9]+(\.[0-9]{1,8})?$/.test(s) && /[1-9]/.test(s)
}

/** ^[A-Z][A-Z0-9.\-]{0,9}$ (the one rule, see lib/symbols.ts) */
export function isSymbol(s: string): boolean {
  return isEquityTicker(s)
}

export function isAccount(s: string): boolean {
  return /^[A-Za-z0-9]{1,64}$/.test(s)
}

/** 8-4-4-4-12 hex, either case, nothing else. */
export function isUuid(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)
}

function oneOf(name: string, v: Opt, allowed: readonly string[]): string | null {
  return v !== null && v !== undefined && !allowed.includes(v) ? `${name} must be one of ${allowed.join('|')}` : null
}

function decimal(name: string, v: Opt): string | null {
  return v !== null && v !== undefined && !isDecimal(v)
    ? `${name} must be a positive decimal like 12.5 (no sign, exponent or spaces; up to 8 decimals)`
    : null
}

const has = (v: Opt): v is string => v !== null && v !== undefined

export function validateEquity(a: EquityOrderArgs): string | null {
  if (!isAccount(a.account_number)) return 'account_number must be alphanumeric'
  if (has(a.quantity) && /\.[0-9]{7,}$/.test(a.quantity)) return 'quantity allows at most 6 decimals (dollar amounts allow 8)'
  if (!isSymbol(a.symbol)) return "symbol must be upper case letters, digits, '.' or '-' (max 10), starting with a letter"
  if (!['buy', 'sell'].includes(a.side)) return 'side must be buy or sell'
  const ty = a.type
  if (!['market', 'limit', 'stop_market', 'stop_limit'].includes(ty)) return 'type must be market, limit, stop_market or stop_limit'
  const early =
    oneOf('time_in_force', a.time_in_force, ['gfd', 'gtc']) ??
    oneOf('market_hours', a.market_hours, ['regular_hours', 'extended_hours', 'all_day_hours']) ??
    decimal('quantity', a.quantity) ??
    decimal('dollar_amount', a.dollar_amount) ??
    decimal('limit_price', a.limit_price) ??
    decimal('stop_price', a.stop_price)
  if (early) return early
  const regular = !has(a.market_hours) || a.market_hours === 'regular_hours'
  const q = has(a.quantity)
  const d = has(a.dollar_amount)
  if (q && d) return 'give either quantity or dollar_amount, not both'
  if (!q && !d) return 'give quantity or dollar_amount'
  if (!q && d) {
    if (ty !== 'market' || !regular) return 'dollar_amount is only valid for a market order in regular hours'
  } else if (a.quantity!.includes('.') && (ty !== 'market' || !regular)) {
    return 'fractional quantity is only valid for a market order in regular hours'
  }
  const needsLimit = ty === 'limit' || ty === 'stop_limit'
  const needsStop = ty === 'stop_market' || ty === 'stop_limit'
  if (needsLimit !== has(a.limit_price))
    return needsLimit ? 'limit_price is required for limit and stop_limit orders' : 'limit_price is only valid for limit and stop_limit orders'
  if (needsStop !== has(a.stop_price))
    return needsStop ? 'stop_price is required for stop_market and stop_limit orders' : 'stop_price is only valid for stop_market and stop_limit orders'
  if (ty !== 'limit' && !regular) return 'market and stop orders are regular hours only; use a limit order for extended or all-day sessions'
  return null
}

export function validateOption(a: OptionOrderArgs): string | null {
  if (!isAccount(a.account_number)) return 'account_number must be alphanumeric'
  if (a.legs.length === 0 || a.legs.length > 4) return 'an option order needs 1 to 4 legs'
  const seen: string[] = []
  for (const l of a.legs) {
    if (!isUuid(l.option_id)) return 'option_id must be an option instrument UUID'
    const id = l.option_id.toLowerCase()
    if (seen.includes(id)) return 'each leg must be a different contract'
    seen.push(id)
    if (!['buy', 'sell'].includes(l.side)) return 'leg side must be buy or sell'
    if (!['open', 'close'].includes(l.position_effect)) return 'leg position_effect must be open or close'
    // Rust: u32, at least 1.
    if (!Number.isInteger(l.ratio_quantity) || l.ratio_quantity < 1 || l.ratio_quantity > 4294967295) return 'leg ratio_quantity must be at least 1'
  }
  if (!isDecimal(a.quantity) || a.quantity.includes('.')) return 'quantity must be a positive whole number of contracts'
  const ty = a.type ?? 'limit'
  if (!['limit', 'market', 'stop_limit', 'stop_market'].includes(ty)) return 'type must be limit, market, stop_limit or stop_market'
  if (a.legs.length > 1 && ty !== 'limit') return 'multi-leg orders support limit only'
  const early =
    oneOf('time_in_force', a.time_in_force, ['gfd', 'gtc']) ??
    oneOf('market_hours', a.market_hours, ['regular_hours', 'regular_curb_hours', 'regular_curb_overnight_hours']) ??
    oneOf('direction', a.direction, ['debit', 'credit']) ??
    decimal('price', a.price) ??
    decimal('stop_price', a.stop_price)
  if (early) return early
  if (ty === 'market' && (a.time_in_force ?? 'gfd') !== 'gfd') return 'market option orders must be gfd'
  if (ty !== 'limit' && has(a.market_hours) && a.market_hours !== 'regular_hours') return 'only limit option orders can use an extended or curb session'
  const needsPrice = ty === 'limit' || ty === 'stop_limit'
  const needsStop = ty === 'stop_limit' || ty === 'stop_market'
  if (needsPrice !== has(a.price))
    return needsPrice ? 'price is required for limit and stop_limit orders' : 'price must be omitted for market and stop_market orders'
  if (needsStop !== has(a.stop_price))
    return needsStop ? 'stop_price is required for stop_limit and stop_market orders' : 'stop_price must be omitted for limit and market orders'
  if (a.legs.length >= 2) {
    if (!has(a.direction)) return 'direction (debit or credit) is required for multi-leg orders'
  } else if (has(a.direction)) {
    const want = a.legs[0]!.side === 'buy' ? 'debit' : 'credit'
    if (a.direction !== want) return `direction ${a.direction} contradicts a single ${a.legs[0]!.side} leg`
  }
  return null
}
