/** Pure helpers for the order ticket, review panel, Orders pane actions and approvals list. No React, no store. */
import type {
  EquityOrderArgs,
  MinTicks,
  OptionOrderArgs,
  PlaceOutcome,
  ReviewOut,
  RhAccount,
  RhApproval,
  RhOptionRow,
  RhOrder,
} from './api'
import { fmtNum, fmtPrice, maskAccount, type Pill } from './format'

// ---- approval banner, alerts, buttons ----

export interface Banner {
  tone: 'amber' | 'green' | 'grey'
  text: string
}

export function approvalBanner(r: Pick<ReviewOut, 'customer_approval_required' | 'customer_approval_reason'>): Banner {
  if (r.customer_approval_required === true) {
    const reason = r.customer_approval_reason?.trim()
    return { tone: 'amber', text: `Needs your approval in the Robinhood app${reason ? ` (${reason})` : ''}` }
  }
  if (r.customer_approval_required === false) return { tone: 'green', text: 'Will execute as soon as it is placed' }
  return { tone: 'grey', text: 'Approval requirement unknown' }
}

export function hasOrderChecks(oc: unknown): boolean {
  return typeof oc === 'object' && oc !== null && Object.keys(oc).length > 0
}

const DETAILS_KEY = /(_alert_details|AlertDetails)$|^details$/

/**
 * Readable lines for the red alert box, verbatim from the server: `alert_type` / `alertType`, every nested `message`,
 * and every string leaf of the `*_alert_details` / `details` objects (shown as `key: value`, nested keys joined with a
 * space; a plain `message` is shown alone). Compact JSON when nothing readable is found. De-duplicated.
 */
export function orderCheckMessages(oc: unknown): string[] {
  if (!hasOrderChecks(oc)) return []
  const out: string[] = []
  const push = (s: string) => {
    if (s.trim() !== '' && !out.includes(s)) out.push(s)
  }
  const leaves = (v: unknown, path: string[]) => {
    if (typeof v === 'string') {
      const last = path[path.length - 1]
      push(last === undefined || last === 'message' ? v : `${path.join(' ')}: ${v}`)
    } else if (typeof v === 'object' && v !== null) for (const [k, x] of Object.entries(v)) leaves(x, [...path, k])
  }
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'string' && (key === 'alert_type' || key === 'alertType' || key === 'message')) push(v)
    else if (typeof v === 'object' && v !== null) {
      if (DETAILS_KEY.test(key)) leaves(v, [])
      else for (const [k, x] of Object.entries(v)) walk(x, k)
    }
  }
  walk(oc, '')
  return out.length ? out : [JSON.stringify(oc)]
}

export function placeLabel(hasChecks: boolean, placing: boolean): string {
  if (placing) return 'Placing...'
  return hasChecks ? 'Place anyway' : 'Place order'
}

// ---- result cards ----

export interface ResultCard {
  tone: 'green' | 'amber' | 'red'
  title: string
  body: string
  /** Buttons the card offers. Awaiting approval never offers a resubmit. */
  actions: Array<'decline' | 'retry' | 'refresh'>
  /** The Retry button is shown but disabled (the retry window has passed). */
  retryDisabled?: boolean
}

/** A placed order can come back already dead: these states mean Robinhood did not accept it. */
export const NOT_ACCEPTED_STATES = ['rejected', 'failed', 'voided', 'cancelled', 'canceled'] as const

/** True once `retry_until` (unix seconds, from the Rust core) has passed. Lenient: a missing value never expires. */
export function retryExpired(o: PlaceOutcome | null, nowMs: number): boolean {
  if (o?.kind !== 'unknown') return false
  const until = o.retry_until
  return typeof until === 'number' && Number.isFinite(until) && nowMs > until * 1000
}

function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function shortId(id: unknown): string {
  return typeof id === 'string' && id ? id.slice(0, 8) : '-'
}

