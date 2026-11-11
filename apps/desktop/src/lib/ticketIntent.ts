/**
 * Ticket intents: "fill the order ticket from here". An intent ONLY sets ticket fields. Nothing in this module
 * (or in the fill path) places, reviews or cancels anything; Review then Place stays the only way to send an order.
 * Pure helpers, no React and no store.
 */
import type { RhOptionPosition, RhOrder, RhPosition, RhQuote } from './api'
import { roundToTick, tickFor, orderTypeLabel } from './orderUi'

export type EquityOrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit'

export interface EquityIntent {
  kind: 'equity'
  symbol: string
  side?: 'buy' | 'sell'
  /** Shares as the ticket field text. Omitted: leave the field as it is (cleared when the symbol changes). */
  quantity?: string
  dollars?: string
  orderType?: EquityOrderType
  limit?: string
  stop?: string
  /** Where the fill came from (shown nowhere critical; for tests and debugging). */
  source: string
}

export interface OptionIntent {
  kind: 'option'
  underlying: string
  optionId: string
  side: 'buy' | 'sell'
  effect: 'open' | 'close'
  quantity: string
  limit?: string
  /** Needed to load the chain to the contract. */
  expiration?: string
  source: string
}

export type TicketIntent = EquityIntent | OptionIntent

const pos = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isFinite(n) && n > 0

/** A price as ticket text: 4 decimals below $1, else 2. */
export function priceText(n: number): string {
  return n < 1 ? n.toFixed(4) : n.toFixed(2)
}

/** Shares as ticket text: at most 6 decimals (the validation limit), trailing zeros trimmed. */
export function shareText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return String(Number(n.toFixed(6)))
}

const isWhole = (n: number) => Math.abs(n - Math.round(n)) < 1e-9

/** The touch for closing/adding: sell at the bid, buy at the ask; falls back to the last trade, else undefined. */
function touchPrice(side: 'buy' | 'sell', q: RhQuote | undefined): number | undefined {
  const t = side === 'sell' ? q?.bid_price : q?.ask_price
  if (pos(t)) return t
  return pos(q?.last_trade_price) ? q!.last_trade_price! : undefined
}

/**
 * Close an equity position. Long: sell (quantity = shares available for sells, falling back to the quantity; empty when
 * nothing is available). Short (negative quantity): buy to cover |quantity|. Default is a limit at the touch (sell at bid,
 * buy at ask); `market: true` asks for a market order. A fractional quantity can only be a market order (limit orders
 * take whole shares), so it falls back to market. Zero or unknown quantity: null (nothing to close).
 */
export function closeEquityIntent(position: RhPosition, quote: RhQuote | undefined, opts: { market?: boolean } = {}): EquityIntent | null {
  const q = position.quantity
  if (q === null || !Number.isFinite(q) || q === 0) return null
  const side: 'buy' | 'sell' = q > 0 ? 'sell' : 'buy'
  let qty: number
  if (q > 0) {
    const avail = position.shares_available_for_sells
    qty = avail === null || avail === undefined || !Number.isFinite(avail) ? q : Math.min(Math.max(avail, 0), q)
  } else {
    qty = Math.abs(q)
  }
  const out: EquityIntent = { kind: 'equity', symbol: position.symbol, side, quantity: shareText(qty), source: 'close' }
  const market = opts.market === true || (qty > 0 && !isWhole(qty))
  if (market) return { ...out, orderType: 'market' }
  const px = touchPrice(side, quote)
  return { ...out, orderType: 'limit', ...(px !== undefined ? { limit: priceText(px) } : {}) }
}

/** Add to a position: same side as the position (long: buy at the ask, short: sell at the bid), no quantity. */
export function addEquityIntent(position: RhPosition, quote: RhQuote | undefined): EquityIntent {
  const q = position.quantity
  const side: 'buy' | 'sell' = q !== null && q < 0 ? 'sell' : 'buy'
  const px = touchPrice(side, quote)
  return { kind: 'equity', symbol: position.symbol, side, orderType: 'limit', ...(px !== undefined ? { limit: priceText(px) } : {}), source: 'add' }
}

