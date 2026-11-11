/**
 * "Ask about this" fragments (M16 B4). EXPLAIN ONLY. A right click on a candle, level, ladder row, position row, strike-check row or journal
 * trade offers one menu item; choosing it prefills the question box and attaches a small FOCUS fragment (digest section lines) to the next
 * question. The user still presses Send: nothing here sends anything.
 *
 * Hygiene: the fragment is built from finite numbers, closed enums and ticker-regex symbols only. Every free-text field a caller might hold
 * (a level label, a note, an option id, an order tag) has no field in {@link AskSpec} and is ignored at runtime. Pure: no store, no network.
 */
import type { BarRow, SectionsState } from './explainDigest'
import { isoMinute } from './explainDigest'
import { isEquityTicker } from './symbols'

export { isoMinute }

export const FOCUS_KINDS = ['candle', 'level', 'ladder', 'position', 'strike', 'trade'] as const
export type FocusKind = (typeof FOCUS_KINDS)[number]

export type PositionAsk =
  | { kind: 'equity'; symbol: string; qty: number | null; avg: number | null; last: number | null }
  | { kind: 'option'; symbol: string; right: string | null; strike: number | null; dte: number | null; qty: number | null; avg: number | null; delta: number | null; mid: number | null; iv: number | null }
export interface TradeAsk {
  symbol: string
  side: string | null
  qty: number | null
  price: number | null
  pnl: number | null
  /** ISO timestamp of the close; only used to count days. */
  timestamp: string | null
}
export type AskSpec =
  | { kind: 'candle'; bar: BarRow | null; prevClose: number | null }
  | { kind: 'level' | 'ladder'; price: number | null; source: string }
  | { kind: 'position'; position: PositionAsk }
  | { kind: 'strike'; right: string | null; strike: number | null; dte: number | null; delta?: number | null; mid?: number | null; iv?: number | null }
  | { kind: 'trade'; trade: TradeAsk }

export interface AskContext {
  symbol: string | null
  tf: string | null
  last: number | null
  nowMs?: number
}
export interface Focus {
  kind: FocusKind
  /** Local words only: "AAPL 15m candle". */
  label: string
  /** Prefilled into the question box (plain, never prescriptive). */
  question: string
  sections: SectionsState
}

const TF = /^(1m|3m|5m|10m|15m|30m|1h|2h|4h|1D|1W|1M)$/
const SOURCES = ['tm', 'flip', 'em', 'fib', 'atr', 'fvg', 'here'] as const
const SIDES = ['buy', 'sell'] as const
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const n = (v: unknown): number | null => (fin(v) ? v : null)
const sym = (v: unknown): string | null => (typeof v === 'string' && isEquityTicker(v) ? v : null)
const oneOf = <T extends string>(v: unknown, all: readonly T[]): T | null => (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : null)
const fmt = (v: number): string => String(Number(v.toFixed(2)))
const DAY_MS = 86_400_000

/** null = nothing usable to describe (no menu is offered). */
export function buildFocus(spec: AskSpec, ctx: AskContext): Focus | null {
  const s = (spec ?? {}) as Record<string, unknown>
  const csym = sym(ctx.symbol) ?? 'chart'
  const ctf = typeof ctx.tf === 'string' && TF.test(ctx.tf) ? ctx.tf : null
  const last = n(ctx.last)
  switch (s.kind) {
    case 'candle': {
      const b = (s.bar ?? null) as Record<string, unknown> | null
      if (!b || !fin(b.close)) return null
      const bar: BarRow = { ts: n(b.ts), open: n(b.open), high: n(b.high), low: n(b.low), close: b.close, volume: n(b.volume) }
      return { kind: 'candle', label: `${csym}${ctf ? ` ${ctf}` : ''} candle`, question: 'What is this candle telling me?', sections: { candle: { ...bar, prevClose: n(s.prevClose) } } }
    }
    case 'level':
    case 'ladder': {
      const price = n(s.price)
      if (price === null) return null
      return { kind: s.kind, label: `${csym} level ${fmt(price)}`, question: `What does the level at ${fmt(price)} mean here?`, sections: { level: { source: oneOf(s.source, SOURCES), price, ref: last } } }
    }
    case 'position': {
      const p = (s.position ?? null) as Record<string, unknown> | null
      const symbol = p ? sym(p.symbol) : null
      if (!p || !symbol) return null
      if (p.kind === 'equity') {
        const [qty, avg, l] = [n(p.qty), n(p.avg), n(p.last)]
        const pnlPct = avg !== null && avg > 0 && l !== null && l > 0 ? (qty !== null && qty < 0 ? 1 - l / avg : l / avg - 1) : null
        return { kind: 'position', label: `${symbol} position`, question: 'Explain this position.', sections: { held: { symbol, qty, avg, last: l, pnlPct } } }
      }
      if (p.kind === 'option') {
        return {
          kind: 'position',
          label: `${symbol} option position`,
          question: 'Explain this position.',
          sections: { contract: { right: oneOf(p.right, ['call', 'put'] as const), strike: n(p.strike), dte: n(p.dte), delta: n(p.delta), mid: n(p.mid), iv: n(p.iv), qty: n(p.qty), avg: n(p.avg) } },
        }
      }
      return null
    }
    case 'strike': {
      const right = oneOf(s.right, ['call', 'put'] as const)
      const strike = n(s.strike)
      if (strike === null) return null
      return {
        kind: 'strike',
        label: `${csym} ${right ?? ''} ${fmt(strike)} strike check`.replace(/\s+/g, ' '),
        question: 'Explain this strike check.',
        sections: { contract: { right, strike, dte: n(s.dte), delta: n(s.delta), mid: n(s.mid), iv: n(s.iv) } },
      }
    }
    case 'trade': {
      const t = (s.trade ?? null) as Record<string, unknown> | null
      const symbol = t ? sym(t.symbol) : null
      if (!t || !symbol) return null
      const when = typeof t.timestamp === 'string' ? Date.parse(t.timestamp) : NaN
      const now = ctx.nowMs ?? Date.now()
      const ago = Number.isFinite(when) && now >= when ? Math.floor((now - when) / DAY_MS) : null
      // NOTES have no field here: only the trade's own numbers. Hold time is not in the realized-P&L feed, so it is NA.
      return {
        kind: 'trade',
        label: `${symbol} closed trade`,
        question: 'Explain this closed trade.',
        sections: { trade: { symbol, side: oneOf(t.side, SIDES), qty: n(t.qty), price: n(t.price), pnl: n(t.pnl), holdDays: null, agoDays: ago } },
      }
    }
    default:
      return null
  }
}
