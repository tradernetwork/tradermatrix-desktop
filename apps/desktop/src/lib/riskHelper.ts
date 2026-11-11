/**
 * Position-size helper view + risk draft builder (M18). INFORMATIONAL ONLY: `helperView` turns typed text into display rows and, when a
 * quantity exists, the text the "Use" button copies into the quantity field. It never sees a ticket, a phase or a validation result,
 * and nothing it returns can enable, disable, relabel or gate Review or Place. `draftFields` reads the ticket values that were
 * REVIEWED (plain data, passed in) and returns the draft to store, or null with a reason. It never guesses.
 */
import type { DraftFieldsIn, EquityOrderArgs, OptionOrderArgs } from './api'
import { fmtMoney } from './format'
import { perShareRisk, sizeEquity, sizeOption, type OptionBasis } from './riskSizing'

export const SETTING_BASIS = 'risk.helper.basis'
export const SETTING_MODE = 'risk.helper.mode'

export type HelperMode = 'pct' | 'usd'

/** Everything typed into the helper. All text (so half-typed numbers are legal); empty = not given. */
export interface HelperInputs {
  kind: 'equity' | 'option'
  /** The symbol (stock) or underlying (option) these numbers were typed for. A stop is never carried to another symbol. */
  symbol: string
  side: 'buy' | 'sell'
  mode: HelperMode
  riskPct: string
  riskUsd: string
  entry: string
  stop: string
  basis: OptionBasis
  width: string
  credit: string
  stopBuyback: string
  stopMult: string
  strike: string
  /** The user has typed or changed something (the host only mentions a skipped draft when the helper was used). */
  touched: boolean
}

export const DEFAULT_HELPER: HelperInputs = {
  kind: 'equity', symbol: '', side: 'buy', mode: 'pct', riskPct: '1', riskUsd: '', entry: '', stop: '', basis: 'spread_max_loss', width: '', credit: '', stopBuyback: '', stopMult: '', strike: '', touched: false,
}

export interface HelperCtx {
  /** Account value from the portfolio store; null = unavailable. */
  equity: number | null
  /** Entry price taken from the ticket (limit price or the touch), null when none. */
  entryHint: number | null
  /** Option limit price from the ticket, the default credit. */
  creditHint: number | null
  /** Smallest tradable step (1 whole shares). */
  increment: number
  defaultStopMult: number
}

export interface HelperRow {
  label: string
  value: string
}

export interface HelperView {
  rows: HelperRow[]
  /** Why there is no answer yet ("enter a stop", "equity unavailable", ...). */
  error: string | null
  /** Sizing worked but the answer is zero (option budget below one contract). */
  message: string | null
  /** Quantity text for the "Use" button, null when there is nothing safe to fill. */
  useQty: string | null
}

/** '' (or spaces) = not given (null); anything else goes through Number so NaN / Infinity survive to be refused by the lib. */
function parse(s: string): number | null {
  const t = typeof s === 'string' ? s.trim() : ''
  return t === '' ? null : Number(t)
}

function qtyText(n: number): string {
  return Number.parseFloat(n.toFixed(6)).toString()
}

/** Anything above this is a typo, not a size: no quantity is offered. */
const MAX_QTY = 1e9

const clean = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

export function helperView(i: HelperInputs, ctx: HelperCtx): HelperView {
  try {
    return i.kind === 'equity' ? equityView(i, ctx) : optionView(i, ctx)
  } catch {
    return { rows: [], error: 'These numbers could not be sized.', message: null, useQty: null }
  }
}