export function approvalIdOf(o: PlaceOutcome | null): string | null {
  if (o?.kind !== 'awaiting_approval') return null
  const id = o.approval.approval_id
  return typeof id === 'string' && id ? id : null
}

export function resultCard(o: PlaceOutcome, ctx: { now?: number; since?: number | null } = {}): ResultCard {
  switch (o.kind) {
    case 'placed': {
      const state = typeof o.order.state === 'string' ? o.order.state : 'unknown state'
      if ((NOT_ACCEPTED_STATES as readonly string[]).includes(state.toLowerCase())) {
        const why = typeof o.order.reject_reason === 'string' && o.order.reject_reason ? ` ${o.order.reject_reason}` : ''
        return { tone: 'red', title: `Order was not accepted: ${state}`, body: `id ${shortId(o.order.id)}.${why} Check Orders.`, actions: [] }
      }
      return { tone: 'green', title: 'Placed', body: `State ${state}, id ${shortId(o.order.id)}`, actions: [] }
    }
    case 'awaiting_approval':
      return {
        tone: 'amber',
        title: 'Waiting for your approval (not placed yet)',
        body: 'Open the Robinhood app to approve or decline. Nothing has been placed.',
        actions: ['decline'],
      }
    case 'rejected':
      return { tone: 'red', title: 'Rejected, order NOT placed', body: o.message, actions: [] }
    case 'unknown': {
      const now = ctx.now ?? Date.now()
      const dead = retryExpired(o, now)
      const age = typeof ctx.since === 'number' ? ` Unconfirmed for ${ageText(now - ctx.since)}.` : ''
      const until =
        typeof o.retry_until === 'number' && !dead
          ? ` Retry allowed until ${new Date(o.retry_until * 1000).toLocaleTimeString('en-US', { timeStyle: 'medium' })}.`
          : ''
      const tail = dead ? ' The retry window has passed: check Orders, then review again.' : ''
      return {
        tone: 'amber',
        title: 'Result unknown',
        body: `Could not confirm. Check Orders before retrying. ${o.message}${age}${until}${tail}`.replace(/\s+/g, ' ').trim(),
        actions: ['retry', 'refresh'],
        retryDisabled: dead,
      }
    }
  }
}

// ---- accounts ----

export function agenticAccounts(accounts: RhAccount[]): RhAccount[] {
  return accounts.filter((a) => a.agentic_allowed)
}

export function ticketDisabledReason(connected: boolean, accounts: RhAccount[]): string | null {
  if (!connected) return 'Connect Robinhood to place orders.'
  if (agenticAccounts(accounts).length === 0)
    return 'No agentic account: orders can only be placed on an account with agentic_allowed. Enable agent trading for an account in the Robinhood app.'
  return null
}

/** Replaces every known full account number with its masked form. */
export function maskKnown(text: string, accountNumbers: string[]): string {
  let t = text
  for (const n of [...accountNumbers].sort((a, b) => b.length - a.length)) if (n) t = t.split(n).join(maskAccount(n))
  return t
}

export function approvalPill(humanMustApprove: boolean | null | undefined): Pill {
  if (humanMustApprove === true) return { text: 'approvals: ON', cls: 'ok', title: 'Trades on this account need your approval in the Robinhood app' }
  if (humanMustApprove === false) return { text: 'approvals: OFF', cls: 'warn', title: 'Agent trades on this account execute without approval (some may still need it)' }
  return { text: 'approvals: ?', cls: 'warn', title: 'Approval setting not read yet' }
}

// ---- ticket -> typed args ----

export interface EquityForm {
  account: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop_market' | 'stop_limit'
  sizeMode: 'quantity' | 'dollars'
  quantity: string
  dollars: string
  limit: string
  stop: string
  tif: 'gfd' | 'gtc'
  session: 'regular_hours' | 'extended_hours' | 'all_day_hours'
}

