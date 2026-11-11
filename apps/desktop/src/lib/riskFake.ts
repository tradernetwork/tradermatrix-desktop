/**
 * In-memory stand-in for the R-tool commands (tests and the dev pages). Same validation and the same exact one-to-one suggestion rule as
 * src-tauri/src/risk.rs. INFORMATIONAL ONLY: nothing here knows about an order. No network, no Tauri.
 */
import type { DraftFieldsIn, DraftIn, PromoteIn, RiskDraft, RiskSettings, RiskSettingsIn, RiskState, RiskStatsOut, RiskSuggestion, RiskTradeIn, StatRow, TradeRisk } from './api'

const BASES = ['equity_stop', 'spread_max_loss', 'stop_mult', 'manual_dollars']
const DRAFT_OPEN_TTL_MS = 3_600_000
const DRAFT_PLACED_TTL_MS = 90 * 86_400_000
const MAX_USD = 1e9
const MAX_PRICE = 1e12
const MAX_STATS_TRADES = 5000
const SYMBOL = /^[A-Za-z][A-Za-z0-9.-]{0,9}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const KEY = /^[A-Za-z0-9_#-]{1,64}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const bad = (m: string): never => {
  throw new Error(`invalid input: ${m}`)
}
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

export function parseIsoMs(s: string | null | undefined): number | null {
  if (typeof s !== 'string' || !ISO.test(s)) return null
  const v = Date.parse(s)
  return Number.isFinite(v) ? v : null
}

function maskedOk(a: string): boolean {
  const c = [...a]
  return c.length >= 4 && c.length <= 8 && (c.slice(0, 4).every((x) => x === '•') || c.slice(0, 4).every((x) => x === '*')) && c.slice(4).every((x) => /^[A-Za-z0-9]$/.test(x))
}
function cleanMasked(a: string | null | undefined): string | null {
  if (a === null || a === undefined || a === '') return null
  if (!maskedOk(a)) return bad('account must be the masked form (four dots then at most four characters); full account numbers are never stored')
  return a
}
function posOpt(name: string, v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (!(fin(v) && v > 0 && v <= MAX_PRICE)) return bad(`${name} must be a number above zero`)
  return v
}

interface Core {
  account_masked: string | null
  symbol: string
  instrument: string
  risk_basis: string
  planned_risk_usd: number
  qty: number | null
  entry_price: number | null
  stop_price: number | null
  multiplier: number
}

function core(i: { account_masked?: string | null; symbol: string; instrument: string; risk_basis: string; planned_risk_usd: number; qty?: number | null; entry_price?: number | null; stop_price?: number | null; multiplier?: number | null }): Core {
  const account_masked = cleanMasked(i.account_masked)
  const symbol = (i.symbol ?? '').trim().toUpperCase()
  if (!SYMBOL.test(symbol)) bad("symbol must be 1 to 10 characters: A-Z, 0-9, '.' or '-', starting with a letter")
  if (!['equity', 'option'].includes(i.instrument)) bad('instrument must be equity or option')
  if (!BASES.includes(i.risk_basis)) bad('risk basis must be equity_stop, spread_max_loss, stop_mult or manual_dollars')
  const fits = i.risk_basis === 'equity_stop' ? i.instrument === 'equity' : i.risk_basis === 'spread_max_loss' || i.risk_basis === 'stop_mult' ? i.instrument === 'option' : true
  if (!fits) bad('the risk basis does not fit the instrument')
  if (!(fin(i.planned_risk_usd) && i.planned_risk_usd > 0 && i.planned_risk_usd <= MAX_USD)) bad('planned risk must be a dollar amount above zero')
  let multiplier: number
  if (i.multiplier === null || i.multiplier === undefined) multiplier = i.instrument === 'option' ? 100 : 1
  else if (Number.isInteger(i.multiplier) && i.multiplier >= 1 && i.multiplier <= 1000) multiplier = i.multiplier
  else return bad('multiplier must be 1 to 1000')
  return {
    account_masked, symbol, instrument: i.instrument, risk_basis: i.risk_basis, planned_risk_usd: i.planned_risk_usd,
    qty: posOpt('quantity', i.qty), entry_price: posOpt('entry price', i.entry_price), stop_price: posOpt('stop price', i.stop_price), multiplier,
  }
}