function equityView(i: HelperInputs, ctx: HelperCtx): HelperView {
  const equity = clean(ctx.equity)
  const rows: HelperRow[] = [{ label: 'Equity', value: equity === null ? 'equity unavailable' : fmtMoney(equity) }]
  const entry = parse(i.entry) ?? ctx.entryHint
  const side = i.side === 'sell' ? 'short' : 'long'
  const stop = parse(i.stop)
  const usd = i.mode === 'usd'
  const r = sizeEquity({
    equity,
    riskPct: usd ? null : parse(i.riskPct),
    riskUsd: usd ? (parse(i.riskUsd) ?? Number.NaN) : null,
    entry: entry ?? Number.NaN,
    stop,
    side,
    increment: ctx.increment,
  })
  if (r.error || r.qty <= 0 || r.qty > MAX_QTY) {
    rows.push({ label: '% of equity', value: '-' })
    return { rows, error: r.error ?? (r.qty > MAX_QTY ? 'That budget is too large to size.' : 'No quantity fits this risk.'), message: null, useQty: null }
  }
  rows.push(
    { label: 'Shares', value: qtyText(r.qty) },
    { label: 'Risk (1R)', value: fmtMoney(r.riskUsd) },
    { label: '% of equity', value: r.riskPctOfEquity === null ? '-' : `${r.riskPctOfEquity.toFixed(2)}%` },
    { label: 'Risk per share', value: fmtMoney(r.perShareRisk) },
  )
  if (r.remainderUsd > 0) rows.push({ label: 'Unused budget', value: fmtMoney(r.remainderUsd) })
  return { rows, error: null, message: null, useQty: qtyText(r.qty) }
}

function optionView(i: HelperInputs, ctx: HelperCtx): HelperView {
  const equity = clean(ctx.equity)
  const rows: HelperRow[] = []
  let budget: number
  if (i.mode === 'usd') {
    budget = parse(i.riskUsd) ?? Number.NaN
  } else {
    const pct = parse(i.riskPct)
    rows.push({ label: 'Equity', value: equity === null ? 'equity unavailable' : fmtMoney(equity) })
    if (equity === null) return { rows, error: 'Equity unavailable: type a dollar budget instead.', message: null, useQty: null }
    if (pct === null || !Number.isFinite(pct) || pct <= 0 || pct > 100) return { rows, error: 'Enter a risk percent above 0 and at most 100.', message: null, useQty: null }
    budget = (equity * pct) / 100
  }
  if (!Number.isFinite(budget) || budget <= 0) return { rows, error: 'Enter a dollar budget above zero.', message: null, useQty: null }
  const r = sizeOption({
    basis: i.basis,
    width: parse(i.width),
    credit: parse(i.credit) ?? ctx.creditHint,
    stopBuyback: parse(i.stopBuyback),
    stopMult: parse(i.stopMult) ?? ctx.defaultStopMult,
    strike: parse(i.strike),
    budgetUsd: budget,
  })
  if (r.error) return { rows, error: r.error, message: null, useQty: null }
  if (!(r.perContractRisk > 0) || r.contracts > MAX_QTY) return { rows, error: 'That risk per contract or budget cannot be sized.', message: null, useQty: null }
  rows.push({ label: 'Budget', value: fmtMoney(budget) }, { label: 'R per contract', value: fmtMoney(r.perContractRisk) })
  if (r.contracts < 1) return { rows, error: null, message: r.message ?? 'The budget does not cover one contract.', useQty: null }
  rows.push({ label: 'Contracts', value: String(r.contracts) }, { label: 'Total risk', value: fmtMoney(r.totalRisk) })
  rows.push({ label: 'Collateral', value: r.collateral === null ? '-' : fmtMoney(r.collateral) })
  return { rows, error: null, message: null, useQty: String(r.contracts) }
}

// ---- the draft (stored under the review id) ----

export type ReviewedTicket =
  | { kind: 'equity'; args: EquityOrderArgs }
  | { kind: 'option'; args: OptionOrderArgs; /** The underlying the contract belongs to, from the same render as the review. */ underlying: string }

export interface DraftOut {
  fields: DraftFieldsIn | null
  /** Why no draft was made (shown only when the helper was used). null when the helper was not used at all. */
  reason: string | null
}

const none = (reason: string | null): DraftOut => ({ fields: null, reason })

/** Masks an account number for storage: four bullets and the last four characters. */
function mask(a: string): string | null {
  const t = (a ?? '').trim()
  return t.length >= 4 ? `••••${t.slice(-4)}` : null
}

