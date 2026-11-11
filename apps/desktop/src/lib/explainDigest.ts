/**
 * Explain digest (M14). Turns what is on screen into a fixed-key text block for the explain-only chat.
 *
 * Hygiene (prompt injection): the digest contains ONLY numbers, enum values, ticker-regex symbols and labels built here from
 * numbers (a contract label is strike + right + a validated ISO date, never server text). Every other string is dropped to NA.
 * No news, no chat, no order tags, no account numbers, no balances. Positions are included only when the caller opts in, and
 * then only symbol, quantity and average price. Absent = `NA`. Hard cap {@link DIGEST_MAX_CHARS}.
 * Pure: no store, no network. Pattern after projectx-desk digest.py.
 */
import type { Candle } from '../chart/bars'
import { isEquityTicker } from './symbols'

export const DIGEST_MAX_CHARS = 6000
/** The cap rises to this only when the BARS section is on (Rust mirrors it: the cap is 8000 when the digest holds a BARS line). */
export const DIGEST_MAX_CHARS_WITH_BARS = 8000
const BARS_WINDOW = 30

export interface ChartDigest {
  symbol: string | null
  tf: string | null
  bars: number | null
  last: number | null
  hi: number | null
  lo: number | null
  /** Decimal fraction over the window (0.0123 = +1.23%). */
  chg: number | null
  /** 0..1, estimated from where bars close inside their range (not tape data). */
  estBuyShare: number | null
}
export interface OverlaysDigest {
  fib: string | null
  fvg: boolean | null
  ma: number[]
  atr: string | null
}
export interface LevelsDigest {
  apex: number[]
  flip: number | null
  emLo: number | null
  emHi: number | null
  /** Decimal fraction of spot (0.043 = 4.3%). */
  emPct: number | null
}
export interface FibDigest {
  up: boolean | null
  r382: number | null
  r500: number | null
  r618: number | null
}
export interface StrikeDigest {
  right: string | null
  strike: number | null
  dte: number | null
  emUnits: number | null
  wall: number | null
  earningsInside: boolean | null
  verdict: string | null
}
export type PositionDigest =
  | { kind: 'equity'; symbol: string; qty: number | null; avg: number | null }
  | { kind: 'option'; symbol: string; right: string | null; strike: number | null; expiration: string | null; qty: number | null; avg: number | null }

/** One OHLCV bar for the BARS / CANDLE sections. Epoch ms; every field may be missing (printed NA). */
export interface BarRow {
  ts: number | null
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}
/**
 * Optional digest sections (M16 B4), each OFF unless present: BARS (the user ticked "Include recent bars"), CANDLE / LEVEL / CONTRACT / HELD /
 * TRADE (the user pointed at one thing with "Ask about this"). Numbers and enums only; notes text and server labels have no field here.
 */
export interface SectionsState {
  bars?: BarRow[] | null
  candle?: (BarRow & { prevClose?: number | null }) | null
  level?: { source: string | null; price: number | null; ref: number | null } | null
  contract?: { right: string | null; strike: number | null; dte: number | null; delta?: number | null; mid?: number | null; iv?: number | null; qty?: number | null; avg?: number | null } | null
  held?: { symbol: string | null; qty: number | null; avg: number | null; last: number | null; pnlPct: number | null } | null
  trade?: { symbol: string | null; side: string | null; qty: number | null; price: number | null; pnl: number | null; holdDays: number | null; agoDays: number | null } | null
}

/** R-multiple statistics for the optional RSTATS line (M18). Numbers only: no symbol, note or account field exists here. */
export interface RStatsDigest {
  n: number | null
  nWithR: number | null
  expectancyR: number | null
  winRate: number | null
  avgWinR: number | null
  avgLossR: number | null
  /** null below 30 trades or with a zero spread (printed NA). */
  sqn: number | null
  /** Sum of planned R across open positions, percent of equity. */
  heatPct: number | null
}

export interface ExplainState {
  chart: ChartDigest | null
  overlays: OverlaysDigest | null
  levels: LevelsDigest | null
  /** 0..100. */
  ivRank: number | null
  fib: FibDigest | null
  strike: StrikeDigest | null
  positions: PositionDigest[]
  sections?: SectionsState
  /** Printed only when the caller sets `includeRStats` (its own checkbox, default off). */
  rstats?: RStatsDigest | null
}

export const EMPTY_EXPLAIN_STATE: ExplainState = { chart: null, overlays: null, levels: null, ivRank: null, fib: null, strike: null, positions: [] }