/** Mid of bid and ask rounded to the contract's tick; else the mark; else the side's touch (sell: bid, buy: ask); else undefined. */
export function optionClosePrice(row: Pick<RhOptionPosition, 'bid' | 'ask' | 'mark' | 'min_ticks'>, side: 'buy' | 'sell'): string | undefined {
  if (pos(row.bid) && pos(row.ask)) {
    const mid = (row.bid + row.ask) / 2
    return roundToTick(mid, tickFor(row.min_ticks, mid))
  }
  if (pos(row.mark)) return roundToTick(row.mark, tickFor(row.min_ticks, row.mark))
  const t = side === 'sell' ? row.bid : row.ask
  return pos(t) ? roundToTick(t, tickFor(row.min_ticks, t)) : undefined
}

/** Close an option position: long => sell to close, short => buy to close, all contracts, limit at the mid. */
export function closeOptionIntent(row: RhOptionPosition): OptionIntent | null {
  if (!row.option_id || !row.chain_symbol || !pos(row.quantity) || !row.expiration_date) return null
  const side: 'buy' | 'sell' = row.side === 'short' ? 'buy' : 'sell'
  const limit = optionClosePrice(row, side)
  return {
    kind: 'option', underlying: row.chain_symbol, optionId: row.option_id, side, effect: 'close',
    quantity: isWhole(row.quantity) ? String(Math.round(row.quantity)) : '', ...(limit !== undefined ? { limit } : {}),
    expiration: row.expiration_date, source: 'close',
  }
}

/**
 * Percent of a base quantity as ticket text. Whole shares unless `fractional`; never more than the base; 0 or a bad base
 * gives '' (leave the field empty). Fractions are floored to 6 decimals.
 */
export function qtyFromPercent(pct: number, base: number, fractional: boolean): string {
  if (!Number.isFinite(pct) || !Number.isFinite(base) || pct <= 0 || base <= 0) return ''
  const raw = (base * Math.min(pct, 100)) / 100
  const v = fractional ? Math.floor(raw * 1e6 + 1e-6) / 1e6 : Math.floor(raw + 1e-9)
  const n = Math.min(v, base)
  return n > 0 ? shareText(n) : ''
}

/** A dollar preset as ticket text ('' for a non-positive amount). */
export function dollarPreset(n: number): string {
  return Number.isFinite(n) && n > 0 ? String(Number(n.toFixed(2))) : ''
}

/**
 * Rebuild a ticket from an open order for "Cancel & edit". Equity: symbol, side, size, type and prices. Option: only a
 * single-leg order (its leg gives the contract). Anything else: null.
 */
export function intentFromOrder(o: RhOrder): TicketIntent | null {
  if (o.asset === 'equity') {
    if (!o.symbol || (o.side !== 'buy' && o.side !== 'sell')) return null
    const label = orderTypeLabel(o)
    const orderType = (['market', 'limit', 'stop_market', 'stop_limit'] as const).find((t) => t === label)
    const out: EquityIntent = { kind: 'equity', symbol: o.symbol, side: o.side, source: 'edit' }
    if (orderType) out.orderType = orderType
    if (pos(o.quantity)) out.quantity = shareText(o.quantity)
    else if (pos(o.dollar_based_amount)) out.dollars = dollarPreset(o.dollar_based_amount)
    if (pos(o.price)) out.limit = priceText(o.price)
    if (pos(o.stop_price)) out.stop = priceText(o.stop_price)
    return out
  }
  if (o.asset === 'option') {
    const leg = o.legs.length === 1 ? o.legs[0]! : null
    if (!leg?.option_id || !o.symbol || (leg.side !== 'buy' && leg.side !== 'sell')) return null
    if (leg.position_effect !== 'open' && leg.position_effect !== 'close') return null
    return {
      kind: 'option', underlying: o.symbol, optionId: leg.option_id, side: leg.side, effect: leg.position_effect,
      quantity: pos(o.quantity) && isWhole(o.quantity) ? String(Math.round(o.quantity)) : '',
      ...(pos(o.price) ? { limit: priceText(o.price) } : {}),
      ...(leg.expiration_date ? { expiration: leg.expiration_date } : {}), source: 'edit',
    }
  }
  return null
}