function positiveNum(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null
  const n = parse(s)
  return n !== null && Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Builds the draft from the REVIEWED ticket values (symbol, side, quantity, price) and the helper's stop / basis. The planned risk is
 * recomputed for the quantity actually reviewed. Returns no draft, with the reason, whenever anything does not line up: another symbol,
 * another side, dollar sizing, no stop, a stop on the wrong side. The result is only ever stored; it changes nothing about the order.
 */
export function draftFields(t: ReviewedTicket, h: HelperInputs | null, ctx: { entryHint: number | null; defaultStopMult: number }): DraftOut {
  if (!h || !h.touched) return none(null)
  return t.kind === 'equity' ? equityDraft(t.args, h, ctx) : optionDraft(t.args, t.underlying, h, ctx)
}

function equityDraft(a: EquityOrderArgs, h: HelperInputs, ctx: { entryHint: number | null }): DraftOut {
  if (h.kind !== 'equity') return none('The helper was set up for an option.')
  const symbol = (a.symbol ?? '').trim().toUpperCase()
  if (h.symbol.trim().toUpperCase() !== symbol) return none('The helper numbers were typed for another symbol.')
  if (a.side !== h.side) return none('The helper numbers were typed for the other side.')
  if (a.side !== 'buy' && a.side !== 'sell') return none('Unknown side.')
  const qty = positiveNum(a.quantity)
  if (qty === null) return none(a.dollar_amount ? 'The order is sized in dollars, so the share count is unknown.' : 'No quantity on the reviewed order.')
  const entry = positiveNum(a.limit_price) ?? positiveNum(h.entry) ?? clean(ctx.entryHint)
  if (entry === null) return none('No entry price to measure the stop from.')
  const stop = parse(h.stop)
  if (stop === null) return none('No stop price entered.')
  const ps = perShareRisk(entry, stop, a.side === 'buy' ? 'long' : 'short')
  if ('error' in ps) return none(ps.error)
  const planned = Math.round(ps.value * qty * 100) / 100
  const masked = mask(a.account_number)
  return {
    reason: null,
    fields: {
      side: a.side, ...(masked ? { account_masked: masked } : {}), symbol, instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: planned, qty, entry_price: entry, stop_price: stop, multiplier: 1,
    },
  }
}

function optionDraft(a: OptionOrderArgs, underlying: string, h: HelperInputs, ctx: { defaultStopMult: number }): DraftOut {
  if (h.kind !== 'option') return none('The helper was set up for a stock.')
  const symbol = underlying.trim().toUpperCase()
  if (h.symbol.trim().toUpperCase() !== symbol) return none('The helper numbers were typed for another underlying.')
  if (a.legs.length !== 1) return none('Only single-leg orders get a draft.')
  const leg = a.legs[0]!
  if (leg.position_effect !== 'open') return none('Closing orders do not get a draft.')
  if (leg.side !== 'sell') return none('R for a long option is set by hand in the Journal.')
  const contracts = positiveNum(a.quantity)
  if (contracts === null || !Number.isInteger(contracts)) return none('No whole contract count on the reviewed order.')
  const credit = positiveNum(a.price) ?? positiveNum(h.credit)
  if (credit === null) return none('No credit to measure the risk from.')
  const buyback = parse(h.stopBuyback)
  const r = sizeOption({
    basis: h.basis, width: parse(h.width), credit, stopBuyback: buyback, stopMult: parse(h.stopMult) ?? ctx.defaultStopMult, contracts,
  })
  if (r.error) return none(r.error)
  const masked = mask(a.account_number)
  const stop = h.basis === 'stop_mult' ? (buyback !== null && Number.isFinite(buyback) ? buyback : Math.round(credit * (parse(h.stopMult) ?? ctx.defaultStopMult) * 10000) / 10000) : null
  return {
    reason: null,
    fields: {
      side: 'sell', ...(masked ? { account_masked: masked } : {}), symbol, instrument: 'option', risk_basis: h.basis, planned_risk_usd: r.totalRisk, qty: contracts, entry_price: credit, ...(stop !== null ? { stop_price: stop } : {}), multiplier: 100,
    },
  }
}