/** Keeps only the fields the order type uses, so validation judges the order that would actually be sent. */
export function buildEquityArgs(f: EquityForm): EquityOrderArgs {
  const a: EquityOrderArgs = {
    account_number: f.account.trim(),
    symbol: f.symbol.trim().toUpperCase(),
    side: f.side,
    type: f.type,
    time_in_force: f.tif,
    market_hours: f.session,
  }
  if (f.sizeMode === 'dollars') a.dollar_amount = f.dollars.trim()
  else a.quantity = f.quantity.trim()
  if (f.type === 'limit' || f.type === 'stop_limit') a.limit_price = f.limit.trim()
  if (f.type === 'stop_market' || f.type === 'stop_limit') a.stop_price = f.stop.trim()
  return a
}

export interface OptionForm {
  account: string
  optionId: string
  side: 'buy' | 'sell'
  effect: 'open' | 'close'
  quantity: string
  price: string
  tif: 'gfd' | 'gtc'
}

/** One leg, limit. `direction` is omitted: the server derives it for a single leg. */
export function buildOptionArgs(f: OptionForm): OptionOrderArgs {
  return {
    account_number: f.account.trim(),
    legs: [{ option_id: f.optionId.trim(), side: f.side, position_effect: f.effect, ratio_quantity: 1 }],
    quantity: f.quantity.trim(),
    type: 'limit',
    price: f.price.trim(),
    time_in_force: f.tif,
    market_hours: 'regular_hours',
  }
}

// ---- option chain helpers ----

/** Chains present in the loaded rows (index and adjusted underlyings can carry several), in order of appearance. */
export function chainsOf(rows: RhOptionRow[]): { id: string; symbol: string }[] {
  const out: { id: string; symbol: string }[] = []
  for (const r of rows) {
    const id = r.instrument.chain_id
    if (id && !out.some((c) => c.id === id)) out.push({ id, symbol: r.instrument.chain_symbol || id.slice(0, 8) })
  }
  return out
}

/** Rows of ONE chain, so a strike can never silently resolve to a contract of another chain. A single-chain list is returned as is. */
export function rowsForChain(rows: RhOptionRow[], chainId: string): RhOptionRow[] {
  return chainsOf(rows).length > 1 ? rows.filter((r) => r.instrument.chain_id === chainId) : rows
}

/** Which chain the picker shows: the user's pick if present, else the primary chain, else the first chain ('' when none). */
export function pickChain(chains: { id: string }[], wanted: string, primaryId: string): string {
  if (chains.some((c) => c.id === wanted)) return wanted
  if (chains.some((c) => c.id === primaryId)) return primaryId
  return chains[0]?.id ?? ''
}

export function optionStrikes(rows: RhOptionRow[], type: string): number[] {
  const s = new Set<number>()
  for (const r of rows) if (r.instrument.option_type === type && r.instrument.strike_price !== null) s.add(r.instrument.strike_price)
  return [...s].sort((a, b) => a - b)
}

export function findContract(rows: RhOptionRow[], type: string, strike: number): RhOptionRow | undefined {
  return rows.find((r) => r.instrument.option_type === type && r.instrument.strike_price === strike)
}

const numOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Tick for a price from the chain's min_ticks: below_tick under cutoff_price, above_tick at or over it; 0.01 when unknown. */
export function tickFor(mt: MinTicks | null | undefined, price: number): number {
  const above = numOf(mt?.above_tick)
  const below = numOf(mt?.below_tick)
  const cutoff = numOf(mt?.cutoff_price)
  if (cutoff !== null) return (price >= cutoff ? above : below) ?? above ?? below ?? 0.01
  return above ?? below ?? 0.01
}

/** Rounds to the nearest tick; integer arithmetic on 1e-4 units keeps 3.05 from printing as 3.0500000001. */
export function roundToTick(price: number, tick: number): string {
  const unit = 10_000
  const t = Math.max(1, Math.round(tick * unit))
  const p = Math.round(price * unit)
  const ticks = Math.floor(p / t + 0.5)
  return ((ticks * t) / unit).toFixed(2)
}