function tradeKey(k: string): string {
  if (typeof k !== 'string' || !KEY.test(k)) return bad('trade key is not valid')
  return k
}

function candidate(d: RiskDraft, account: string, t: RiskTradeIn): boolean {
  const ts = parseIsoMs(t.timestamp)
  if (d.placed_at === null || d.qty === null || !fin(t.quantity) || !t.side || ts === null) return false
  const opposite = (d.side === 'buy' && t.side.toLowerCase() === 'sell') || (d.side === 'sell' && t.side.toLowerCase() === 'buy')
  const sameQty = Math.abs(d.qty - t.quantity) <= 1e-9 * Math.max(Math.abs(d.qty), 1)
  return d.order_id !== null && d.account_masked === account && d.symbol.toUpperCase() === t.symbol.trim().toUpperCase() && opposite && sameQty && ts >= d.placed_at && ts <= d.placed_at + DRAFT_PLACED_TTL_MS
}

/** Only exact one-to-one matches; everything ambiguous is left alone. A suggestion is data, never a link. */
export function suggest(drafts: RiskDraft[], trades: RiskTradeIn[], account: string): RiskSuggestion[] {
  const out: RiskSuggestion[] = []
  for (const d of drafts) {
    const hits = trades.filter((t) => candidate(d, account, t))
    if (hits.length !== 1) continue
    const t = hits[0]!
    if (drafts.filter((o) => candidate(o, account, t)).length === 1) out.push({ review_id: d.review_id, trade_key: t.trade_key })
  }
  return out
}

export class FakeRisk {
  private settings: RiskSettings = { default_risk_pct: 1, default_option_stop_mult: 2, r_fallback_enabled: false }
  private risk = new Map<string, TradeRisk>()
  private drafts = new Map<string, RiskDraft>()
  private seq = 0

  reset(): void {
    this.settings = { default_risk_pct: 1, default_option_stop_mult: 2, r_fallback_enabled: false }
    this.risk.clear()
    this.drafts.clear()
    this.seq = 0
  }

  private purge(now: number): void {
    for (const [k, d] of this.drafts) if (d.expires_at < now) this.drafts.delete(k)
  }
  private live(now: number): RiskDraft[] {
    this.purge(now)
    return [...this.drafts.values()].sort((a, b) => b.created_at - a.created_at || (a.review_id < b.review_id ? -1 : 1))
  }