const NA = 'NA'
const TF = /^(1m|3m|5m|10m|15m|30m|1h|2h|4h|1D|1W|1M)$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const FIB_MODES = ['off', 'key', 'all']
const ATR_MODES = ['off', 'auto', 'on']
const VERDICTS = ['protected', 'exposed', 'event', 'unknown']
const MAX_POSITION_LINES = 20

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** Up to 4 decimals, trailing zeros trimmed; non-finite is NA. */
const num = (v: unknown): string => (fin(v) ? String(Number(v.toFixed(4))) : NA)
const int = (v: unknown): string => (fin(v) ? String(Math.trunc(v)) : NA)
const sym = (v: unknown): string => (typeof v === 'string' && isEquityTicker(v) ? v : NA)
const oneOf = (v: unknown, allowed: readonly string[]): string => (typeof v === 'string' && allowed.includes(v) ? v : NA)
const bool = (v: unknown): string => (v === true ? 'true' : v === false ? 'false' : NA)
const onOff = (v: unknown): string => (v === true ? 'on' : v === false ? 'off' : NA)
const pctSigned = (v: unknown): string => (fin(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%` : NA)
const right = (v: unknown): string => oneOf(v, ['call', 'put'])
const LEVEL_SOURCES = ['tm', 'flip', 'em', 'fib', 'atr', 'fvg', 'here'] as const
const TRADE_SIDES = ['buy', 'sell'] as const
const MAX_BAR_LINES = 30

/** `2026-11-11T14:30Z` from epoch ms; NA for anything that is not a plausible time. */
export function isoMinute(ts: unknown): string {
  if (!fin(ts) || ts < 1e11 || ts > 4e12) return NA
  return `${new Date(ts).toISOString().slice(0, 16)}Z`
}
const barLine = (b: BarRow): string => `t=${isoMinute(b.ts)} o=${num(b.open)} h=${num(b.high)} l=${num(b.low)} c=${num(b.close)} v=${num(b.volume)}`

/** hi / lo / change over the last 30 bars and the estimated buy share of their volume. All from bars already on the chart. */
export function summarizeBars(bars: readonly Candle[]): Pick<ChartDigest, 'bars' | 'last' | 'hi' | 'lo' | 'chg' | 'estBuyShare'> {
  const n = bars.length
  if (n === 0) return { bars: 0, last: null, hi: null, lo: null, chg: null, estBuyShare: null }
  const win = bars.slice(-BARS_WINDOW)
  const last = win[win.length - 1]!.close
  const first = win[0]!.close
  let vol = 0
  let buy = 0
  for (const b of win) {
    if (!(b.volume > 0)) continue
    const r = b.high - b.low
    const share = r > 0 ? Math.min(1, Math.max(0, (b.close - b.low) / r)) : 0.5
    vol += b.volume
    buy += b.volume * share
  }
  return {
    bars: n,
    last,
    hi: Math.max(...win.map((b) => b.high)),
    lo: Math.min(...win.map((b) => b.low)),
    chg: first > 0 ? last / first - 1 : null,
    estBuyShare: vol > 0 ? buy / vol : null,
  }
}

function positionLine(p: PositionDigest): string | null {
  if (p.kind === 'equity') {
    const s = sym(p.symbol)
    return s === NA ? null : `POS: ${s} qty=${num(p.qty)} avg=${num(p.avg)}`
  }
  const s = sym(p.symbol)
  if (s === NA) return null
  const r = right(p.right)
  const label = `${s} ${typeof p.expiration === 'string' && ISO_DATE.test(p.expiration) ? p.expiration : NA} ${num(p.strike)}${r === 'call' ? 'C' : r === 'put' ? 'P' : NA}`
  return `POS: ${label} qty=${num(p.qty)} avg=${num(p.avg)}`
}

export function buildExplainDigest(state: ExplainState, opts: { includePositions: boolean; /** The user ticked "Include my R stats" (default off). */ includeRStats?: boolean; /** Test hook: a lower cap than the default. */ maxChars?: number }): string {
  const c = state.chart
  const o = state.overlays
  const l = state.levels
  const f = state.fib
  const lines: string[] = []
  lines.push(`CHART: symbol=${sym(c?.symbol)} tf=${typeof c?.tf === 'string' && TF.test(c.tf) ? c.tf : NA} bars=${int(c?.bars)} last=${num(c?.last)}`)
  lines.push(`RANGE: hi=${num(c?.hi)} lo=${num(c?.lo)} chg=${pctSigned(c?.chg)} (last ${BARS_WINDOW} bars)`)
  lines.push(`VOL: est_buy_share=${num(c?.estBuyShare)} (estimate from bar closes, not tape)`)
  const ma = o && Array.isArray(o.ma) ? o.ma.filter((p) => fin(p) && Number.isInteger(p) && p > 0 && p <= 1000).map(String) : []
  lines.push(`OVERLAYS: fib=${oneOf(o?.fib, FIB_MODES)} fvg=${onOff(o?.fvg)} ma=${o ? (ma.length ? ma.join(',') : 'none') : NA} atr=${oneOf(o?.atr, ATR_MODES)}`)
  const apex = l && Array.isArray(l.apex) ? l.apex.filter(fin).slice(0, 3).map(num) : []
  lines.push(`LEVELS: apex=${apex.length ? apex.join(',') : NA} flip=${num(l?.flip)} em_lo=${num(l?.emLo)} em_hi=${num(l?.emHi)} em_pct=${num(l?.emPct)}`)
  lines.push(`IV: rank=${num(state.ivRank)}`)
  lines.push(`FIB: up=${bool(f?.up)} 0.382=${num(f?.r382)} 0.5=${num(f?.r500)} 0.618=${num(f?.r618)}`)
  const s = state.strike
  if (s) {
    lines.push(
      `STRIKE: right=${right(s.right)} strike=${num(s.strike)} dte=${int(s.dte)} em_units=${num(s.emUnits)} wall=${num(s.wall)} earnings_inside=${bool(s.earningsInside)} verdict=${oneOf(s.verdict, VERDICTS)}`,
    )
  }
  if (opts.includeRStats === true) {
    const r = state.rstats
    lines.push(
      `RSTATS: n=${int(r?.n)} n_with_r=${int(r?.nWithR)} expectancy_r=${num(r?.expectancyR)} win_rate=${num(r?.winRate)} avg_win_r=${num(r?.avgWinR)} avg_loss_r=${num(r?.avgLossR)} sqn=${num(r?.sqn)} heat_pct=${num(r?.heatPct)}`,
    )
  }
  const sec = state.sections
  if (sec?.candle) {
    const k = sec.candle
    const dir = fin(k.open) && fin(k.close) ? (k.close > k.open ? 'up' : k.close < k.open ? 'down' : 'flat') : NA
    const chg = fin(k.close) && fin(k.prevClose) && k.prevClose > 0 ? pctSigned(k.close / k.prevClose - 1) : NA
    lines.push(`CANDLE: ${barLine(k)} chg=${chg} dir=${dir}`)
  }
  if (sec?.level) {
    const v = sec.level
    const known = fin(v.price) && fin(v.ref) && v.ref > 0
    const dist = known ? pctSigned((v.price! - v.ref!) / v.ref!) : NA
    const side = known ? (v.price! > v.ref! ? 'above' : v.price! < v.ref! ? 'below' : 'at') : NA
    lines.push(`LEVEL: source=${oneOf(v.source, LEVEL_SOURCES)} price=${num(v.price)} dist_pct=${dist} side=${side}`)
  }
  if (sec?.contract) {
    const k = sec.contract
    lines.push(`CONTRACT: right=${right(k.right)} strike=${num(k.strike)} dte=${int(k.dte)} delta=${num(k.delta)} mid=${num(k.mid)} iv=${num(k.iv)} qty=${num(k.qty)} avg=${num(k.avg)}`)
  }
  if (sec?.held) {
    const k = sec.held
    lines.push(`HELD: symbol=${sym(k.symbol)} qty=${num(k.qty)} avg=${num(k.avg)} last=${num(k.last)} pnl_pct=${pctSigned(k.pnlPct)}`)
  }
  if (sec?.trade) {
    const k = sec.trade
    lines.push(`TRADE: symbol=${sym(k.symbol)} side=${oneOf(k.side, TRADE_SIDES)} qty=${num(k.qty)} price=${num(k.price)} pnl=${num(k.pnl)} hold_days=${num(k.holdDays)} ago_days=${int(k.agoDays)}`)
  }
  if (opts.includePositions) {
    const pos = (Array.isArray(state.positions) ? state.positions : []).map(positionLine).filter((x): x is string => x !== null).slice(0, MAX_POSITION_LINES)
    if (pos.length === 0) lines.push('POS: none')
    else lines.push(...pos)
  }
  const bars = Array.isArray(sec?.bars) ? sec!.bars!.slice(-MAX_BAR_LINES) : []
  const withBars = bars.length > 0
  if (withBars) {
    lines.push(`BARS: n=${bars.length} tf=${typeof c?.tf === 'string' && TF.test(c.tf) ? c.tf : NA} (oldest first, t=UTC minute)`)
    for (const b of bars) lines.push(`BAR ${barLine(b)}`)
  }
  // Hard cap: whole lines only, in priority order (the header lines come first, then the pointed-at item, positions, and BARS last).
  const cap = opts.maxChars ?? (withBars ? DIGEST_MAX_CHARS_WITH_BARS : DIGEST_MAX_CHARS)
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const add = line.length + (out.length ? 1 : 0)
    if (used + add > cap) break
    out.push(line)
    used += add
  }
  return out.join('\n')
}

/** FIB line values from the chart's fib ladder (0.382 / 0.5 / 0.618). */
export function fibDigest(fib: { up: boolean; levels: { ratio: number; price: number }[] } | null | undefined): FibDigest | null {
  if (!fib) return null
  const at = (r: number) => fib.levels.find((l) => Math.abs(l.ratio - r) < 1e-9)?.price ?? null
  return { up: fib.up, r382: at(0.382), r500: at(0.5), r618: at(0.618) }
}
