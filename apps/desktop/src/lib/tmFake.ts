/**
 * Fake TraderMatrix backend for tests and the dev pages. It serves the REAL sample responses captured on 2026-11-11
 * (src-tauri/tests/fixtures/tm/*.json) and maps them to the same snake_case shapes the Rust tm_* commands return.
 * No network, and it never sees a key: the only key state is a "present" boolean supplied by the fake secret store.
 */
import type { ApexLevels, ExpectedMove, IvRank, TmAddOutcome, TmSnapshot, TmStatus, TmWatchlistMeta, TmWatchlists } from './api'
import apexFx from '../../src-tauri/tests/fixtures/tm/apex_levels.json'
import moveFx from '../../src-tauri/tests/fixtures/tm/expected_move.json'
import snapFx from '../../src-tauri/tests/fixtures/tm/ticker_snapshot.json'
import ivFx from '../../src-tauri/tests/fixtures/tm/iv_rank.json'
import wlFx from '../../src-tauri/tests/fixtures/tm/list_watchlists.json'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>

export type TmMode = 'ok' | 'rejected' | 'tier' | 'transport' | 'locked'
/** Contract: the band the rank was clamped to, 'below_band' | 'above_band', else null (older cores sent a boolean: no direction, so absent). */
export function clampedOf(v: unknown): string | null {
  return v === 'below_band' || v === 'above_band' ? v : null
}

export type TmTool = 'apex' | 'move' | 'iv_rank' | 'snapshot'
/** The ONLY TM tools M8 may reach. Anything else (remove_*, delete_*, update_watchlist ...) is refused by the fake. */
export type TmWlTool = 'list_watchlists' | 'add_to_watchlist' | 'create_watchlist'
const WL_TOOLS: readonly string[] = ['list_watchlists', 'add_to_watchlist', 'create_watchlist']

/** The exact user-facing strings the Rust core produces (RhError Display). */
export const TM_MSG = {
  missing: 'TraderMatrix key not set',
  rejected: 'TraderMatrix rejected the key (invalid or revoked)',
  locked: 'vault locked: unlock it to use TraderMatrix',
  // Synthetic stand-ins: the real tier wording is whatever TM returns.
  tier: 'tool error: Rate limit reached for your TraderMatrix plan (synthetic dev text). Try again later or upgrade.',
  transport: 'transport error: error sending request (synthetic fake failure)',
}

const SYMBOL = /^[A-Z]{1,6}(\.[A-Z])?$/
const EXPIRATION = /^\d{4}-\d{2}-\d{2}$/
/** Fixture reference price (AAPL, 2026-11-11). */
const FIXTURE_SPOT = 348.51

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** The sanitized fixture mapped like the Rust core does: tickers only, uppercased; notes and addedAt dropped. */
function fixtureWatchlists(): TmWatchlists {
  const raw = clone(wlFx) as J
  const lim = (raw.limits ?? {}) as J
  return {
    lists: (raw.lists as J[]).map((l) => ({
      id: Number(l.id),
      name: String(l.name),
      category: str(l.category),
      is_default: l.isDefault === true,
      ticker_count: (l.tickers as J[]).length,
      tickers: (l.tickers as J[]).map((t) => String(t.ticker).toUpperCase()),
    })),
    tickers_per_list: num(lim.tickersPerList),
    tickers_across_all_lists: num(lim.tickersAcrossAllLists),
    max_lists: num(lim.lists),
  }
}

export class FakeTm {
  mode: TmMode = 'ok'
  /** Delay before each read resolves, to exercise loading, de-dupe and stale handling. */
  delayMs = 0
  /** Every read that would have reached TraderMatrix (key present, input valid, vault unlocked). */
  calls: { tool: TmTool; symbol: string; expiration?: string }[] = []
  /** Test hook: rewrite the mapped payload (for example to null out snapshot legs). */
  mutate: ((tool: TmTool, payload: unknown) => unknown) | null = null
  /** Dev hook: rescale the fixture prices to this symbol's fake chart price so overlays land on the fake candles. */
  spotFor: ((symbol: string) => number) | null = null
  private lastError: string | null = null