/** Mid of bid and ask, else mark, else null, rounded to the chain's tick (0.01 when the chain says nothing). */
export function midPrice(r: RhOptionRow | undefined, minTicks?: MinTicks | null): string | null {
  const q = r?.quote
  if (!q) return null
  const ok = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0
  const raw = ok(q.bid) && ok(q.ask) ? (q.bid + q.ask) / 2 : ok(q.mark) ? q.mark : null
  if (raw === null) return null
  return roundToTick(raw, tickFor(minTicks, raw))
}

/**
 * Option price field after a strike/contract change: the auto-filled mid replaces the field only when it is empty or
 * still equals the previous auto-filled mid. A hand-typed price is never overwritten.
 */
export function nextOptionPrice(a: { current: string; lastAuto: string | null; mid: string | null }): { price: string; auto: string | null } {
  if (a.mid === null) return { price: a.current, auto: a.lastAuto }
  if (a.current === '' || a.current === a.lastAuto) return { price: a.mid, auto: a.mid }
  return { price: a.current, auto: a.lastAuto }
}

/** `AAPL 2026-11-20 150 call` for a contract in the loaded rows; null when the contract is not there. */
export function optionLegLabel(rows: RhOptionRow[], optionId: string, chainSymbol: string): string | null {
  const id = optionId.toLowerCase()
  const r = rows.find((x) => x.instrument.id.toLowerCase() === id)
  if (!r) return null
  const i = r.instrument
  return [i.chain_symbol || chainSymbol, i.expiration_date ?? '?', i.strike_price !== null ? String(i.strike_price) : '?', i.option_type ?? '?'].join(' ')
}

// ---- Orders pane ----

/** The ticket may only trade on the selected account, and only if it is agentic. null = fine. */
export function ticketAccountProblem(accounts: RhAccount[], account: string | null): string | null {
  if (!account) return 'Select an account.'
  const a = accounts.find((x) => x.account_number === account)
  if (!a) return 'Select an account.'
  if (!a.agentic_allowed) return `The selected account ${maskAccount(account)} is not enabled for agent trading. Select an agentic account to place orders.`
  return null
}

/** The type as the user chose it: the raw upstream `type` plus `trigger` (stop) give stop_limit / stop_market. */
export function orderTypeLabel(o: Pick<RhOrder, 'order_type' | 'trigger'>): string {
  if (!o.order_type) return '-'
  if (o.trigger === 'stop') return o.order_type === 'limit' ? 'stop_limit' : o.order_type === 'market' ? 'stop_market' : o.order_type
  return o.order_type
}

export function orderStopText(o: Pick<RhOrder, 'trigger' | 'stop_price'>): string {
  return o.trigger === 'stop' && o.stop_price !== null && o.stop_price !== undefined ? `stop ${fmtPrice(o.stop_price)}` : ''
}

const OPEN_STATES = ['queued', 'confirmed', 'unconfirmed', 'partially_filled']
export function isCancelable(o: RhOrder): boolean {
  return (o.asset === 'equity' || o.asset === 'option') && o.state !== null && OPEN_STATES.includes(o.state)
}

// ---- echoed review ----

export interface EchoSummary {
  rows: Array<[string, string]>
  quote: string | null
  disclosure: string | null
  fees: string | null
  collateral: string | null
  legs: string[]
  optionQuotes: string[]
}

const str = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : null)
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const SPECIAL = new Set(['quote_data', 'option_quotes', 'market_data_disclosure', 'fees', 'collateral', 'legs', 'order_checks'])

function quoteLine(q: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [label, key] of [['bid', 'bid_price'], ['ask', 'ask_price'], ['last', 'last_trade_price'], ['delta', 'delta']] as const) {
    const v = str(q[key])
    if (v !== null) parts.push(`${label} ${v}`)
  }
  return parts.join(' / ')
}