  get(now = Date.now()): RiskState {
    const risk = [...this.risk.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.trade_key < b.trade_key ? -1 : 1))
    return { settings: { ...this.settings }, risk, drafts: this.live(now) }
  }

  set(s: RiskSettingsIn): RiskSettings {
    if (s.default_risk_pct !== undefined && s.default_risk_pct !== null && !(fin(s.default_risk_pct) && s.default_risk_pct > 0 && s.default_risk_pct <= 100)) bad('default risk percent must be above 0 and at most 100')
    if (s.default_option_stop_mult !== undefined && s.default_option_stop_mult !== null && !(fin(s.default_option_stop_mult) && s.default_option_stop_mult > 1 && s.default_option_stop_mult <= 50)) bad('option stop multiple must be above 1 and at most 50')
    this.settings = {
      default_risk_pct: s.default_risk_pct ?? this.settings.default_risk_pct,
      default_option_stop_mult: s.default_option_stop_mult ?? this.settings.default_option_stop_mult,
      r_fallback_enabled: s.r_fallback_enabled ?? this.settings.r_fallback_enabled,
    }
    return { ...this.settings }
  }

  draftPut(d: DraftIn, now = Date.now()): RiskDraft {
    if (!UUID.test(d.review_id)) bad('review id is not valid')
    this.purge(now)
    const hasF = d.fields !== undefined && d.fields !== null
    const hasO = d.order_id !== undefined && d.order_id !== null
    if (hasF && !hasO) {
      const f = d.fields as DraftFieldsIn
      if (!['buy', 'sell'].includes(f.side)) bad('side must be buy or sell')
      const c = core(f)
      if (this.drafts.get(d.review_id)?.order_id) bad('the order for this draft was already placed')
      const row: RiskDraft = { review_id: d.review_id, created_at: now, ...c, side: f.side, order_id: null, placed_at: null, expires_at: now + DRAFT_OPEN_TTL_MS }
      this.drafts.set(d.review_id, row)
      return { ...row }
    }
    if (!hasF && hasO) {
      const orderId = d.order_id as string
      if (!ID.test(orderId)) bad('order id is not valid')
      const e = this.drafts.get(d.review_id)
      if (!e) throw new Error('not found: no live risk draft for this review (it expired or was never saved); nothing was recorded')
      if (e.order_id === orderId) return { ...e }
      if (e.order_id) bad('a different order is already attached to this draft')
      const row = { ...e, order_id: orderId, placed_at: now, expires_at: now + DRAFT_PLACED_TTL_MS }
      this.drafts.set(d.review_id, row)
      return { ...row }
    }
    return bad('send either the draft fields or an order id, not both and not neither')
  }

  private upsert(key: string, c: Core, source: 'draft' | 'manual', note: string | null): TradeRisk {
    const prev = this.risk.get(key)
    const now = new Date(Date.now() + ++this.seq).toISOString()
    const row: TradeRisk = { trade_key: key, created_at: prev?.created_at ?? now, updated_at: now, ...c, source, after_the_fact: source === 'manual', note }
    this.risk.set(key, row)
    return { ...row }
  }

  promote(p: PromoteIn, now = Date.now()): TradeRisk {
    const key = tradeKey(p.trade_key)
    const hasM = p.manual !== undefined && p.manual !== null
    const hasR = p.review_id !== undefined && p.review_id !== null
    if (hasM && !hasR) {
      const m = p.manual!
      const t = (m.note ?? '').trim()
      if (t !== '' && ([...t].length > 500 || [...t].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) bad('note must be one line of at most 500 characters')
      return this.upsert(key, core(m), 'manual', t === '' ? null : t)
    }
    if (hasR && !hasM) {
      const rv = p.review_id as string
      if (!UUID.test(rv)) bad('review id is not valid')
      this.purge(now)
      const d = this.drafts.get(rv)
      if (!d) throw new Error('not found: no live risk draft for this review (it expired or was never saved)')
      if (!d.order_id) bad("this draft's order was not placed, so there is no trade to link it to")
      const c = core({ ...d, multiplier: d.multiplier })
      const r = this.upsert(key, c, 'draft', null)
      this.drafts.delete(rv)
      return r
    }
    return bad('promote either a review draft or a manual entry, not both and not neither')
  }

  stats(accountMasked: string | null | undefined, trades: RiskTradeIn[], now = Date.now()): RiskStatsOut {
    if (trades.length > MAX_STATS_TRADES) bad('at most 5000 trades per call')
    const account = cleanMasked(accountMasked ?? null)
    const keys = trades.map((t) => tradeKey(t.trade_key))
    this.purge(now)
    const rows: StatRow[] = []
    const seen = new Set<string>()
    const unlinked: RiskTradeIn[] = []
    trades.forEach((t, i) => {
      const k = keys[i]!
      if (seen.has(k)) return
      seen.add(k)
      const r = this.risk.get(k)
      if (r) rows.push({ trade_key: k, symbol: r.symbol, planned_risk_usd: r.planned_risk_usd, risk_basis: r.risk_basis, source: r.source, realized_gain: fin(t.realized_gain) ? t.realized_gain : null, closed_at: t.timestamp ?? null })
      else unlinked.push(t)
    })
    const suggestions = account ? suggest(this.live(now), unlinked, account) : []
    return { rows, trades_total: trades.length, with_risk: rows.length, suggestions }
  }
}
