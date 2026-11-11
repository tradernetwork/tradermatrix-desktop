/** Pure helpers for the order ticket conveniences (M10): position line, price steps, size warnings, estimate, remembered settings. */
import type { RhAccount, RhOptionPosition, RhOptionRow, RhPosition } from './api'
import { fmtMoney, fmtPrice, fmtQty, positionRow } from './format'
import { optionPnl } from './optionPositions'
import { ticketAccountProblem, ticketDisabledReason } from './orderUi'

export function fmtSignedMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  const s = fmtMoney(n)
  return n > 0 && s !== '$0.00' ? `+${s}` : s
}

/** `Long 40 @ 12.34, P&L +$55.20` / `Short 10 @ 5.00, P&L -$3.00` / `No position`. P&L is left out when the last price or the average is unknown. */
export function positionLine(p: RhPosition | undefined, last: number | null): string {
  const q = p?.quantity
  if (!p || q === null || q === undefined || !Number.isFinite(q) || q === 0) return 'No position'
  const r = positionRow(p, last)
  const base = `${q > 0 ? 'Long' : 'Short'} ${fmtQty(Math.abs(q))} @ ${fmtPrice(p.average_buy_price)}`
  return r.pnl === null ? base : `${base}, P&L ${fmtSignedMoney(r.pnl)}`
}

/** The same line for an option contract position (per-share average, P&L per the units rule in optionPositions.ts). */
export function optionPositionLine(p: RhOptionPosition | undefined): string {
  if (!p || !(p.quantity > 0)) return 'No position'
  const v = optionPnl(p)
  const base = `${p.side === 'short' ? 'Short' : 'Long'} ${fmtQty(p.quantity)} @ ${fmtPrice(v.avgPerShare)}`
  return v.pnl === null ? base : `${base}, P&L ${fmtSignedMoney(v.pnl)}`
}

/**
 * One price step (+1 / -1) of `tick`, as ticket text. Empty or unparseable input is returned unchanged; a step that
 * would reach zero or below is refused (returns the input). Integer arithmetic on 1e-4 units keeps 3.05 clean.
 */
export function stepPrice(current: string, dir: 1 | -1, tick: number): string {
  const t = current.trim()
  if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(t)) return current
  const unit = 10_000
  const step = Math.max(1, Math.round(tick * unit))
  const cur = Math.round(Number(t) * unit)
  const next = cur + dir * step
  if (next <= 0) return current
  const text = (next / unit).toFixed(4).replace(/0+$/, '')
  const [i, f = ''] = text.split('.')
  return `${i}.${f.padEnd(2, '0')}`
}

/**
 * Sell-side size check. Returns a reason to block Review, or null. Only a KNOWN position can block: a sell larger than
 * `shares_available_for_sells` (or, when that is unknown, the quantity held) is refused. No position at all is not blocked
 * here (see `noPositionNote`).
 */
export function sellQtyProblem(side: 'buy' | 'sell', quantity: string, p: RhPosition | undefined): string | null {
  if (side !== 'sell' || !p) return null
  const q = Number(quantity)
  if (!Number.isFinite(q) || q <= 0 || quantity.trim() === '') return null
  const held = p.quantity
  const avail = p.shares_available_for_sells ?? (held !== null && held > 0 ? held : null)
  if (avail === null) return null
  if (q > avail + 1e-9) {
    const locked = p.shares_held_for_sells
    return `You are selling ${fmtQty(q)} but only ${fmtQty(avail)} ${avail === 1 ? 'share is' : 'shares are'} available to sell${locked ? ` (${fmtQty(locked)} held by open sell orders)` : ''}.`
  }
  return null
}

/** A soft note (not a block): selling a symbol with no open position in this account would open a short. */
export function noPositionNote(side: 'buy' | 'sell', p: RhPosition | undefined, positionsLoaded: boolean): string | null {
  if (side === 'sell' && positionsLoaded && !p) return 'No open position in this symbol: a sell would be a short sale.'
  return null
}

