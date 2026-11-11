/**
 * Pure adapters for the R tools UI (M18): journal R column and editor validation, R-stats view, histogram / curve geometry, heat matching
 * and the concentration readout. INFORMATIONAL ONLY: no threshold, no limit, no colour that implies one, and nothing here can gate or change
 * an order. Trades without a recorded R never enter the stats (the counter says "N of M"); an unknown risk is never counted as zero.
 */
import type { ManualRiskIn, RhOptionPosition, RhPnlTrade, RhPortfolio, RhPosition, RiskDraft, RiskStatsOut, StatRow } from './api'
import { fmtMoney } from './format'
import type { HeatPosition } from './riskHeat'
import { orderByClose, rStats, sqnText, SQN_MIN_TRADES, type DatedR, type HistBin, type RStats } from './riskStats'

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const tidy = (n: number): number => Number.parseFloat(n.toPrecision(12))

// ---- journal R column ----

/** +2.00R / -1.00R / 0.00R; `-` for anything unusable. */
export function fmtR(r: number | null | undefined): string {
  if (!fin(r)) return '-'
  const v = Math.round(r * 100) / 100
  return v === 0 ? '0.00R' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`
}

/** Realized result in R: gain / planned risk. null without a finite gain or a positive planned risk. */
export function realizedR(gain: number | null | undefined, planned: number | null | undefined): number | null {
  return fin(gain) && fin(planned) && planned > 0 ? gain / planned : null
}

export interface RCellOut {
  planned: string
  r: string
  /** The R was typed in after the trade ("set after the fact"). */
  afterTheFact: boolean
}

export function rCell(row: Pick<StatRow, 'planned_risk_usd' | 'source'> | undefined, gain: number | null | undefined): RCellOut {
  if (!row) return { planned: '-', r: '-', afterTheFact: false }
  return { planned: fmtMoney(row.planned_risk_usd), r: fmtR(realizedR(gain, row.planned_risk_usd)), afterTheFact: row.source === 'manual' }
}

export const rCounterText = (withRisk: number, total: number): string => `${withRisk} of ${total} trades have R`

// ---- editor validation (mirrors src-tauri/src/risk.rs) ----

export interface RiskEditForm {
  planned: string
  basis: string
  instrument: string
  stop: string
  entry: string
  qty: string
  note: string
}

export const BASIS_LABELS: Record<string, string> = {
  equity_stop: 'Stock: entry to stop',
  spread_max_loss: 'Credit spread: width minus credit',
  stop_mult: 'Short option: stop buyback minus credit',
  manual_dollars: 'Dollars I decided on',
}
export const BASES_FOR: Record<string, string[]> = {
  equity: ['equity_stop', 'manual_dollars'],
  option: ['spread_max_loss', 'stop_mult', 'manual_dollars'],
}
const MAX_USD = 1e9
const MAX_PRICE = 1e12

function masked(a: string): boolean {
  const c = [...a]
  return c.length >= 4 && c.length <= 8 && (c.slice(0, 4).every((x) => x === '•') || c.slice(0, 4).every((x) => x === '*')) && c.slice(4).every((x) => /^[A-Za-z0-9]$/.test(x))
}

function optional(label: string, text: string): { value: number | null } | { error: string } {
  const t = text.trim()
  if (t === '') return { value: null }
  const n = Number(t)
  return fin(n) && n > 0 && n <= MAX_PRICE ? { value: n } : { error: `${label} must be a number above zero (or left empty).` }
}

export function validateRiskEdit(f: RiskEditForm, trade: { symbol: string }, accountMasked: string | null): { manual: ManualRiskIn } | { error: string } {
  const symbol = (trade.symbol ?? '').trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return { error: 'This trade has no usable stock symbol.' }
  if (f.instrument !== 'equity' && f.instrument !== 'option') return { error: 'Pick stock or option.' }
  if (!(BASES_FOR[f.instrument] ?? []).includes(f.basis)) return { error: 'That basis does not fit a ' + f.instrument + ' (stock and option conventions are never mixed).' }
  const pt = f.planned.trim()
  const planned = pt === '' ? Number.NaN : Number(pt)
  if (pt === '') return { error: 'Enter the planned risk in dollars.' }
  if (!fin(planned) || planned <= 0 || planned > MAX_USD) return { error: 'Planned risk must be a dollar amount above zero.' }
  const stop = optional('Stop', f.stop)
  if ('error' in stop) return stop
  const entry = optional('Entry', f.entry)
  if ('error' in entry) return entry
  const qty = optional('Quantity', f.qty)
  if ('error' in qty) return qty
  const note = f.note.trim()
  if ([...note].length > 500 || [...note].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return { error: 'The note must be one line of at most 500 characters.' }
  if (accountMasked !== null && accountMasked !== '' && !masked(accountMasked)) return { error: 'Only the masked account form can be stored.' }
  return {
    manual: {
      ...(accountMasked ? { account_masked: accountMasked } : {}),
      symbol,
      instrument: f.instrument,
      risk_basis: f.basis,
      planned_risk_usd: planned,
      ...(qty.value !== null ? { qty: qty.value } : {}),
      ...(entry.value !== null ? { entry_price: entry.value } : {}),
      ...(stop.value !== null ? { stop_price: stop.value } : {}),
      ...(note !== '' ? { note } : {}),
    },
  }
}

// ---- R stats ----

export interface StatsView {
  /** What the panel shows (recorded R, plus approximated trades only when the toggle is on). */
  stats: RStats
  /** Recorded R only: what the digest and the headline counter use. */
  recorded: RStats
  nWithR: number
  nTotal: number
  counter: string
  /** The SQN cell text: the number, `-` or "n=12, too few to rank". */
  sqn: string
  sqnCaveat: boolean
  /** Trades with a recorded R but no realized gain (left out). */
  missingRealized: number
  /** Trades added by the "average loss as 1R" approximation (0 when it is off). */
  approximated: number
}

export function statsView(out: RiskStatsOut | null, approx: readonly DatedR[], approxOn = false): StatsView {
  const rows = out?.rows ?? []
  const items: DatedR[] = []
  let missing = 0
  for (const r of rows) {
    const v = realizedR(r.realized_gain, r.planned_risk_usd)
    if (v === null) missing += 1
    else items.push({ r: v, closedAt: r.closed_at })
  }
  const recorded = rStats(orderByClose(items))
  const extra = approxOn ? approx : []
  const stats = extra.length ? rStats(orderByClose([...items, ...extra])) : recorded
  return {
    stats,
    recorded,
    nWithR: out?.with_risk ?? 0,
    nTotal: out?.trades_total ?? 0,
    counter: rCounterText(out?.with_risk ?? 0, out?.trades_total ?? 0),
    sqn: sqnText(stats.n, stats.sqn),
    sqnCaveat: stats.n < SQN_MIN_TRADES,
    missingRealized: missing,
    approximated: extra.length,
  }
}

export interface Approximation {
  items: DatedR[]
  /** The average loss (dollars) of the trades without R, used as 1R. null when none of them lost money. */
  avgLossUsd: number | null
  count: number
}

/** OFF by default and labeled in the UI: treats the average losing trade WITHOUT a recorded R as 1R for those trades only. */
export function approximateRs(trades: readonly RhPnlTrade[], recordedKeys: ReadonlySet<string>): Approximation {
  const seen = new Set<string>()
  const loose = trades.filter((t) => {
    if (recordedKeys.has(t.trade_key) || seen.has(t.trade_key)) return false
    seen.add(t.trade_key)
    return true
  })
  const losses = loose.filter((t) => fin(t.realized_gain) && t.realized_gain < 0).map((t) => Math.abs(t.realized_gain as number))
  if (losses.length === 0) return { items: [], avgLossUsd: null, count: 0 }
  const avg = tidy(losses.reduce((s, x) => s + x, 0) / losses.length)
  const items = loose.filter((t) => fin(t.realized_gain)).map((t): DatedR => ({ r: (t.realized_gain as number) / avg, closedAt: t.timestamp }))
  return { items, avgLossUsd: avg, count: items.length }
}

export interface Bar {
  label: string
  count: number
  /** 0 to 100, relative to the tallest bin (a non-empty bin is at least 4). */
  height: number
}

export function histogramBars(bins: readonly HistBin[]): Bar[] {
  const max = bins.reduce((m, b) => Math.max(m, b.count), 0)
  return bins.map((b) => ({ label: b.label, count: b.count, height: max === 0 || b.count === 0 ? 0 : Math.max(4, Math.round((b.count / max) * 100)) }))
}

export interface Pt {
  x: number
  y: number
}

/** Equity curve geometry: x spread evenly across `w`, y scaled into `h` (a higher cumulative R is drawn higher, so a smaller y). */
export function curvePoints(curve: readonly number[], w: number, h: number): Pt[] {
  const v = curve.filter(fin)
  if (v.length === 0) return []
  const lo = Math.min(...v)
  const hi = Math.max(...v)
  const span = hi - lo
  return v.map((c, i) => ({ x: v.length === 1 ? 0 : (i / (v.length - 1)) * w, y: span === 0 ? h / 2 : h - ((c - lo) / span) * h }))
}

export interface RStatsDigestNumbers {
  n: number
  nWithR: number
  expectancyR: number | null
  winRate: number | null
  avgWinR: number | null
  avgLossR: number | null
  sqn: number | null
  heatPct: number | null
}

/** The numbers the explain digest may carry: recorded R only (never the approximation), no symbols, notes or accounts. */
export function rstatsDigestState(v: StatsView, heatPct: number | null): RStatsDigestNumbers {
  const s = v.recorded
  return { n: v.nTotal, nWithR: v.nWithR, expectancyR: s.expectancy, winRate: s.winRate, avgWinR: s.avgWinR, avgLossR: s.avgLossR, sqn: s.sqn, heatPct }
}

// ---- heat + concentration ----

export const equityOf = (p: RhPortfolio | null | undefined): number | null => (p && fin(p.total_value) && p.total_value > 0 ? p.total_value : null)

const sameQty = (a: number | null, b: number): boolean => a !== null && fin(a) && fin(b) && Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), 1)

/**
 * Planned risk of each open position, from PLACED drafts only (an order id was attached when the order was sent). A position gets a number
 * only when exactly one draft fits it (same account, same underlying, same quantity, same side) and that draft fits no other position;
 * anything else is unknown (null), never a guess and never zero. Ids: `eq:SYMBOL`, `opt:<option id>`.
 */
export function matchPositionRisk(drafts: readonly RiskDraft[], account: string | null, positions: readonly RhPosition[], options: readonly RhOptionPosition[]): HeatPosition[] {
  const placed = account ? drafts.filter((d) => d.order_id !== null && d.account_masked === account) : []
  type Cand = { id: string; fits: (d: RiskDraft) => boolean }
  const cands: Cand[] = [
    ...positions.map((p): Cand => ({
      id: `eq:${p.symbol}`,
      fits: (d) => d.instrument === 'equity' && d.symbol.toUpperCase() === p.symbol.toUpperCase() && d.side === 'buy' && sameQty(d.qty, p.quantity ?? Number.NaN),
    })),
    ...options.map((o): Cand => ({
      id: `opt:${o.option_id}`,
      fits: (d) => d.instrument === 'option' && d.symbol.toUpperCase() === o.chain_symbol.toUpperCase() && sameQty(d.qty, Math.abs(o.quantity)) && ((d.side === 'sell' && o.side === 'short') || (d.side === 'buy' && o.side === 'long')),
    })),
  ]
  return cands.map((c) => {
    const hits = placed.filter(c.fits)
    const one = hits.length === 1 ? hits[0]! : null
    const exclusive = one !== null && cands.filter((o) => o.fits(one)).length === 1
    return { id: c.id, plannedRiskUsd: one !== null && exclusive ? one.planned_risk_usd : null }
  })
}

export interface ConcentrationRow {
  label: string
  /** Market value in dollars (an option by its absolute value); null when no price is known. */
  valueUsd: number | null
  /** Percent of equity; null without equity or a value. Informational: there is no threshold. */
  pct: number | null
}

const strikeText = (s: number | null): string => (s === null ? '?' : String(Number(s)))

export function concentration(equity: number | null, positions: readonly RhPosition[], last: Readonly<Record<string, number | null | undefined>>, options: readonly RhOptionPosition[]): ConcentrationRow[] {
  const eq = fin(equity) && equity > 0 ? equity : null
  const pct = (v: number | null): number | null => (v === null || eq === null ? null : tidy((v / eq) * 100))
  const rows: ConcentrationRow[] = []
  for (const p of positions) {
    const px = last[p.symbol]
    const v = fin(p.quantity) && fin(px) ? tidy(Math.abs(p.quantity) * px) : null
    rows.push({ label: p.symbol, valueUsd: v, pct: pct(v) })
  }
  for (const o of options) {
    const v = fin(o.mark) && fin(o.quantity) ? tidy(Math.abs(o.quantity) * o.mark * (fin(o.multiplier) && o.multiplier > 0 ? o.multiplier : 100)) : null
    const right = o.option_type === 'call' ? 'C' : o.option_type === 'put' ? 'P' : ''
    rows.push({ label: `${o.chain_symbol} ${o.expiration_date ?? '?'} ${strikeText(o.strike_price)}${right} (${o.side})`, valueUsd: v, pct: pct(v) })
  }
  return rows.sort((a, b) => (a.valueUsd === null ? 1 : b.valueUsd === null ? -1 : b.valueUsd - a.valueUsd))
}