export function echoedSummary(echoed: Record<string, unknown>, accountNumbers: string[]): EchoSummary {
  const out: EchoSummary = { rows: [], quote: null, disclosure: null, fees: null, collateral: null, legs: [], optionQuotes: [] }
  for (const [k, v] of Object.entries(echoed)) {
    if (SPECIAL.has(k) || k.startsWith('customer_approval')) continue
    const s = str(v)
    if (s !== null) out.rows.push([k.replace(/_/g, ' '), maskKnown(s, accountNumbers)])
  }
  const q = rec(echoed.quote_data)
  if (q) out.quote = quoteLine(q) || null
  out.disclosure = str(echoed.market_data_disclosure) ? maskKnown(String(echoed.market_data_disclosure), accountNumbers) : null
  const fees = rec(echoed.fees)
  if (fees) {
    const parts = Object.entries(fees).flatMap(([k, v]) => (str(v) !== null ? [`${k.replace(/_/g, ' ')} ${str(v)}`] : []))
    out.fees = parts.join(', ') || null
  }
  const col = rec(echoed.collateral)
  if (col) {
    const parts: string[] = []
    const cash = rec(col.cash)
    if (cash) parts.push(`cash ${str(cash.amount) ?? '-'}${str(cash.direction) ? ` (${str(cash.direction)})` : ''}${cash.infinite === true ? ' (infinite)' : ''}`)
    if (Array.isArray(col.equities) && col.equities.length) parts.push(`equities ${JSON.stringify(col.equities)}`)
    out.collateral = parts.join(', ') || null
  }
  if (Array.isArray(echoed.legs))
    for (const l of echoed.legs) {
      const r = rec(l)
      if (r) out.legs.push(`${str(r.side) ?? '?'} ${str(r.position_effect) ?? '?'} x${str(r.ratio_quantity) ?? '?'} ${shortId(r.option_id)}`)
    }
  if (Array.isArray(echoed.option_quotes))
    for (const x of echoed.option_quotes) {
      const r = rec(x)
      if (r) out.optionQuotes.push(`${shortId(r.instrument_id ?? r.option_id)}: ${quoteLine(r)}`)
    }
  return out
}

/** Adds time in force and session from the ticket's own args when the server's echo does not carry them. */
export function withTicketRows(
  rows: Array<[string, string]>,
  t: { args: { time_in_force?: string | null; market_hours?: string | null } },
): Array<[string, string]> {
  const out = [...rows]
  const has = (k: string) => out.some(([x]) => x === k)
  if (t.args.time_in_force && !has('time in force')) out.push(['time in force', t.args.time_in_force])
  if (t.args.market_hours && !has('market hours') && !has('session')) out.push(['session', t.args.market_hours])
  return out
}

// ---- approvals list ----

/** A limit price as the server sends it: a decimal string, or `{amount, currency_code}`. */
export function moneyText(v: unknown): string | null {
  const m = rec(v)
  if (m) {
    const amount = str(m.amount)
    if (amount === null) return null
    const cur = str(m.currency_code)
    return cur ? `${amount} ${cur}` : amount
  }
  return str(v)
}

export function approvalSummary(a: RhApproval, accountNumbers: string[]): string {
  const p = a.proposed_order ?? {}
  const bits = [
    a.asset_class.replace('ASSET_CLASS_', '').toLowerCase(),
    str(p.side),
    str(p.quantity) ? `x${str(p.quantity)}` : null,
    str(p.symbol),
    str(p.order_type),
    moneyText(p.limit_price) ? `@ ${moneyText(p.limit_price)}` : null,
  ].filter((x): x is string => !!x)
  return maskKnown(`${bits.join(' ')} (${maskAccount(a.account_number)})`, accountNumbers)
}