export interface EstimateInput {
  side: 'buy' | 'sell'
  /** shares (or contracts) text */
  quantity: string
  /** dollar-sized order: the amount IS the estimate */
  dollars?: string
  /** limit price text when the order has one */
  limit?: string
  bid: number | null | undefined
  ask: number | null | undefined
  last: number | null | undefined
  buyingPower: number | null | undefined
  /** 100 for options (premium is per share), 1 for stock */
  multiplier?: number
}

const posNum = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isFinite(n) && n > 0

/** `est. cost $1,234.00 | buying power $2,000.00` (buy) or `est. proceeds ...` (sell); null when there is nothing to say. */
export function estimateLine(i: EstimateInput): string | null {
  const mult = i.multiplier ?? 1
  const limit = i.limit !== undefined && i.limit.trim() !== '' ? Number(i.limit) : NaN
  const px = posNum(limit) ? limit : i.side === 'buy' ? (posNum(i.ask) ? i.ask : i.last) : posNum(i.bid) ? i.bid : i.last
  const qty = Number(i.quantity)
  let amount: number | null = null
  if (i.dollars !== undefined && i.dollars.trim() !== '' && Number(i.dollars) > 0) amount = Number(i.dollars)
  else if (i.quantity.trim() !== '' && posNum(qty) && posNum(px)) amount = qty * px * mult
  const parts: string[] = []
  if (amount !== null) {
    parts.push(`est. ${i.side === 'buy' ? 'cost' : 'proceeds'} ${fmtMoney(amount)}`)
  }
  if (posNum(i.buyingPower)) parts.push(`buying power ${fmtMoney(i.buyingPower)}`)
  if (parts.length === 0) return null
  const over = i.side === 'buy' && amount !== null && posNum(i.buyingPower) && amount > i.buyingPower
  return parts.join(' | ') + (over ? ' (over buying power)' : '')
}

/** Why a fill button is disabled (null = enabled). A fill only sets ticket fields, but the ticket must be usable. */
export function fillDisabledReason(connected: boolean, accounts: RhAccount[], account: string | null): string | null {
  return ticketDisabledReason(connected, accounts) ?? ticketAccountProblem(accounts, account)
}

// ---- remembered ticket settings (validated on load: a stored value outside the allowed set is ignored) ----
export const TIF_VALUES = ['gfd', 'gtc'] as const
export const SESSION_VALUES = ['regular_hours', 'extended_hours', 'all_day_hours'] as const
export type Tif = (typeof TIF_VALUES)[number]
export type Session = (typeof SESSION_VALUES)[number]
export const SETTING_TIF = 'ticket.tif'
export const SETTING_SESSION = 'ticket.session'
export const SETTING_OPT_TIF = 'ticket.opt_tif'

export function parseTif(v: string | null | undefined): Tif | null {
  return (TIF_VALUES as readonly string[]).includes(v ?? '') ? (v as Tif) : null
}
export function parseSession(v: string | null | undefined): Session | null {
  return (SESSION_VALUES as readonly string[]).includes(v ?? '') ? (v as Session) : null
}

/**
 * Where a position's contract sits in the loaded chain rows, matched by instrument id (never by strike alone, so a
 * different chain's contract can never be picked by mistake). null when it is not in the rows.
 */
export function locateContract(rows: RhOptionRow[], optionId: string): { chainId: string; type: 'call' | 'put'; strike: number } | null {
  const id = optionId.toLowerCase()
  const r = rows.find((x) => x.instrument.id.toLowerCase() === id)
  const t = r?.instrument.option_type
  const k = r?.instrument.strike_price
  if (!r || (t !== 'call' && t !== 'put') || k === null || k === undefined) return null
  return { chainId: r.instrument.chain_id, type: t, strike: k }
}

/** Option chips: bid, ask and mid (mark when there is no two-sided market) of a contract's quote, as price text. */
export function optionChips(q: RhOptionRow['quote'] | undefined): { bid?: number; ask?: number; mid?: number } {
  if (!q) return {}
  const out: { bid?: number; ask?: number; mid?: number } = {}
  if (posNum(q.bid)) out.bid = q.bid
  if (posNum(q.ask)) out.ask = q.ask
  if (out.bid !== undefined && out.ask !== undefined) out.mid = (out.bid + out.ask) / 2
  else if (posNum(q.mark)) out.mid = q.mark
  return out
}

