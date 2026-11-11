/**
 * Pure position-size helpers (M18). Formulas only, derived from first principles:
 *   shares = floor(risk budget / per-share risk), per-share risk = |entry - stop|.
 * INFORMATIONAL ONLY. Nothing here knows about Review or Place and nothing may gate, cap or change an order: the caller shows
 * the numbers and a "Use" button fills a field, that is all. Errors come back as text with a quantity of 0, never as a throw.
 */

export interface SizeEquityIn {
  /** Account equity in dollars. Needed only for `riskPct`. */
  equity?: number | null
  /** Percent of equity to risk (0 < p <= 100). Ignored when `riskUsd` is given. */
  riskPct?: number | null
  /** Flat dollars to risk. Wins over `riskPct`. */
  riskUsd?: number | null
  entry: number
  stop?: number | null
  /** Direction of the position being opened: a long stop sits below entry, a short stop above. */
  side: 'long' | 'short'
  /** Smallest tradable step: 1 for whole shares, 0.001 and friends for fractional. */
  increment?: number | null
}

export interface SizeEquityOut {
  qty: number
  /** Dollars actually at risk for `qty` (qty x per-share risk). */
  riskUsd: number
  /** The budget that was asked for (flat dollars, or percent x equity). */
  budgetUsd: number
  /** Budget left over because the quantity is rounded down to the increment. */
  remainderUsd: number
  perShareRisk: number
  /** Actual risk as a percent of equity, null when equity is unknown. */
  riskPctOfEquity: number | null
  error?: string
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const cents = (n: number): number => Math.round(n * 100) / 100
const money = (n: number): string => `$${cents(n).toFixed(2)}`

function fail(error: string, extra: Partial<SizeEquityOut> = {}): SizeEquityOut {
  return { qty: 0, riskUsd: 0, budgetUsd: 0, remainderUsd: 0, perShareRisk: 0, riskPctOfEquity: null, ...extra, error }
}

/** Rounds away binary noise (0.1 + 0.2 style) without changing any value a person would type. */
function tidy(n: number): number {
  return Number.parseFloat(n.toPrecision(12))
}

/** Decimal places of an increment (1 -> 0, 0.001 -> 3), used to print a clean quantity. */
function places(inc: number): number {
  let p = 0
  let v = inc
  while (p < 8 && Math.abs(v - Math.round(v)) > 1e-9) {
    v *= 10
    p += 1
  }
  return p
}

/** Risk per share for a position opened at `entry` with a protective `stop`: the stop must sit on the losing side of the entry. */
export function perShareRisk(entry: number, stop: number, side: 'long' | 'short'): { value: number } | { error: string } {
  if (!fin(entry) || entry <= 0) return { error: 'Enter a valid entry price.' }
  if (!fin(stop)) return { error: 'Enter a stop price to size the position.' }
  if (stop <= 0) return { error: 'The stop must be above zero.' }
  if (side === 'long' && stop >= entry) return { error: 'A long stop must be below the entry price.' }
  if (side === 'short' && stop <= entry) return { error: 'A short stop must be above the entry price.' }
  const v = tidy(Math.abs(entry - stop))
  return v > 0 ? { value: v } : { error: 'Risk per share is zero.' }
}

export function sizeEquity(i: SizeEquityIn): SizeEquityOut {
  const inc = fin(i.increment) && i.increment > 0 ? i.increment : 1
  if (i.stop === undefined || i.stop === null) {
    return fail(!fin(i.entry) || i.entry <= 0 ? 'Enter a valid entry price.' : 'Enter a stop price to size the position.')
  }
  const ps = perShareRisk(i.entry, i.stop, i.side)
  if ('error' in ps) return fail(ps.error)
  const perShare = ps.value

  const equity = fin(i.equity) && i.equity > 0 ? i.equity : null
  let budget: number
  if (i.riskUsd !== undefined && i.riskUsd !== null) {
    if (!fin(i.riskUsd) || i.riskUsd <= 0) return fail('Risk in dollars must be above zero.', { perShareRisk: perShare })
    budget = i.riskUsd
  } else {
    if (!fin(i.riskPct) || i.riskPct <= 0 || i.riskPct > 100) return fail('Enter a risk percent above 0 and at most 100.', { perShareRisk: perShare })
    if (equity === null) return fail('Equity unavailable: type a dollar risk instead.', { perShareRisk: perShare })
    budget = tidy((equity * i.riskPct) / 100)
  }

  const steps = Math.floor(budget / perShare / inc + 1e-9)
  const qty = Number.parseFloat((steps * inc).toFixed(places(inc)))
  const base = { budgetUsd: budget, perShareRisk: perShare }
  if (!(qty > 0)) {
    return fail(`One step of ${inc} share risks ${money(perShare * inc)}, over your ${money(budget)} budget.`, base)
  }
  const risk = tidy(qty * perShare)
  return {
    qty,
    riskUsd: risk,
    ...base,
    remainderUsd: Math.max(0, tidy(budget - risk)),
    riskPctOfEquity: equity === null ? null : tidy((risk / equity) * 100),
  }
}

// ---- options ----

export type OptionBasis = 'spread_max_loss' | 'stop_mult'

export interface SizeOptionIn {
  /** `spread_max_loss`: 1R = (width - credit) x 100. `stop_mult`: 1R = (stop buyback - credit) x 100. Never full assignment risk. */
  basis: OptionBasis
  width?: number | null
  /** Credit received, per share (a $1.20 credit is 1.2). */
  credit?: number | null
  stopBuyback?: number | null
  /** Used when no `stopBuyback` is typed: buyback = credit x stopMult (default 2 lives in settings). */
  stopMult?: number | null
  /** Short strike, only for the collateral readout. Never guessed. */
  strike?: number | null
  contracts?: number | null
  /** When present, contracts = floor(budget / per-contract risk). */
  budgetUsd?: number | null
}

export interface SizeOptionOut {
  /** Dollars of 1R for ONE contract. */
  perContractRisk: number
  contracts: number
  totalRisk: number
  /** Gross collateral for one contract (spread: width x 100 before the credit; short: strike x 100). null when it cannot be known. Shown beside R, never used as R. */
  collateralPerContract: number | null
  collateral: number | null
  /** Set when sizing worked but the answer is zero contracts. */
  message?: string
  error?: string
}

function ofail(error: string): SizeOptionOut {
  return { perContractRisk: 0, contracts: 0, totalRisk: 0, collateralPerContract: null, collateral: null, error }
}

const MULT = 100

export function sizeOption(i: SizeOptionIn): SizeOptionOut {
  if (!fin(i.credit) || i.credit <= 0) return ofail('Enter the credit received (above zero).')
  let perShare: number
  let collateralPer: number | null
  if (i.basis === 'spread_max_loss') {
    if (!fin(i.width) || i.width <= 0) return ofail('Enter the spread width (above zero).')
    if (i.credit >= i.width) return ofail('The credit must be less than the spread width.')
    perShare = tidy(i.width - i.credit)
    collateralPer = cents(i.width * MULT)
  } else {
    let buyback: number
    if (fin(i.stopBuyback)) {
      buyback = i.stopBuyback
    } else if (fin(i.stopMult)) {
      if (i.stopMult <= 1) return ofail('The stop multiple must be above 1 (a 2x stop buys back at twice the credit).')
      buyback = tidy(i.credit * i.stopMult)
    } else {
      return ofail('Enter a stop buyback price.')
    }
    if (buyback <= i.credit) return ofail('The stop buyback must be above the credit received.')
    perShare = tidy(buyback - i.credit)
    collateralPer = fin(i.strike) && i.strike > 0 ? cents(i.strike * MULT) : null
  }
  const per = cents(perShare * MULT)
  let contracts: number
  let message: string | undefined
  if (i.budgetUsd !== undefined && i.budgetUsd !== null) {
    if (!fin(i.budgetUsd) || i.budgetUsd <= 0) return ofail('The budget must be above zero.')
    contracts = Math.floor(i.budgetUsd / per + 1e-9)
    if (contracts === 0) message = `1 contract exceeds your budget by ${money(per - i.budgetUsd)}`
  } else {
    contracts = fin(i.contracts) && i.contracts >= 1 ? Math.floor(i.contracts) : 1
  }
  return {
    perContractRisk: per,
    contracts,
    totalRisk: cents(per * contracts),
    collateralPerContract: collateralPer,
    collateral: collateralPer === null ? null : cents(collateralPer * contracts),
    ...(message ? { message } : {}),
  }
}