  // ---- M8 watchlists (mutable fake account, seeded from the sanitized fixture) ----
  wl: TmWatchlists = fixtureWatchlists()
  /** One entry per watchlist tool call that "reached TraderMatrix" (after local validation, key and vault checks). */
  wlLog: { tool: TmWlTool; args: Record<string, unknown> }[] = []
  /** Adding these tickers fails with a tool error (per-symbol failure injection). */
  failTickers = new Set<string>()
  /** When set, every add (that is not already present) fails with this text. */
  failAdds: string | null = null
  /** Called after each add attempt (success or failure) with the running attempt count. */
  onWrite: ((attempts: number) => void) | null = null
  private addAttempts = 0

  constructor(private keyPresent: () => boolean) {}

  reset(): void {
    this.mode = 'ok'
    this.delayMs = 0
    this.calls = []
    this.mutate = null
    this.spotFor = null
    this.lastError = null
    this.wl = fixtureWatchlists()
    this.wlLog = []
    this.failTickers = new Set()
    this.failAdds = null
    this.onWrite = null
    this.addAttempts = 0
  }

  status(): TmStatus {
    if (this.mode === 'locked') return { key_present: false, last_error: TM_MSG.locked }
    return { key_present: this.keyPresent(), last_error: this.lastError }
  }

  private factor(symbol: string): number {
    const s = this.spotFor?.(symbol)
    return s && Number.isFinite(s) && s > 0 ? s / FIXTURE_SPOT : 1
  }

