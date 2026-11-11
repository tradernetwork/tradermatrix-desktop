/**
 * Pure planning for the TraderMatrix <-> Robinhood watchlist sync (M8). Adds only: nothing here can express a
 * removal. TM notes never appear: the Rust core already drops them, and only ticker strings come in.
 */
import { EQUITY_SYMBOL } from './symbols'

export interface SkipNote {
  symbol: string
  reason: string
}
export interface SyncPlan {
  /** On TM, not on Robinhood: to copy to Robinhood. */
  onlyTm: string[]
  /** On Robinhood, not on TM, and TM can hold them (and there is room): to copy to TM. */
  onlyRh: string[]
  both: string[]
  skippedForTm: SkipNote[]
  skippedForRh: SkipNote[]
}
export type Direction = 'tm_to_rh' | 'rh_to_tm' | 'both'

/** TraderMatrix ticker shape after uppercasing (same as the Rust core's `valid_symbol`). */
export const TM_TICKER = /^[A-Z]{1,6}(\.[A-Z])?$/
/** Robinhood add_to_watchlist takes at most this many symbols per call. */
export const RH_CHUNK = 50
export const SYNC_PAIR_KEY = 'watch.sync.pair'

const norm = (s: string): string => s.trim().toUpperCase()
const bySymbol = (a: SkipNote, b: SkipNote): number => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) if (x && !seen.has(x)) (seen.add(x), out.push(x))
  return out
}

/** Why TM cannot hold this (already uppercased) symbol. */
function tmReason(s: string): string {
  if (/\d/.test(s)) return 'TraderMatrix tickers are letters only (this one has a digit)'
  if (s.includes('-')) return "TraderMatrix does not take '-' tickers (it writes class shares with a dot, like BRK.B)"
  const base = s.split('.')[0]
  if (base.length > 6) return 'TraderMatrix tickers are at most 6 letters'
  return 'TraderMatrix does not accept this ticker format (1 to 6 letters, optional .X)'
}

export function tmTickersOf(l: { tickers: string[] }): string[] {
  return dedupe(l.tickers.map(norm)).filter((s) => TM_TICKER.test(s))
}

export function rhSymbolsOf(items: { symbol: string; object_type?: string | null }[]): { symbols: string[]; skipped: SkipNote[] } {
  const symbols: string[] = []
  const skipped: SkipNote[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const s = norm(it.symbol ?? '')
    if (!s || seen.has(s)) continue
    seen.add(s)
    const t = it.object_type
    if (t && t !== 'instrument') skipped.push({ symbol: s, reason: `Robinhood item type "${t}" is not a stock or ETF` })
    else if (!EQUITY_SYMBOL.test(s)) skipped.push({ symbol: s, reason: 'not a valid stock symbol' })
    else symbols.push(s)
  }
  return { symbols, skipped }
}

export function computeSyncPlan(tm: string[], rh: { symbols: string[]; skipped: SkipNote[] }, opts?: { tmFree?: number }): SyncPlan {
  const tmSet = dedupe(tm.map(norm))
  const rhSet = dedupe(rh.symbols.map(norm))
  const skippedForRh: SkipNote[] = []
  const tmOk: string[] = []
  for (const s of tmSet) {
    if (EQUITY_SYMBOL.test(s)) tmOk.push(s)
    else skippedForRh.push({ symbol: s, reason: 'not a valid Robinhood stock symbol' })
  }
  const onRh = new Set(rhSet)
  const onTm = new Set(tmOk)
  const onlyTm = tmOk.filter((s) => !onRh.has(s)).sort()
  const both = tmOk.filter((s) => onRh.has(s)).sort()
  const skippedForTm: SkipNote[] = [...rh.skipped]
  const candidates: string[] = []
  for (const s of rhSet) {
    if (onTm.has(s)) continue
    if (TM_TICKER.test(s)) candidates.push(s)
    else skippedForTm.push({ symbol: s, reason: tmReason(s) })
  }
  candidates.sort()
  const free = opts?.tmFree === undefined ? Infinity : Math.max(0, Math.floor(opts.tmFree))
  const onlyRh = candidates.slice(0, free)
  for (const s of candidates.slice(free)) skippedForTm.push({ symbol: s, reason: 'no room left on the TraderMatrix list (plan limit)' })
  return { onlyTm, onlyRh, both, skippedForTm: skippedForTm.sort(bySymbol), skippedForRh: skippedForRh.sort(bySymbol) }
}

export function actionsFor(plan: SyncPlan, dir: Direction): { addToRh: string[]; addToTm: string[] } {
  return { addToRh: dir === 'rh_to_tm' ? [] : [...plan.onlyTm], addToTm: dir === 'tm_to_rh' ? [] : [...plan.onlyRh] }
}

/** Free TM slots for the target list (null = a list that does not exist yet); undefined when TM reports no limits. */
export function tmFreeSlots(
  lists: { id: number; ticker_count: number }[],
  targetId: number | null,
  limits: { tickers_per_list: number | null; tickers_across_all_lists: number | null },
): number | undefined {
  const cur = targetId === null ? 0 : (lists.find((l) => l.id === targetId)?.ticker_count ?? 0)
  const total = lists.reduce((n, l) => n + l.ticker_count, 0)
  const caps: number[] = []
  if (limits.tickers_per_list !== null) caps.push(limits.tickers_per_list - cur)
  if (limits.tickers_across_all_lists !== null) caps.push(limits.tickers_across_all_lists - total)
  return caps.length === 0 ? undefined : Math.max(0, Math.min(...caps))
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** The remembered pairing: list ids as strings, or 'new'. Garbage gives nulls; the store validates against live lists. */
export interface SyncPair {
  tm: string | null
  rh: string | null
}
export function parseSyncPair(raw: string | null | undefined): SyncPair {
  const none: SyncPair = { tm: null, rh: null }
  if (!raw) return none
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return none
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return none
  const o = v as Record<string, unknown>
  const ok = (x: unknown): string | null => (typeof x === 'string' && x.length >= 1 && x.length <= 64 ? x : null)
  return { tm: ok(o.tm), rh: ok(o.rh) }
}