  private async read<T>(tool: TmTool, rawSymbol: string, expiration: string | undefined, build: (symbol: string, k: number) => T): Promise<T> {
    const symbol = rawSymbol.toUpperCase()
    if (!SYMBOL.test(symbol)) throw new Error('invalid input: symbol must be 1-6 letters, optionally .X (for example AAPL or BRK.B)')
    if (expiration !== undefined && !EXPIRATION.test(expiration)) throw new Error('invalid input: expiration must look like YYYY-MM-DD')
    const fail = (m: string): never => {
      this.lastError = m
      throw new Error(m)
    }
    if (this.mode === 'locked') fail(TM_MSG.locked)
    if (!this.keyPresent()) fail(TM_MSG.missing)
    this.calls.push({ tool, symbol, ...(expiration ? { expiration } : {}) })
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.mode === 'rejected') fail(TM_MSG.rejected)
    if (this.mode === 'tier') fail(TM_MSG.tier)
    if (this.mode === 'transport') fail(TM_MSG.transport)
    this.lastError = null
    const out = build(symbol, this.factor(symbol))
    return (this.mutate ? this.mutate(tool, out) : out) as T
  }

  /** Every fake watchlist call goes through here: a tool outside list/add/create is refused, like the Rust core's typed surface. */
  callTool(tool: string): void {
    if (!WL_TOOLS.includes(tool)) throw new Error(`tool not allowed in M8: ${tool}`)
  }

  /** `prep` validates locally (zero "requests" on bad input) and returns the exact tool arguments. */
  private async wlCall<T>(tool: TmWlTool, prep: () => Record<string, unknown>, body: () => T): Promise<T> {
    this.callTool(tool)
    const args = prep()
    const fail = (m: string): never => {
      this.lastError = m
      throw new Error(m)
    }
    if (this.mode === 'locked') fail(TM_MSG.locked)
    if (!this.keyPresent()) fail(TM_MSG.missing)
    this.wlLog.push({ tool, args })
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.mode === 'rejected') fail(TM_MSG.rejected)
    if (this.mode === 'tier') fail(TM_MSG.tier)
    if (this.mode === 'transport') fail(TM_MSG.transport)
    this.lastError = null
    return body()
  }

  private listRef(raw: string): string {
    const t = raw.trim()
    if (t === '' || [...t].length > 60 || CONTROL.test(t)) throw new Error('invalid input: list name must be 1 to 60 printable characters')
    return t
  }

  watchlists(): Promise<TmWatchlists> {
    return this.wlCall('list_watchlists', () => ({}), () => clone(this.wl))
  }

  watchlistAdd(list: string, ticker: string): Promise<TmAddOutcome> {
    let ref = ''
    let sym = ''
    return this.wlCall(
      'add_to_watchlist',
      () => {
        ref = this.listRef(list)
        sym = ticker.toUpperCase()
        if (!SYMBOL.test(sym)) throw new Error('invalid input: symbol must be 1-6 letters, optionally .X (for example AAPL or BRK.B)')
        return { ticker: sym, list: ref }
      },
      () => {
        this.addAttempts += 1
        try {
          const l = this.wl.lists.find((x) => x.name === ref) ?? (/^\d+$/.test(ref) ? this.wl.lists.find((x) => x.id === Number(ref)) : undefined)
          if (!l) throw new Error(`tool error: Unknown list '${ref}' (available lists: ${this.wl.lists.map((x) => x.name).join(', ')})`)
          if (l.tickers.includes(sym)) return { added: false }
          if (this.failAdds !== null) throw new Error(this.failAdds)
          if (this.failTickers.has(sym)) throw new Error(`tool error: synthetic failure adding ${sym}`)
          const per = this.wl.tickers_per_list
          if (per !== null && l.tickers.length >= per) throw new Error(`tool error: Watchlist '${l.name}' is full (${per} tickers per list)`)
          const all = this.wl.tickers_across_all_lists
          if (all !== null && this.wl.lists.reduce((n, x) => n + x.tickers.length, 0) >= all) throw new Error(`tool error: Account watchlist limit reached (${all} tickers across all lists)`)
          l.tickers = [...l.tickers, sym]
          l.ticker_count = l.tickers.length
          return { added: true }
        } finally {
          this.onWrite?.(this.addAttempts)
        }
      },
    )
  }

  watchlistCreate(name: string): Promise<TmWatchlistMeta> {
    let n = ''
    return this.wlCall(
      'create_watchlist',
      () => {
        n = this.listRef(name)
        return { name: n }
      },
      () => {
        const max = this.wl.max_lists
        if (max !== null && this.wl.lists.length >= max) throw new Error(`tool error: List cap reached (${max} lists)`)
        const id = this.wl.lists.reduce((m, l) => Math.max(m, l.id), 0) + 1
        this.wl.lists = [...this.wl.lists, { id, name: n, category: 'swing', is_default: false, ticker_count: 0, tickers: [] }]
        return { id, name: n, category: 'swing', is_default: false }
      },
    )
  }

  apex(symbol: string, expiration?: string): Promise<ApexLevels> {
    return this.read('apex', symbol, expiration, (sym, k) => {
      const raw = clone(apexFx) as J
      const p = (v: unknown) => scale(num(v), k)
      return {
        symbol: sym,
        spot: p(raw.spotPrice),
        snapshot_time: str(raw.snapshotTime),
        gamma_flip: p(raw.gammaFlip),
        net_gex: num(raw.netGex),
        levels: (raw.levels as J[]).map((l) => ({
          strike: p(l.strike),
          score: num(l.score),
          rank: num(l.rank),
          net_gex: num(l.netGEX),
          total_oi: num(l.totalOI),
          is_above_spot: typeof l.isAboveSpot === 'boolean' ? l.isAboveSpot : null,
        })),
        expirations_used: (raw.expirationsUsed as unknown[]).map(String),
        available_expirations: (raw.availableExpirations as unknown[]).map(String),
        open_url: openUrl(raw, sym),
      }
    })
  }

  expectedMove(symbol: string): Promise<ExpectedMove> {
    return this.read('move', symbol, undefined, (sym, k) => {
      const raw = clone(moveFx) as J
      const p = (v: unknown) => scale(num(v), k)
      const band = (b: J | null) => (b ? { low: p(b.low), high: p(b.high) } : null)
      return {
        symbol: sym,
        spot: p(raw.spot),
        as_of: str(raw.asOf),
        horizons: (raw.horizons as J[]).map((h) => ({
          label: String(h.label),
          calendar_days: num(h.calendarDays),
          through_date: str(h.throughDate),
          trading_days: num(h.tradingDays),
          expected_move_pct: num(h.expectedMovePct),
          band68: band(h.band68),
          band95: band(h.band95),
          held68_pct: num(h.held68Pct),
          held95_pct: num(h.held95Pct),
          sample_days: num(h.sampleDays),
          extrapolated: typeof h.extrapolated === 'boolean' ? h.extrapolated : null,
        })),
        interpretation: str(raw.interpretation),
        open_url: openUrl(raw, sym),
      }
    })
  }

  ivRank(symbol: string): Promise<IvRank> {
    return this.read('iv_rank', symbol, undefined, (sym) => {
      const raw = clone(ivFx) as J
      const rc = raw.recentChange as J | null
      return {
        symbol: sym,
        source: str(raw.source),
        iv_rank: num(raw.ivRank),
        zone: str(raw.ivRankZone),
        clamped: clampedOf(raw.ivRankClamped),
        as_of: str(raw.asOf),
        freshness: str(raw.freshness),
        interpretation: str(raw.interpretation),
        recent_change: rc
          ? {
              direction: str(rc.direction),
              points_change: num(rc.pointsChange),
              percent_change: num(rc.percentChange),
              sessions: num(rc.sessions),
              from_iv: num(rc.fromIv),
              to_iv: num(rc.toIv),
              from_date: str(rc.fromDate),
              to_date: str(rc.toDate),
              comparable_to_atm_iv: typeof rc.comparableToAtmIv === 'boolean' ? rc.comparableToAtmIv : null,
            }
          : null,
        reason: str(raw.reason),
        open_url: openUrl(raw, sym),
      }
    })
  }

  snapshot(symbol: string): Promise<TmSnapshot> {
    return this.read('snapshot', symbol, undefined, (sym, k) => {
      const raw = clone(snapFx) as J
      const legs = (raw.legs ?? {}) as J
      const p = (v: unknown) => scale(num(v), k)
      const q = legs.quality as J | null
      const g = legs.gamma as J | null
      const a = legs.apex as J | null
      const f = legs.flow as J | null
      const iv = legs.ivRank as J | null
      const mh = legs.marketHealth as J | null
      const nl = a?.nearestLevel as J | null | undefined
      return {
        symbol: sym,
        quality: q ? { quality_score: num(q.qualityScore), quality_score_out_of: num(q.qualityScoreOutOf), quality_label: str(q.qualityLabel), sector: str(q.sector) } : null,
        gamma: g
          ? {
              regime: str(g.regime),
              regime_summary: str(g.regimeSummary),
              gamma_flip_level: p(g.gammaFlipLevel),
              spot_vs_flip: str(g.spotVsFlip),
              spot_vs_flip_distance: str(g.spotVsFlipDistance),
              gamma_pocket: str(g.gammaPocket),
            }
          : null,
        apex: a
          ? {
              nearest_level: nl ? { strike: p(nl.strike), score: num(nl.score), score_out_of: num(nl.scoreOutOf), side: str(nl.side), distance_from_spot: str(nl.distanceFromSpot) } : null,
              dominant_level_strike: p(a.dominantLevelStrike),
              level_count: num(a.levelCount),
            }
          : null,
        flow: f ? { bias: str(f.bias), conviction: num(f.conviction), conviction_out_of: num(f.convictionOutOf), basis: str(f.basis), updated_at: str(f.updatedAt) } : null,
        iv_rank: iv
          ? { ...(iv.ivRankClamped !== undefined ? { clamped: clampedOf(iv.ivRankClamped) } : {}), iv_rank: num(iv.ivRank), iv_rank_out_of: num(iv.ivRankOutOf), iv_rank_zone: str(iv.ivRankZone), interpretation: str(iv.interpretation), source: str(iv.source), as_of: str(iv.asOf) }
          : null,
        market_health: mh
          ? {
              composite_score: num(mh.compositeScore),
              composite_score_max: num(mh.compositeScoreMax),
              composite_unit: str(mh.compositeUnit),
              label: str(mh.label),
              alert_count: num(mh.alertCount),
              watch_count: num(mh.watchCount),
              as_of: str(mh.asOf),
            }
          : null,
        missing: Array.isArray(raw.missing) ? (raw.missing as unknown[]).map(String) : [],
        open_url: openUrl(raw, sym),
      }
    })
  }
}

function scale(v: number | null, k: number): number | null {
  return v === null ? null : k === 1 ? v : Math.round(v * k * 100) / 100
}

function openUrl(raw: J, symbol: string): string | null {
  const u = str((raw.openInTraderMatrix as J | undefined)?.url)
  return u ? u.replace(/\/ticker-search\/[A-Z.]+\//, `/ticker-search/${symbol}/`) : null
}
