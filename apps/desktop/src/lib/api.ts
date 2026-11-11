import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { cleanTags, exportRowCount, NOTE_DEFAULT_LIMIT, NOTE_MAX_LIMIT, validateBody } from './journalRules'
import { validateEquity, validateOption } from './orderValidation'
import { explainVariants, fakeExplainReply } from './explainFake'
import { FakeThreads, type AppendOut, type NewMessage, type StoredMessage, type ThreadMeta } from './explainThreadsFake'
import { keyShapeError, providerInfo, validateBaseUrlText, validateHermesUrlText } from './llmProviders'
import { FakeTm } from './tmFake'
import { OPTION_ID, validateDescription, validateEmoji, validateListName, WATCH_MAX_SYMBOLS, WATCH_SYMBOL } from './watchRules'

export interface LayoutMeta {
  name: string
  updated_at: string
}
export interface BackendStatus {
  available: boolean
  backend: string
  detail: string
}

export interface VaultStatus {
  exists: boolean
  unlocked: boolean
  backend: string
}

export interface RhStatus {
  /** Credentials are present in the secret store (not a live server check). */
  connected: boolean
  expires_soon: boolean
  last_error: string | null
}
export interface RhAccount {
  account_number: string
  rhs_account_number: string | null
  rhc_account_number: string | null
  agentic_allowed: boolean
  option_level: string | null
  kind: string | null
  is_default: boolean
  unsettled_funds: number | null
  nickname: string | null
  brokerage_account_type: string | null
}
export interface RhPortfolio {
  total_value: number | null
  equity_value: number | null
  options_value: number | null
  cash: number | null
  buying_power: number | null
  currency: string | null
}
export interface RhPosition {
  symbol: string
  quantity: number | null
  average_buy_price: number | null
  shares_available_for_sells: number | null
  shares_held_for_sells: number | null
}
/**
 * One open option position (rh_option_positions), joined in Rust with the contract and quote.
 * UNITS: `quantity` is a positive contract count (side is in `side`); `average_price` is signed DOLLARS PER CONTRACT
 * (per-share premium x multiplier, negative for a credit received on a short); bid/ask/mark are PER SHARE.
 */
export interface RhOptionPosition {
  option_id: string
  chain_symbol: string
  expiration_date: string | null
  strike_price: number | null
  option_type: string | null
  side: string
  quantity: number
  average_price: number | null
  multiplier: number
  bid: number | null
  ask: number | null
  mark: number | null
  delta: number | null
  theta: number | null
  iv: number | null
  min_ticks: MinTicks | null
  pending_buy: number | null
  pending_sell: number | null
}
export interface RhOrderLeg {
  option_id: string | null
  side: string | null
  position_effect: string | null
  ratio_quantity: number | null
  expiration_date: string | null
  strike_price: number | null
  option_type: string | null
}
export interface RhOrder {
  id: string
  asset: string
  symbol: string | null
  side: string | null
  order_type: string | null
  state: string | null
  trigger: string | null
  quantity: number | null
  price: number | null
  stop_price: number | null
  average_price: number | null
  dollar_based_amount: number | null
  time_in_force: string | null
  created_at: string | null
  reject_reason: string | null
  legs: RhOrderLeg[]
}
export interface RhQuote {
  symbol: string
  bid_price: number | null
  ask_price: number | null
  last_trade_price: number | null
  previous_close: number | null
}
export interface RhBar {
  begins_at: string
  open_price: number | null
  high_price: number | null
  low_price: number | null
  close_price: number | null
  volume: number | null
}
export interface RhHistorical {
  symbol: string
  interval: string | null
  bounds: string | null
  bars: RhBar[]
}
/** One candle as stored in the local database (M11). ts = ms epoch UTC. */
export interface StoredCandle {
  ts: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}
export interface CandleStats {
  candles: number
  snapshots: number
  db_bytes: number
}
export interface RhOptionRow {
  instrument: {
    id: string
    chain_id: string
    chain_symbol?: string | null
    expiration_date: string | null
    strike_price: number | null
    option_type: string | null
  }
  quote: {
    instrument_id: string
    bid: number | null
    ask: number | null
    mark: number | null
    delta: number | null
    gamma: number | null
    theta: number | null
    vega: number | null
    rho: number | null
    implied_volatility: number | null
    open_interest: number | null
    volume: number | null
  } | null
}
/** Robinhood tick table: below_tick under cutoff_price, above_tick at or over it. Strings or numbers; all optional. */
export interface MinTicks {
  above_tick?: string | number | null
  below_tick?: string | number | null
  cutoff_price?: string | number | null
}
export interface RhOptionChain {
  chain: { id: string; symbol: string; expiration_dates: string[]; min_ticks?: MinTicks | null }
  rows: RhOptionRow[]
}
/** One report date from get_earnings_results (M13). `timing` is "am" (before market) or "pm" (after) when known. */
export interface EarningsEvent {
  date: string
  timing: string | null
  verified: boolean
}
/** Nearest upcoming report (date >= today) and the latest past one. Both null when the symbol has no usable row. */
export interface EarningsInfo {
  next: EarningsEvent | null
  last: EarningsEvent | null
}
export interface RhWatchlist {
  id: string
  display_name: string
  icon_emoji: string | null
  item_count: number | null
  owner_type: string | null
  /** Empty when the server sends null. An options list contains 'option_strategy'. */
  allowed_object_types: string[]
}
export function isOptionsList(w: Pick<RhWatchlist, 'allowed_object_types'> | null | undefined): boolean {
  return !!w && w.allowed_object_types.includes('option_strategy')
}
export interface RhOptionWatchItem {
  id: string
  name: string
  option_ids: string[]
  chain_symbol: string
  expiration_date: string | null
  strike_price: number | null
  contract_type: string | null
}
export interface RhOptionWatchlist {
  list_id: string
  items: RhOptionWatchItem[]
}
export interface RhWatchlistItem {
  object_id: string
  object_type: string
  symbol: string
}
export interface RhWatchlistContents {
  display_name: string
  items: RhWatchlistItem[]
}
export interface RhCapture {
  path: string
  count: number
  names: string[]
}

/** Mirrors EquityOrderArgs in src-tauri/src/rh/orders.rs (deny_unknown_fields: never add keys the Rust struct lacks). */
export interface EquityOrderArgs {
  account_number: string
  symbol: string
  side: string
  type: string
  quantity?: string | null
  dollar_amount?: string | null
  limit_price?: string | null
  stop_price?: string | null
  time_in_force?: string | null
  market_hours?: string | null
}
export interface OptionLegArgs {
  option_id: string
  side: string
  position_effect: string
  ratio_quantity: number
}
export interface OptionOrderArgs {
  account_number: string
  legs: OptionLegArgs[]
  quantity: string
  type?: string | null
  price?: string | null
  stop_price?: string | null
  time_in_force?: string | null
  market_hours?: string | null
  direction?: string | null
}
export interface ReviewOut {
  review_id: string
  kind: 'equity' | 'option'
  /** The review tool's whole `data` object. */
  echoed: Record<string, unknown>
  /** `{}` when clean. */
  order_checks: Record<string, unknown>
  customer_approval_required: boolean | null
  customer_approval_reason: string | null
  account_masked: string
  expires_in_secs: number
}
export type PlaceOutcome =
  | { kind: 'placed'; order: Record<string, unknown> }
  | { kind: 'awaiting_approval'; approval: Record<string, unknown> }
  /** retry_until: unix seconds after which an explicit retry is refused (absent from older cores). */
  | { kind: 'unknown'; message: string; retry_until?: number | null }
  | { kind: 'rejected'; message: string }
export interface RhApproval {
  approval_id: string
  account_number: string
  asset_class: string
  /** e.g. APPROVAL_STATE_PENDING */
  state: string
  created_at?: string
  expires_at?: string
  proposed_order?: Record<string, unknown>
}
export interface RhApprovalSetting {
  setting: { account_number: string; human_must_approve_trades: boolean; updated_at?: string }
}

/** Realized P&L bucket (src-tauri rh/types.rs RealizedPoint). Numbers can be null. */
export interface PnlBucket {
  start_time: string | null
  end_time: string | null
  realized_gain: number | null
  rate_of_realized_gain: number | null
  number_of_trades: number | null
}
export interface RhRealizedPnl {
  window: string | null
  total_returns: number | null
  /** Percent (10 = 10%). */
  total_rate_of_return: number | null
  data_points: PnlBucket[]
}
/** One closing trade. `trade_key` is derived in Rust from account + symbol + side + quantity + price + timestamp (see rh/pnl.rs). */
export interface RhPnlTrade {
  trade_key: string
  symbol: string
  side: string | null
  quantity: number | null
  price: number | null
  realized_gain: number | null
  timestamp: string | null
}
export interface RhPnlTrades {
  trades: RhPnlTrade[]
  /** Non-null: more trades exist beyond the pages read; pass it back as the cursor. */
  next_cursor: string | null
}
/** Spans get_pnl_trade_history accepts (the journal uses these for both reads). */
export const PNL_SPANS = ['week', 'month', '3month', 'ytd', 'all'] as const
export type PnlSpan = (typeof PNL_SPANS)[number]

/** Local journal note (SQLite). Mirrors src-tauri/src/journal.rs. */
export interface JournalNote {
  id: number
  created_at: string
  updated_at: string
  symbol: string | null
  account_masked: string | null
  trade_key: string | null
  body: string
  tags: string[]
}
/** deny_unknown_fields in Rust: only these keys. */
export interface NewJournalNote {
  symbol?: string | null
  account_masked?: string | null
  trade_key?: string | null
  body: string
  tags: string[]
}
export interface JournalFilter {
  symbol?: string | null
  trade_key?: string | null
  text?: string | null
  limit?: number | null
}
export interface JournalExport {
  path: string
  rows: number
  /** More trades exist than the 5-page cap returned. */
  truncated: boolean
}

// ---- TraderMatrix (read-only; snake_case shapes exactly as the Rust tm_* commands return them) ----
export const TM_KEY_SLOT = 'tm_api_key'
export interface TmStatus {
  /** A key is stored (presence only: the value never reaches the webview). */
  key_present: boolean
  last_error: string | null
}
/** M8 watchlists. Tickers only: TM notes and added-at never leave the Rust core. */
export interface TmWatchlist {
  id: number
  name: string
  category: string | null
  is_default: boolean
  ticker_count: number
  /** Uppercased symbols. */
  tickers: string[]
}
export interface TmWatchlists {
  lists: TmWatchlist[]
  tickers_per_list: number | null
  tickers_across_all_lists: number | null
  max_lists: number | null
}
export interface TmAddOutcome {
  /** false = the symbol was already on the list (a success). */
  added: boolean
}
export interface TmWatchlistMeta {
  id: number
  name: string
  category: string | null
  is_default: boolean
}
export interface ApexLevel {
  strike: number | null
  score: number | null
  rank: number | null
  net_gex: number | null
  total_oi: number | null
  is_above_spot: boolean | null
}
export interface ApexLevels {
  symbol: string
  spot: number | null
  snapshot_time: string | null
  gamma_flip: number | null
  net_gex: number | null
  levels: ApexLevel[]
  expirations_used: string[]
  available_expirations: string[]
  open_url: string | null
}
export interface TmBand {
  low: number | null
  high: number | null
}
export interface TmHorizon {
  label: string
  calendar_days: number | null
  through_date: string | null
  trading_days: number | null
  /** Decimal fraction of spot: 0.036 is 3.6%. */
  expected_move_pct: number | null
  band68: TmBand | null
  band95: TmBand | null
  /** Decimal 0..1. */
  held68_pct: number | null
  held95_pct: number | null
  sample_days: number | null
  extrapolated: boolean | null
}
export interface ExpectedMove {
  symbol: string
  spot: number | null
  as_of: string | null
  horizons: TmHorizon[]
  interpretation: string | null
  open_url: string | null
}
export interface IvChange {
  direction: string | null
  points_change: number | null
  percent_change: number | null
  sessions: number | null
  from_iv: number | null
  to_iv: number | null
  from_date: string | null
  to_date: string | null
  comparable_to_atm_iv: boolean | null
}
export interface IvRank {
  symbol: string
  source: string | null
  /** 0..100. Never multiply by 100. */
  iv_rank: number | null
  zone: string | null
  /** 'below_band' | 'above_band' | null (older cores sent a boolean; treat anything else as absent). */
  clamped: string | null
  as_of: string | null
  freshness: string | null
  interpretation: string | null
  recent_change: IvChange | null
  reason: string | null
  open_url: string | null
}
export interface TmQualityLeg {
  quality_score: number | null
  quality_score_out_of: number | null
  quality_label: string | null
  sector: string | null
}
export interface TmGammaLeg {
  regime: string | null
  regime_summary: string | null
  gamma_flip_level: number | null
  spot_vs_flip: string | null
  spot_vs_flip_distance: string | null
  gamma_pocket: string | null
}
export interface TmNearestApex {
  strike: number | null
  score: number | null
  score_out_of: number | null
  side: string | null
  distance_from_spot: string | null
}
export interface TmApexLeg {
  nearest_level: TmNearestApex | null
  dominant_level_strike: number | null
  level_count: number | null
}
export interface TmFlowLeg {
  bias: string | null
  /** 0..1. */
  conviction: number | null
  conviction_out_of: number | null
  basis: string | null
  updated_at: string | null
}
export interface TmIvRankLeg {
  clamped?: string | null
  iv_rank: number | null
  iv_rank_out_of: number | null
  iv_rank_zone: string | null
  interpretation: string | null
  source: string | null
  as_of: string | null
}
export interface TmMarketHealthLeg {
  composite_score: number | null
  composite_score_max: number | null
  composite_unit: string | null
  label: string | null
  alert_count: number | null
  watch_count: number | null
  as_of: string | null
}
export interface TmSnapshot {
  symbol: string
  quality: TmQualityLeg | null
  gamma: TmGammaLeg | null
  apex: TmApexLeg | null
  flow: TmFlowLeg | null
  iv_rank: TmIvRankLeg | null
  market_health: TmMarketHealthLeg | null
  missing: string[]
  open_url: string | null
}

/** Slots the webview may manage (M14b: tm_api_key ONLY; the LLM key and config are written by llm_config_set, never by secret_set). */
export const WEBVIEW_SLOTS = ['tm_api_key'] as const
const MAX_LAYOUT_JSON = 1024 * 1024

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function validateName(name: string): void {
  const n = [...name].length
  if (n === 0 || n > 64) throw new Error('invalid input: layout name must be 1 to 64 characters')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('invalid input: layout name contains control characters')
  if (name.trim() !== name) throw new Error('invalid input: layout name has leading or trailing space')
}

/** Same identifier rules as candles.rs. */
function checkSeries(source: string, instrument: string, interval: string): void {
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(source)) throw new Error('invalid input: source is not valid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(instrument)) throw new Error('invalid input: instrument is not valid')
  if (!/^[A-Za-z0-9]{1,12}$/.test(interval)) throw new Error('invalid input: interval is not valid')
}

/** In-memory stand-in with the same validation rules as the Rust core. Used outside Tauri (tests, plain vite). */
class FakeBackend {
  layouts = new Map<string, { name: string; json: string; updated_at: string; seq: number }>()
  settings = new Map<string, string>()
  secrets = new Set<string>()
  seq = 0
  vault: { passphrase: string | null; unlocked: boolean } = { passphrase: null, unlocked: false }
  journal: JournalNote[] = []
  journalSeq = 0
  /** M11 in-memory stand-in for the candles / snapshots tables (same validation as candles.rs). */
  candles = new Map<string, StoredCandle & { fetched_at: number }>()
  snapshots = new Map<string, string>()

  candlesStore(source: string, instrument: string, interval: string, bars: StoredCandle[]): number {
    checkSeries(source, instrument, interval)
    if (bars.length > 5000) throw new Error('invalid input: at most 5000 candles per call')
    const maxTs = Date.now() + 86_400_000
    for (const b of bars) {
      const nums = [b.open, b.high, b.low, b.close, b.volume]
      if (!nums.every((v) => Number.isFinite(v) && v >= 0)) throw new Error('invalid input: candle values must be finite and not negative')
      if (b.high < b.low) throw new Error('invalid input: candle high is below its low')
      if (!Number.isFinite(b.ts) || b.ts < 946_684_800_000 || b.ts > maxTs) throw new Error('invalid input: candle timestamp is out of range')
    }
    const at = ++this.fetchSeq
    for (const b of bars) {
      const k = `${source}|${instrument}|${interval}|${b.ts}`
      const have = this.candles.get(k)
      if (!have || at > have.fetched_at) this.candles.set(k, { ...b, fetched_at: at })
    }
    return bars.length
  }
  fetchSeq = 0
  candlesLoad(source: string, instrument: string, interval: string, from: number, to: number, limit: number): StoredCandle[] {
    checkSeries(source, instrument, interval)
    if (!(limit >= 1 && limit <= 20_000)) throw new Error('invalid input: limit must be 1 to 20000')
    if (from > to) throw new Error('invalid input: from is after to')
    const rows = [...this.candles.entries()]
      .filter(([k, v]) => k.startsWith(`${source}|${instrument}|${interval}|`) && v.ts >= from && v.ts <= to)
      .map(([, v]) => ({ ts: v.ts, open: v.open, high: v.high, low: v.low, close: v.close, volume: v.volume }))
      .sort((a, b) => a.ts - b.ts)
    return rows.slice(Math.max(0, rows.length - limit))
  }
  snapshotStore(kind: string, key: string, json: string): void {
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(kind)) throw new Error('invalid input: kind is not valid')
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(key)) throw new Error('invalid input: key is not valid')
    if (new TextEncoder().encode(json).length > 16 * 1024) throw new Error('invalid input: snapshot is larger than 16 KB')
    try {
      JSON.parse(json)
    } catch {
      throw new Error('invalid input: snapshot is not valid JSON')
    }
    this.snapshots.set(`${kind}|${key}|${++this.fetchSeq}`, json)
  }
  candlesStats(): CandleStats {
    return { candles: this.candles.size, snapshots: this.snapshots.size, db_bytes: 4096 + this.candles.size * 72 + this.snapshots.size * 200 }
  }

  reset(): void {
    this.candles.clear()
    this.snapshots.clear()
    this.fetchSeq = 0
    this.journal = []
    this.journalSeq = 0
    this.layouts.clear()
    this.settings.clear()
    this.secrets.clear()
    this.seq = 0
    this.vault = { passphrase: null, unlocked: false }
    fakeRh.reset()
    fakeTm.reset()
    fakeExplain.reset()
    fakeThreads.reset()
    fakeLlm.reset()
  }

  vaultStatus(): VaultStatus {
    return { exists: this.vault.passphrase !== null, unlocked: this.vault.unlocked, backend: 'vault' }
  }
  vaultCreate(passphrase: string): void {
    if ([...passphrase].length < 8) throw new Error('invalid input: passphrase must be at least 8 characters')
    if (this.vault.passphrase !== null) throw new Error('invalid input: vault already exists; unlock it instead')
    this.vault = { passphrase, unlocked: true }
  }
  vaultUnlock(passphrase: string): void {
    if (this.vault.passphrase === null) throw new Error('vault file is missing')
    if (passphrase !== this.vault.passphrase) throw new Error('wrong vault passphrase')
    this.vault.unlocked = true
  }
  vaultLock(): void {
    this.vault.unlocked = false
  }

  // ---- journal (local data: this fake keeps the same validation and ordering as src-tauri/src/journal.rs) ----
  private noteSymbol(s: string | null | undefined): string | null {
    const t = (s ?? '').trim().toUpperCase()
    if (t === '') return null
    if (!WATCH_SYMBOL.test(t)) throw new Error('invalid input: symbol must be 1 to 10 characters: A-Z, 0-9, \'.\' or \'-\', starting with a letter')
    return t
  }
  private noteTags(tags: string[]): string[] {
    const c = cleanTags(tags)
    if (c.error) throw new Error(`invalid input: ${c.error}`)
    return c.tags
  }
  journalList(f: JournalFilter): JournalNote[] {
    const limit = f.limit ?? NOTE_DEFAULT_LIMIT
    if (limit < 1 || limit > NOTE_MAX_LIMIT) throw new Error('invalid input: limit must be 1 to 500')
    const sym = this.noteSymbol(f.symbol)
    const key = f.trade_key || null
    const text = (f.text ?? '').trim().toLowerCase()
    if ([...text].length > 200) throw new Error('invalid input: search text is too long')
    return this.journal
      .filter((n) => (sym === null || n.symbol === sym) && (key === null || n.trade_key === key))
      .filter((n) => text === '' || n.body.toLowerCase().includes(text) || n.tags.join(',').toLowerCase().includes(text) || (n.symbol ?? '').toLowerCase().includes(text))
      .sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit)
      .map((n) => ({ ...n, tags: [...n.tags] }))
  }
  journalAdd(n: NewJournalNote): JournalNote {
    const bad = validateBody(n.body)
    if (bad) throw new Error(`invalid input: ${bad}`)
    const tags = this.noteTags(n.tags ?? [])
    const symbol = this.noteSymbol(n.symbol)
    const key = n.trade_key || null
    if (key !== null && !/^[A-Za-z0-9_#-]{1,64}$/.test(key)) throw new Error('invalid input: trade key is not valid')
    const acct = n.account_masked || null
    if (acct !== null && [...acct].length > 32) throw new Error('invalid input: masked account is not valid')
    const now = new Date(Date.now() + this.journalSeq).toISOString()
    const row: JournalNote = { id: ++this.journalSeq, created_at: now, updated_at: now, symbol, account_masked: acct, trade_key: key, body: n.body, tags }
    this.journal.push(row)
    return { ...row, tags: [...tags] }
  }
  journalUpdate(id: number, body: string, tags: string[]): JournalNote {
    const bad = validateBody(body)
    if (bad) throw new Error(`invalid input: ${bad}`)
    const t = this.noteTags(tags)
    const row = this.journal.find((n) => n.id === id)
    if (!row) throw new Error(`not found: note ${id}`)
    row.body = body
    row.tags = t
    row.updated_at = new Date().toISOString()
    return { ...row, tags: [...t] }
  }
  /** Reads trades through the same path as the real export, merges notes, "writes" nothing. */
  journalExportCsv(span: string, account: string): JournalExport {
    const t = fakeRh.getPnlTrades(account, span, null, null)
    return { path: `/fake/exports/rebull-journal-${span}.csv`, rows: exportRowCount(this.journal, t.trades), truncated: t.next_cursor !== null }
  }
  journalDelete(id: number): void {
    const i = this.journal.findIndex((n) => n.id === id)
    if (i < 0) throw new Error(`not found: note ${id}`)
    this.journal.splice(i, 1)
  }

  layoutList(): LayoutMeta[] {
    return [...this.layouts.values()]
      .sort((a, b) => b.seq - a.seq)
      .map(({ name, updated_at }) => ({ name, updated_at }))
  }
  layoutSave(name: string, json: string): LayoutMeta {
    validateName(name)
    if (new TextEncoder().encode(json).length > MAX_LAYOUT_JSON) throw new Error('invalid input: layout json exceeds 1 MiB')
    try {
      JSON.parse(json)
    } catch (e) {
      throw new Error(`invalid input: layout json does not parse: ${String(e)}`)
    }
    const row = { name, json, updated_at: new Date().toISOString(), seq: ++this.seq }
    this.layouts.set(name.toLowerCase(), row)
    return { name: row.name, updated_at: row.updated_at }
  }
  layoutLoad(name: string): string | null {
    validateName(name)
    return this.layouts.get(name.toLowerCase())?.json ?? null
  }
  layoutDelete(name: string): void {
    validateName(name)
    this.layouts.delete(name.toLowerCase())
  }
  settingGet(k: string): string | null {
    return this.settings.get(k) ?? null
  }
  settingSet(k: string, v: string): void {
    if (!k || [...k].length > 128) throw new Error('invalid input: bad setting key')
    this.settings.set(k, v)
  }
  private slot(slot: string): void {
    if (!(WEBVIEW_SLOTS as readonly string[]).includes(slot)) throw new Error(`invalid input: unknown secret slot: ${slot}`)
  }
  secretSet(slot: string, v: string): void {
    this.slot(slot)
    if (!v) throw new Error('invalid input: secret value is empty')
    this.secrets.add(slot)
  }
  secretExists(slot: string): boolean {
    this.slot(slot)
    return this.secrets.has(slot)
  }
  secretDelete(slot: string): void {
    this.slot(slot)
    this.secrets.delete(slot)
  }
}

export const fake = new FakeBackend()
/** Fake TraderMatrix: the key is "present" exactly when the fake secret store holds the tm_api_key slot. */
export const fakeTm = new FakeTm(() => fake.secrets.has(TM_KEY_SLOT))

/** M14b fake provider config: same rules as src-tauri/src/llm/config.rs (sealed key + address, hosted URLs fixed, keyless providers hold no key). */
export interface LlmStatus {
  provider: string | null
  base_url: string | null
  model: string | null
  compat: boolean
  key_present: boolean
  /** Hermes only: the user accepted plain http to a private LAN address. */
  lan_http: boolean
}
export interface LlmDetect {
  claude_cli: boolean
  ollama: boolean
  lmstudio: boolean
}
const normUrl = (u: string) => u.trim().replace(/\/+$/, '')
/** Rust normalises Hermes addresses to end in /v1. */
const hermesBase = (id: string, u: string) => (id === 'hermes' ? (u.endsWith('/v1') ? u : `${u}/v1`) : u)
class FakeLlm {
  cfg: { provider: string; base_url: string | null; model: string | null; compat: boolean; lan_http: boolean } | null = null
  keyPresent = false
  detect: LlmDetect = { claude_cli: false, ollama: false, lmstudio: false }
  /** Every config_set call as the webview made it (key reduced to presence). */
  setCalls: { provider: string; baseUrl: string | null; hasKey: boolean; model: string | null; compat: boolean | null; lanHttp: boolean | null }[] = []
  testCalls = 0
  reset(): void {
    this.cfg = null
    this.keyPresent = false
    this.detect = { claude_cli: false, ollama: false, lmstudio: false }
    this.setCalls = []
    this.testCalls = 0
  }
  /** Ready to answer: a provider is chosen and, when it needs a key, one is saved. */
  ready(): boolean {
    if (!this.cfg) return false
    const p = providerInfo(this.cfg.provider)
    return !!p && (!p.needsKey || this.keyPresent)
  }
  status(): LlmStatus {
    if (!this.cfg) return { provider: null, base_url: null, model: null, compat: false, key_present: false, lan_http: false }
    const p = providerInfo(this.cfg.provider)!
    const base_url = !p.http ? null : p.urlEditable ? hermesBase(p.id, normUrl(this.cfg.base_url ?? p.baseUrl)) : p.baseUrl
    return { provider: this.cfg.provider, base_url, model: this.cfg.model || p.defaultModel || null, compat: this.cfg.compat, key_present: this.keyPresent, lan_http: this.cfg.lan_http }
  }
  set(provider: string, baseUrl: string | null, apiKey: string | null, model: string | null, compat: boolean | null, lanHttp: boolean | null = null): LlmStatus {
    this.setCalls.push({ provider, baseUrl, hasKey: !!apiKey, model, compat, lanHttp })
    const bad = () => new Error('bad_request')
    const p = providerInfo(provider)
    if (!p) throw bad()
    const old = this.cfg
    const same = old?.provider === provider
    const given = baseUrl?.trim() || null
    if (lanHttp === true && p.id !== 'hermes') throw bad()
    // Hermes: an acceptance carries over only while the address is left alone (same rule as config.rs)
    const lan = p.id === 'hermes' && (lanHttp ?? (same && !given && !!old?.lan_http))
    let newUrl: string | null = null
    if (!p.http) {
      if (given) throw bad()
    } else if (p.urlEditable) {
      newUrl = given ?? (same ? (old?.base_url ?? null) : null)
      const eff = newUrl ?? p.baseUrl
      if (p.id === 'hermes' ? !eff || validateHermesUrlText(eff, lan) !== null : !eff || validateBaseUrlText(eff) !== null) throw bad()
      if (p.id !== 'custom' && p.id !== 'hermes' && !/^http:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\])([:/]|$)/i.test(eff)) throw bad()
    } else if (given && normUrl(given) !== p.baseUrl) throw bad()
    const key = apiKey?.trim() || null
    if (!p.takesKey && key) throw bad()
    if (key && keyShapeError(p, key) !== null) throw bad()
    const oldP = old ? providerInfo(old.provider) : null
    const urlOf = (pp: typeof p | null, stored: string | null) => (!pp || !pp.http ? '' : pp.urlEditable ? hermesBase(pp.id, normUrl(stored ?? pp.baseUrl)) : pp.baseUrl)
    const changed = urlOf(p, newUrl) !== urlOf(oldP, old?.base_url ?? null)
    if (p.takesKey && this.keyPresent && !key && changed) throw bad()
    const m = model?.trim() || null
    if (m && !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,99}$/.test(m)) throw bad()
    this.cfg = { provider, base_url: newUrl, model: m ?? (same ? (old?.model ?? null) : null), compat: compat ?? (same ? (old?.compat ?? false) : false), lan_http: lan }
    if (key) this.keyPresent = true
    else if (!p.takesKey) this.keyPresent = false
    return this.status()
  }
  clear(): void {
    this.cfg = null
    this.keyPresent = false
  }
}
export const fakeLlm = new FakeLlm()

/** M14 fake explain backend: same fixed error codes as the Rust command; the reply is canned from the digest (no model is called). */
/** M16 B2: what the header meter shows (`explain_usage_summary`). */
export interface UsageSummary {
  session_tokens: number
  session_cap: number
  session_estimated: boolean
  month_usd: number
  month_cap: number
  month_tokens: number
  month_estimated: boolean
  month_unpriced: boolean
  price_known: boolean
}
/** What `explain_ask` returns (M16): the full reply (or the partial one after Stop), usage, and the SHA-256 of the digest that was sent. */
export interface AskOut {
  text: string
  usage: { prompt: number; completion: number; estimated: boolean }
  end: 'done' | 'cancelled'
  digest_hash: string
  model: string
  /** null = the model's price is unknown (never 0). */
  cost_usd: number | null
}
export type { AppendOut, NewMessage, StoredMessage, ThreadMeta } from './explainThreadsFake'

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** 64 lowercase hex characters derived from the text (FAKE only: Rust uses SHA-256). */
function fakeHash64(s: string): string {
  let out = ''
  for (let round = 0; round < 8; round++) {
    let h = 0x811c9dc5 ^ (round * 0x9e3779b1)
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out
}
/** Same parsing rules as `explain_usage::budgets`: a JSON number in range, else the default. */
function fakeBudgets(get: (k: string) => string | null): { session: number; month: number } {
  const num = (k: string): number | null => {
    const raw = get(k)
    if (raw == null) return null
    try {
      const v: unknown = JSON.parse(raw.trim())
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    } catch {
      return null
    }
  }
  const s = num('chat.budget.session_tokens')
  const m = num('chat.budget.month_usd')
  return { session: s != null && Number.isInteger(s) && s >= 1000 && s <= 10_000_000 ? s : 60_000, month: m != null && m > 0 && m <= 10_000 ? m : 2 }
}

class FakeExplain {
  /** '' = fine; otherwise the fixed code every call (and the Test button) fails with. */
  fail = ''
  delayMs = 0
  /** '' = the plain canned reply; otherwise one of `explainVariants` (dev page `?reply=`). */
  variant = ''
  /** Streaming simulation (M16 B1): 0 = the chunks arrive at once, otherwise the pause before each chunk. */
  chunkDelayMs = 0
  /** After a few chunks nothing more arrives until the idle watchdog (`idleMs`) ends the call as a timeout, or Stop. */
  stall = false
  idleMs = 15_000
  /** false = the provider cannot stream: one final delta. */
  canStream = true
  /** false = the provider reports no usage: chars/4, flagged estimated. */
  reportsUsage = true
  calls: { model: string; digest: string; question: string; history: { role: string; text: string }[]; mode: string; requestId: string }[] = []
  stopped: string[] = []
  deltaCount = 0
  sessionTokens = 0
  sessionEstimated = false
  monthUsd = 0
  monthTokens = 0
  monthEstimated = false
  monthUnpriced = false
  private stops = new Set<string>()
  private inflight: string | null = null
  reset(): void {
    this.fail = ''
    this.variant = ''
    this.delayMs = 0
    this.chunkDelayMs = 0
    this.stall = false
    this.idleMs = 15_000
    this.canStream = true
    this.reportsUsage = true
    this.calls = []
    this.stopped = []
    this.deltaCount = 0
    this.sessionTokens = 0
    this.sessionEstimated = false
    this.monthUsd = 0
    this.monthTokens = 0
    this.monthEstimated = false
    this.monthUnpriced = false
    this.stops.clear()
    this.inflight = null
  }
  /** The Stop button: only the in-flight request id counts (Rust ignores any other). */
  stop(requestId: string): void {
    if (this.inflight === requestId) {
      this.stops.add(requestId)
      this.stopped.push(requestId)
    }
  }
  private async wait(ms: number, id: string): Promise<void> {
    for (let left = ms; left > 0 && !this.stops.has(id); left -= 10) await sleepMs(Math.min(10, left))
  }
  private modelFor(model: string): { provider: string; model: string } {
    const st = fakeLlm.status()
    return { provider: st.provider ?? '', model: model || st.model || '' }
  }
  summary(resetSession: boolean): UsageSummary {
    if (resetSession) {
      this.sessionTokens = 0
      this.sessionEstimated = false
    }
    const b = fakeBudgets((k) => fake.settings.get(k) ?? null)
    const m = this.modelFor('')
    return {
      session_tokens: this.sessionTokens,
      session_cap: b.session,
      session_estimated: this.sessionEstimated,
      month_usd: this.monthUsd,
      month_cap: b.month,
      month_tokens: this.monthTokens,
      month_estimated: this.monthEstimated,
      month_unpriced: this.monthUnpriced,
      price_known: this.priced(m.provider, m.model),
    }
  }
  private priced(provider: string, model: string): boolean {
    return (provider === 'openrouter' && (model === 'deepseek/deepseek-v4-flash' || model === 'deepseek/deepseek-v4.1-flash')) || provider === 'ollama' || provider === 'lmstudio'
  }
  async ask(model: string, digest: string, question: string, history: { role: string; text: string }[], mode: string, requestId = 'r-compat', onDelta?: (t: string) => void): Promise<AskOut> {
    // Same order as Rust: the budgets are checked before anything is sent.
    const b = fakeBudgets((k) => fake.settings.get(k) ?? null)
    if (this.sessionTokens >= b.session || this.monthUsd >= b.month) throw new Error('budget')
    this.calls.push({ model, digest, question, history, mode, requestId })
    if (this.inflight) throw new Error('rate_limited') // one request at a time
    this.inflight = requestId
    try {
      if (this.delayMs > 0) await this.wait(this.delayMs, requestId)
      if (!fakeLlm.ready()) throw new Error('no_key')
      if (this.fail) throw new Error(this.fail)
      if ((model && !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,99}$/.test(model)) || history.length > 8 || [...question].length > 2000 || [...digest].length > (/(^|\n)BARS:/.test(digest) ? 8000 : 6000)) throw new Error('bad_request')
      if (mode !== 'beginner' && mode !== 'trader') throw new Error('bad_request') // Rust: closed enum
      const used = this.modelFor(model)
      const finish = (end: 'done' | 'cancelled', text: string, sent: boolean): AskOut => {
        const p = sent ? Math.ceil(([...digest].length + [...question].length + history.reduce((n, h) => n + [...h.text].length, 0) + 1400) / 4) : 0
        const c = sent ? Math.ceil([...text].length / 4) : 0
        const priced = this.priced(used.provider, used.model)
        const cost = priced ? (used.provider === 'openrouter' ? (p * 0.09 + c * 0.18) / 1e6 : 0) : null
        if (p + c > 0) {
          this.sessionTokens += p + c
          this.monthTokens += p + c
          if (!this.reportsUsage) {
            this.sessionEstimated = true
            this.monthEstimated = true
          }
          if (cost == null) this.monthUnpriced = true
          else this.monthUsd += cost
        }
        return { text, usage: { prompt: p, completion: c, estimated: !this.reportsUsage }, end, digest_hash: fakeHash64(digest), model: used.model, cost_usd: cost }
      }
      if (this.stops.has(requestId)) return finish('cancelled', '', false)
      const full = fakeExplainReply(digest, question, (explainVariants as readonly string[]).includes(this.variant) ? this.variant : undefined)
      let chunks = this.canStream ? (full.match(/\S+\s*/g) ?? [full]) : [full]
      if (this.stall) chunks = chunks.slice(0, 3)
      let acc = ''
      for (const ch of chunks) {
        if (this.chunkDelayMs > 0) await this.wait(this.chunkDelayMs, requestId)
        if (this.stops.has(requestId)) return finish('cancelled', acc, true)
        acc += ch
        this.deltaCount += 1
        onDelta?.(ch)
      }
      if (this.stall) {
        await this.wait(this.idleMs, requestId)
        if (this.stops.has(requestId)) return finish('cancelled', acc, true)
        finish('done', acc, true) // the tokens were spent even though the call ended as a timeout
        throw new Error('timeout')
      }
      return finish('done', acc, true)
    } finally {
      this.inflight = null
      this.stops.delete(requestId)
    }
  }
  async test(): Promise<void> {
    fakeLlm.testCalls += 1
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(this.delayMs, 600)))
    if (!fakeLlm.ready()) throw new Error('no_key')
    if (this.fail) throw new Error(this.fail)
  }
}
export const fakeExplain = new FakeExplain()
/** M16 B3 fake chat threads (reads the saveHistory setting from the fake settings table). */
export const fakeThreads = new FakeThreads((k) => fake.settings.get(k) ?? null)

const RH_ID = /^[A-Za-z0-9_-]{1,64}$/
const RH_SYMBOL = /^[A-Za-z0-9.-]{1,12}$/
export const RH_MAX_SYMBOLS = 400
/** Mirrors QUOTE_CHUNK in src-tauri/src/rh/reads.rs. */
export const RH_QUOTE_CHUNK = 20

interface FakeReview {
  id: string
  kind: 'equity' | 'option'
  args: EquityOrderArgs | OptionOrderArgs
  refId: string
  state: 'fresh' | 'unknown' | 'done'
  outcome: PlaceOutcome | null
}

/** Stand-in for the Robinhood commands: same argument rules and error text as the Rust core, no network. */
class FakeRh {
  connected = false
  connectError: string | null = null
  lastError: string | null = null
  accounts: RhAccount[] = []
  portfolios: Record<string, RhPortfolio> = {}
  positions: Record<string, RhPosition[]> = {}
  optionPositions: Record<string, RhOptionPosition[]> = {}
  /** Optional bid/ask per symbol for getQuotes (dev pages and tests); absent symbols quote bid/ask null. */
  touch: Record<string, { bid: number; ask: number }> = {}
  orders: Record<string, RhOrder[]> = {}
  watchlists: RhWatchlist[] = []
  items: Record<string, RhWatchlistItem[]> = {}
  optionItems: RhOptionWatchItem[] = []
  last: Record<string, number> = {}
  /** One entry per Robinhood call the quote path would make (chunks of 20). */
  quoteCalls: string[][] = []
  orderCalls: Array<{ account: string; state: string | null }> = []

  // ---- M7 watchlist writes / P&L (no network, no real list is touched) ----
  /** When set, every watchlist write and every P&L read throws this text (simulates a server error). */
  failWrite: string | null = null
  failPnl: string | null = null
  /** One entry per write that "reached the server" (after local validation). */
  writeLog: Array<{ tool: string; args: Record<string, unknown> }> = []
  /** Closing trades per account_number, most recent first. */
  pnlTrades: Record<string, RhPnlTrade[]> = {}
  /** Trades per page (the real tool pages by cursor; the Rust core reads up to 5 pages). */
  pnlPage = 50
  pnlCalls: Array<{ tool: string; account: string; span: string; cursor: string | null }> = []

  // ---- order simulation (no network, no real order) ----
  /** true: place returns an approval; false: place returns an order; null: the review omits the flag (and place acts as true). */
  approvalsOn: boolean | null = true
  /** Inject an order_checks alert into every review. */
  alert = false
  /** The next N place sends end in an Unknown outcome (transport failure). */
  failPlace = 0
  /** When set, place answers with a Rejected outcome carrying this text. */
  rejectPlace: string | null = null
  /** State of an order placed with approvals off ('queued' normally; 'rejected' shows the "not accepted" card). */
  placedState = 'queued'
  /** Seconds an Unknown outcome stays retryable (the Rust core uses 600). */
  retryWindowSecs = 600
  reviews = new Map<string, FakeReview>()
  /** One entry per place request that "reached the server". */
  placeLog: Array<{ reviewId: string; refId: string }> = []
  approvalList: RhApproval[] = []
  optionChains: Record<string, RhOptionChain> = {}
  /** Earnings per symbol for the fake `rh_earnings` (dev pages and tests). A symbol that is absent answers "no usable row". */
  earningsBySymbol: Record<string, EarningsInfo> = {}
  /** One entry per `rh_earnings` call that passed validation. */
  earningsCalls: string[] = []
  /** When set, `rh_earnings` throws this text. */
  failEarnings: string | null = null
  private idSeq = 0

  reset(): void {
    Object.assign(this, new FakeRh())
  }

  private need(): void {
    if (!this.connected) throw new Error('not connected to Robinhood')
  }
  private account(a: string): void {
    if (!RH_ID.test(a)) throw new Error('protocol error: invalid argument: account')
  }

  status(): RhStatus {
    return { connected: this.connected, expires_soon: false, last_error: this.lastError }
  }
  connect(): void {
    if (this.connectError) throw new Error(this.connectError)
    this.connected = true
  }
  disconnect(): void {
    this.connected = false
  }
  getAccounts(): RhAccount[] {
    this.need()
    return this.accounts
  }
  getPortfolio(a: string): RhPortfolio {
    this.need()
    this.account(a)
    return this.portfolios[a] ?? { total_value: null, equity_value: null, options_value: null, cash: null, buying_power: null, currency: null }
  }
  getPositions(a: string): RhPosition[] {
    this.need()
    this.account(a)
    return this.positions[a] ?? []
  }
  getOptionPositions(a: string): RhOptionPosition[] {
    this.need()
    this.account(a)
    return this.optionPositions[a] ?? []
  }
  getOrders(a: string, state: string | null): RhOrder[] {
    this.need()
    this.account(a)
    this.orderCalls.push({ account: a, state })
    return (this.orders[a] ?? []).filter((o) => !state || o.state === state)
  }
  getQuotes(symbols: string[]): RhQuote[] {
    this.need()
    if (symbols.length > RH_MAX_SYMBOLS) throw new Error('protocol error: invalid argument: too many symbols')
    if (!symbols.every((s) => RH_SYMBOL.test(s))) throw new Error('protocol error: invalid argument: symbol')
    for (let i = 0; i < symbols.length; i += RH_QUOTE_CHUNK) this.quoteCalls.push(symbols.slice(i, i + RH_QUOTE_CHUNK))
    return symbols.map((symbol) => ({
      symbol,
      bid_price: this.touch[symbol]?.bid ?? null,
      ask_price: this.touch[symbol]?.ask ?? null,
      last_trade_price: this.last[symbol] ?? null,
      previous_close: null,
    }))
  }
  private nextId(prefix: string): string {
    this.idSeq += 1
    return `${prefix}-${String(this.idSeq).padStart(12, '0')}`
  }
  private uuid(): string {
    this.idSeq += 1
    return `00000000-0000-4000-8000-${this.idSeq.toString(16).padStart(12, '0')}`
  }
  private agentic(account: string): void {
    const a = this.accounts.find((x) => x.account_number === account)
    if (!a || !a.agentic_allowed)
      throw new Error(
        `invalid input: account ${'\u2022\u2022\u2022\u2022' + account.slice(-4)} is not enabled for agent trading (agentic_allowed is false); orders can only be reviewed and placed on agentic accounts`,
      )
  }
  private strict(args: object, allowed: readonly string[]): void {
    for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new Error(`invalid input: unknown field \`${k}\``)
  }
  private reviewOut(id: string, kind: 'equity' | 'option', account: string, echoed: Record<string, unknown>): ReviewOut {
    const order_checks = this.alert
      ? { alert_type: 'BUYING_POWER_ALERT', buying_power_alert: { message: 'FAKE alert: this order may exceed your buying power.' } }
      : {}
    const required = this.approvalsOn
    return {
      review_id: id,
      kind,
      echoed: { ...echoed, order_checks, customer_approval_required: required },
      order_checks,
      customer_approval_required: required,
      customer_approval_reason: required === true ? 'account_setting' : null,
      account_masked: '\u2022\u2022\u2022\u2022' + account.slice(-4),
      expires_in_secs: 300,
    }
  }
  reviewEquity(a: EquityOrderArgs): ReviewOut {
    this.need()
    this.strict(a, ['account_number', 'symbol', 'side', 'type', 'quantity', 'dollar_amount', 'limit_price', 'stop_price', 'time_in_force', 'market_hours'])
    const bad = validateEquity(a)
    if (bad) throw new Error(`invalid input: ${bad}`)
    this.agentic(a.account_number)
    const id = this.nextId('review')
    this.reviews.set(id, { id, kind: 'equity', args: a, refId: this.uuid(), state: 'fresh', outcome: null })
    const last = this.last[a.symbol] ?? 100
    const q = { symbol: a.symbol, bid_price: (last - 0.05).toFixed(2), ask_price: (last + 0.05).toFixed(2), last_trade_price: last.toFixed(2) }
    const { account_number: _acct, ...order } = a
    void _acct
    return this.reviewOut(id, 'equity', a.account_number, {
      account_number: a.account_number,
      ...Object.fromEntries(Object.entries(order).filter(([, v]) => v !== null && v !== undefined)),
      quote_data: q,
      market_data_disclosure: 'FAKE data: no real quote, no real order.',
    })
  }
  reviewOption(a: OptionOrderArgs): ReviewOut {
    this.need()
    this.strict(a, ['account_number', 'legs', 'quantity', 'type', 'price', 'stop_price', 'time_in_force', 'market_hours', 'direction'])
    for (const l of a.legs) this.strict(l, ['option_id', 'side', 'position_effect', 'ratio_quantity'])
    const bad = validateOption(a)
    if (bad) throw new Error(`invalid input: ${bad}`)
    this.agentic(a.account_number)
    const id = this.nextId('review')
    this.reviews.set(id, { id, kind: 'option', args: a, refId: this.uuid(), state: 'fresh', outcome: null })
    const rows = Object.values(this.optionChains).flatMap((c) => c.rows)
    const option_quotes = a.legs.map((l) => {
      const q = rows.find((r) => r.instrument.id === l.option_id)?.quote
      return { option_id: l.option_id, bid_price: q?.bid?.toFixed(2) ?? '0.00', ask_price: q?.ask?.toFixed(2) ?? '0.00', delta: q?.delta?.toFixed(2) ?? '0.00' }
    })
    const px = Number(a.price ?? '0')
    const mult = Number(a.quantity) * 100
    return this.reviewOut(id, 'option', a.account_number, {
      account_number: a.account_number,
      type: a.type ?? 'limit',
      quantity: a.quantity,
      price: a.price,
      time_in_force: a.time_in_force ?? 'gfd',
      market_hours: a.market_hours ?? 'regular_hours',
      legs: a.legs,
      option_quotes,
      fees: { total_fee: '0.03' },
      collateral: { cash: { amount: (px * mult).toFixed(2), direction: a.legs[0]?.side === 'buy' ? 'debit' : 'credit', infinite: false }, equities: [] },
      market_data_disclosure: 'FAKE data: no real quote, no real order.',
    })
  }
  placeOrder(reviewId: string): PlaceOutcome {
    this.need()
    const r = this.reviews.get(reviewId)
    if (!r) throw new Error('invalid input: unknown review id; review the order again')
    // Single-use: a finished review replays its outcome without a request; Unknown may be re-sent with the SAME ref id.
    if (r.state === 'done' && r.outcome) return r.outcome
    this.placeLog.push({ reviewId: r.id, refId: r.refId })
    let out: PlaceOutcome
    if (this.failPlace > 0) {
      this.failPlace -= 1
      r.state = 'unknown'
      // Contract: unknown carries retry_until (unix seconds, 600 s after the first send) so the UI can disable Retry.
      return { kind: 'unknown', message: 'Connection reset while sending the order.', retry_until: Math.floor(Date.now() / 1000) + this.retryWindowSecs }
    }
    if (this.rejectPlace !== null) {
      out = { kind: 'rejected', message: this.rejectPlace }
    } else if (this.approvalsOn !== false) {
      const approval: RhApproval = {
        approval_id: this.nextId('appr'),
        account_number: r.args.account_number,
        asset_class: r.kind === 'equity' ? 'ASSET_CLASS_EQUITY' : 'ASSET_CLASS_OPTION',
        state: 'APPROVAL_STATE_PENDING',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        proposed_order: this.proposed(r),
      }
      this.approvalList.unshift(approval)
      out = { kind: 'awaiting_approval', approval: { ...approval } }
    } else {
      const id = this.uuid()
      const placed = this.orderOf(id, r)
      placed.state = this.placedState
      this.orders[r.args.account_number] = [placed, ...(this.orders[r.args.account_number] ?? [])]
      out = { kind: 'placed', order: { id, state: this.placedState, ref_id: r.refId, symbol: r.kind === 'equity' ? (r.args as EquityOrderArgs).symbol : undefined } }
    }
    r.state = 'done'
    r.outcome = out
    return out
  }
  private proposed(r: FakeReview): Record<string, unknown> {
    if (r.kind === 'equity') {
      const a = r.args as EquityOrderArgs
      return { symbol: a.symbol, side: a.side, order_type: a.type, quantity: a.quantity ?? undefined, limit_price: a.limit_price ?? undefined }
    }
    const a = r.args as OptionOrderArgs
    // The real server sends a money object for some limit prices; the equity path above keeps the plain string.
    return { quantity: a.quantity, limit_price: a.price ? { amount: a.price, currency_code: 'USD' } : undefined, side: a.legs[0]?.side, legs: a.legs.length }
  }
  private orderOf(id: string, r: FakeReview): RhOrder {
    const base = { id, state: 'queued', average_price: null, created_at: new Date().toISOString(), reject_reason: null, legs: [] }
    // Contract: order_type stays the raw upstream type (market|limit); a stop shows as trigger 'stop' + stop_price.
    const raw = (t: string | null | undefined): { order_type: string; trigger: string } => {
      const ty = t ?? 'limit'
      return ty === 'stop_limit' ? { order_type: 'limit', trigger: 'stop' } : ty === 'stop_market' ? { order_type: 'market', trigger: 'stop' } : { order_type: ty, trigger: 'immediate' }
    }
    if (r.kind === 'equity') {
      const a = r.args as EquityOrderArgs
      return {
        ...base, ...raw(a.type), stop_price: a.stop_price ? Number(a.stop_price) : null,
        asset: 'equity', symbol: a.symbol, side: a.side, quantity: a.quantity ? Number(a.quantity) : null,
        price: a.limit_price ? Number(a.limit_price) : null, dollar_based_amount: a.dollar_amount ? Number(a.dollar_amount) : null, time_in_force: a.time_in_force ?? 'gfd',
      }
    }
    const a = r.args as OptionOrderArgs
    return {
      ...base, ...raw(a.type), stop_price: a.stop_price ? Number(a.stop_price) : null,
      asset: 'option', symbol: null, side: a.legs[0]?.side === 'sell' ? 'credit' : 'debit', quantity: Number(a.quantity),
      price: a.price ? Number(a.price) : null, dollar_based_amount: null, time_in_force: a.time_in_force ?? 'gfd',
    }
  }
  cancel(account: string, orderId: string): boolean {
    this.need()
    this.account(account)
    if (!/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(orderId)) throw new Error('invalid input: order id must be an order UUID')
    const o = (this.orders[account] ?? []).find((x) => x.id === orderId)
    if (!o) throw new Error('tool error: order not found')
    o.state = 'cancelled'
    return true
  }
  approvalSetting(account: string): RhApprovalSetting {
    this.need()
    this.account(account)
    return { setting: { account_number: account, human_must_approve_trades: this.approvalsOn !== false, updated_at: '2026-11-09T12:00:00Z' } }
  }
  approvals(account: string, state: string | null): { approvals: RhApproval[] } {
    this.need()
    this.account(account)
    if (state !== null && !['pending', 'approved', 'declined', 'expired', 'auto_approved'].includes(state))
      throw new Error('invalid input: approval state must be pending, approved, declined, expired or auto_approved')
    const want = `APPROVAL_STATE_${(state ?? 'pending').toUpperCase()}`
    return { approvals: this.approvalList.filter((a) => a.account_number === account && a.state === want).map((a) => ({ ...a })) }
  }
  declineApproval(account: string, id: string): { result: unknown } {
    this.need()
    this.account(account)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid input: approval id is not valid')
    const a = this.approvalList.find((x) => x.approval_id === id && x.account_number === account)
    if (!a || a.state !== 'APPROVAL_STATE_PENDING') throw new Error('tool error: approval is not pending')
    a.state = 'APPROVAL_STATE_DECLINED'
    return { result: 'declined' }
  }
  getOptionChain(symbol: string, expiration: string | null): RhOptionChain {
    this.need()
    const c = this.optionChains[symbol]
    if (!c) throw new Error('rh_option_chain is not available outside Tauri')
    return { chain: c.chain, rows: expiration ? c.rows.filter((r) => r.instrument.expiration_date === expiration) : [] }
  }
  /** M13 read: same symbol grammar as the Rust core (`check_symbols`), nothing sent for an invalid one. */
  getEarnings(symbol: string): EarningsInfo {
    this.need()
    if (!/^[A-Za-z0-9.-]{1,12}$/.test(symbol)) throw new Error('protocol error: invalid argument: symbol')
    this.earningsCalls.push(symbol)
    if (this.failEarnings) throw new Error(this.failEarnings)
    return this.earningsBySymbol[symbol] ?? { next: null, last: null }
  }
  getWatchlists(): RhWatchlist[] {
    this.need()
    return this.watchlists
  }
  getWatchlistItems(id: string): RhWatchlistContents {
    this.need()
    if (!RH_ID.test(id)) throw new Error('protocol error: invalid argument: watchlist id')
    const w = this.watchlists.find((x) => x.id === id)
    if (isOptionsList(w))
      throw new Error(
        'tool error: API error 400: {"non_field_errors":["load_all_attributes is not supported for options watchlist"]}',
      )
    return { display_name: w?.display_name ?? '', items: this.items[id] ?? [] }
  }
  // ---- M7 watchlist writes (same refusals and error text as src-tauri/src/rh/watch_writes.rs) ----
  private writable(id: string, equity: boolean): RhWatchlist {
    this.need()
    if (!RH_ID.test(id)) throw new Error('invalid input: watchlist id is not valid')
    const w = this.watchlists.find((x) => x.id === id)
    if (!w) throw new Error('invalid input: watchlist not found')
    if (w.owner_type !== 'custom') throw new Error('invalid input: this is a Robinhood list you follow (read-only); only lists you created can be changed')
    if (isOptionsList(w))
      throw new Error(
        equity
          ? 'invalid input: this is the options watchlist: stocks cannot be added to it, and contracts go through the option tools'
          : 'invalid input: the options watchlist cannot be renamed here',
      )
    return w
  }
  private writeFails(): void {
    if (this.failWrite !== null) throw new Error(this.failWrite)
  }
  private watchSymbols(symbols: string[]): string[] {
    if (symbols.length === 0) throw new Error('invalid input: no symbols given')
    if (symbols.length > WATCH_MAX_SYMBOLS) throw new Error('invalid input: at most 50 symbols per call')
    const out: string[] = []
    for (const r of symbols) {
      const u = r.trim().toUpperCase()
      if (!WATCH_SYMBOL.test(u)) throw new Error('invalid input: symbols must be 1 to 10 characters (crypto and index ids are not supported)')
      if (!out.includes(u)) out.push(u)
    }
    return out
  }
  createWatchlist(name: string, emoji: string | null, description: string | null): { watchlist: RhWatchlist } {
    this.need()
    const bad = validateListName(name) || validateEmoji(emoji ?? '') || validateDescription(description ?? '')
    if (bad) throw new Error(`invalid input: ${bad}`)
    this.writeFails()
    const n = name.trim()
    this.writeLog.push({ tool: 'create_watchlist', args: { display_name: n } })
    if (this.watchlists.some((w) => w.display_name.toLowerCase() === n.toLowerCase()))
      throw new Error('tool error: API error 400: {"non_field_errors":["The fields owner, display_name must make a unique set."]}')
    const w: RhWatchlist = { id: this.uuid(), display_name: n, icon_emoji: (emoji ?? '').trim() || null, item_count: 0, owner_type: 'custom', allowed_object_types: ['instrument'] }
    this.watchlists = [...this.watchlists, w]
    this.items[w.id] = []
    return { watchlist: { ...w } }
  }
  updateWatchlist(id: string, name: string | null, emoji: string | null, description: string | null): { watchlist: RhWatchlist } {
    const w = this.writable(id, false)
    const n = (name ?? '').trim()
    if (n === '' && (emoji ?? '').trim() === '' && (description ?? '').trim() === '') throw new Error('invalid input: nothing to change: give a name, an emoji or a description')
    const bad = (n === '' ? '' : validateListName(n)) || validateEmoji(emoji ?? '') || validateDescription(description ?? '')
    if (bad) throw new Error(`invalid input: ${bad}`)
    this.writeFails()
    this.writeLog.push({ tool: 'update_watchlist', args: { list_id: id } })
    const next = { ...w, display_name: n || w.display_name, icon_emoji: (emoji ?? '').trim() || w.icon_emoji }
    this.watchlists = this.watchlists.map((x) => (x.id === id ? next : x))
    return { watchlist: { ...next } }
  }
  addToWatchlist(id: string, symbols: string[]): Record<string, unknown> {
    const syms = this.watchSymbols(symbols)
    if (!RH_ID.test(id)) throw new Error('invalid input: watchlist id is not valid')
    this.writable(id, true)
    this.writeFails()
    this.writeLog.push({ tool: 'add_to_watchlist', args: { list_id: id, symbols: syms } })
    const cur = this.items[id] ?? []
    for (const s of syms) if (!cur.some((i) => i.symbol === s)) cur.push({ object_id: `obj-${s}`, object_type: 'instrument', symbol: s })
    this.items[id] = cur
    this.watchlists = this.watchlists.map((w) => (w.id === id ? { ...w, item_count: cur.length } : w))
    return { list_id: id, object_type: 'instrument', operation: 'create', status: 'ok', symbols: syms }
  }
  removeFromWatchlist(id: string, symbols: string[]): Record<string, unknown> {
    const syms = this.watchSymbols(symbols)
    if (!RH_ID.test(id)) throw new Error('invalid input: watchlist id is not valid')
    this.writable(id, true)
    this.writeFails()
    this.writeLog.push({ tool: 'remove_from_watchlist', args: { list_id: id, symbols: syms } })
    const cur = (this.items[id] ?? []).filter((i) => !syms.includes(i.symbol))
    this.items[id] = cur
    this.watchlists = this.watchlists.map((w) => (w.id === id ? { ...w, item_count: cur.length } : w))
    return { list_id: id, object_type: 'instrument', operation: 'delete', status: 'ok', symbols: syms }
  }
  private optionIds(ids: string[]): string[] {
    if (ids.length === 0) throw new Error('invalid input: no option contracts given')
    if (ids.length > 20) throw new Error('invalid input: at most 20 option contracts per call')
    if (!ids.every((i) => OPTION_ID.test(i))) throw new Error('invalid input: option contract ids must be UUIDs')
    return [...new Set(ids.map((i) => i.toLowerCase()))]
  }
  addOptionToWatchlist(ids: string[]): Record<string, unknown> {
    this.need()
    const clean = this.optionIds(ids)
    this.writeFails()
    this.writeLog.push({ tool: 'add_option_to_watchlist', args: { option_ids: clean } })
    return { operation: 'create', option_ids: clean, position_type: 'long', status: 'ok' }
  }
  removeOptionFromWatchlist(ids: string[]): Record<string, unknown> {
    this.need()
    const clean = this.optionIds(ids)
    this.writeFails()
    this.writeLog.push({ tool: 'remove_option_from_watchlist', args: { option_ids: clean } })
    this.optionItems = this.optionItems.filter((o) => !o.option_ids.some((x) => clean.includes(x.toLowerCase())))
    return { operation: 'delete', option_ids: clean, position_type: 'long', status: 'ok' }
  }

  // ---- M7 P&L reads (the real tools take the rhs_account_number; an account without one is refused) ----
  private rhs(account: string): string {
    this.need()
    this.account(account)
    const a = this.accounts.find((x) => x.account_number === account)
    const masked = '\u2022\u2022\u2022\u2022' + account.slice(-4)
    if (!a) throw new Error(`invalid input: account ${masked} was not found`)
    if (!a.rhs_account_number) throw new Error(`invalid input: account ${masked} has no rhs_account_number, so realized P&L cannot be read for it`)
    return a.rhs_account_number
  }
  private inSpan(t: RhPnlTrade, span: string): boolean {
    if (span === 'all') return true
    const ts = t.timestamp ? Date.parse(t.timestamp) : NaN
    if (!Number.isFinite(ts)) return false
    const now = new Date()
    const start =
      span === 'ytd'
        ? Date.UTC(now.getUTCFullYear(), 0, 1)
        : now.getTime() - ({ day: 1, week: 7, month: 30, '3month': 92, year: 365 }[span] ?? 7) * 86_400_000
    return ts >= start
  }
  getRealizedPnl(account: string, span: string, assetClasses: string[]): RhRealizedPnl {
    this.rhs(account)
    if (!['day', 'week', 'month', '3month', 'ytd', 'year', 'all'].includes(span)) throw new Error('invalid input: span must be day, week, month, 3month, ytd, year or all')
    if (!assetClasses.every((c) => ['equity', 'option', 'crypto'].includes(c))) throw new Error('invalid input: asset class must be equity, option or crypto')
    this.pnlCalls.push({ tool: 'get_realized_pnl', account, span, cursor: null })
    if (this.failPnl !== null) throw new Error(this.failPnl)
    const trades = (this.pnlTrades[account] ?? []).filter((t) => this.inSpan(t, span))
    const byDay = new Map<string, RhPnlTrade[]>()
    for (const t of trades) {
      const d = (t.timestamp ?? '').slice(0, 10)
      byDay.set(d, [...(byDay.get(d) ?? []), t])
    }
    const data_points: PnlBucket[] = [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([d, ts]) => ({
        start_time: `${d}T00:00:00Z`,
        end_time: `${d}T23:59:59Z`,
        realized_gain: ts.some((t) => t.realized_gain !== null) ? ts.reduce((a, t) => a + (t.realized_gain ?? 0), 0) : null,
        rate_of_realized_gain: null,
        number_of_trades: ts.length,
      }))
    const total = trades.reduce((a, t) => a + (t.realized_gain ?? 0), 0)
    const cost = trades.reduce((a, t) => a + Math.abs((t.price ?? 0) * (t.quantity ?? 0)), 0)
    return { window: span, total_returns: total, total_rate_of_return: cost > 0 ? (total / cost) * 100 : null, data_points }
  }
  getPnlTrades(account: string, span: string, symbol: string | null, cursor: string | null): RhPnlTrades {
    this.rhs(account)
    if (!['week', 'month', '3month', 'ytd', 'all'].includes(span)) throw new Error('invalid input: span must be week, month, 3month, ytd or all')
    const sym = (symbol ?? '').trim().toUpperCase()
    if (sym !== '' && !WATCH_SYMBOL.test(sym)) throw new Error('invalid input: symbol must be 1 to 10 characters: A-Z, 0-9, \'.\' or \'-\', starting with a letter')
    if (cursor && (cursor.length > 512 || /\s/.test(cursor))) throw new Error('invalid input: cursor is not valid')
    this.pnlCalls.push({ tool: 'get_pnl_trade_history', account, span, cursor })
    if (this.failPnl !== null) throw new Error(this.failPnl)
    const all = (this.pnlTrades[account] ?? []).filter((t) => this.inSpan(t, span) && (sym === '' || t.symbol === sym))
    const start = cursor ? Number(cursor.replace(/^cur-/, '')) || 0 : 0
    // The Rust core reads up to 5 pages per call and reports the cursor to resume from.
    const end = Math.min(all.length, start + this.pnlPage * 5)
    return { trades: all.slice(start, end).map((t) => ({ ...t })), next_cursor: end < all.length ? `cur-${end}` : null }
  }
  getOptionWatchlist(): RhOptionWatchlist {
    this.need()
    const w = this.watchlists.find((x) => isOptionsList(x))
    return { list_id: w?.id ?? '', items: this.optionItems }
  }
}

export const fakeRh = new FakeRh()

const FAKE_INTERVAL_MS: Record<string, number> = {
  '15second': 15_000,
  '30second': 30_000,
  minute: 60_000,
  '5minute': 300_000,
  '10minute': 600_000,
  '30minute': 1_800_000,
  hour: 3_600_000,
  '4hour': 14_400_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  '3month': 7_776_000_000,
  '6month': 15_552_000_000,
  year: 31_536_000_000,
  '5year': 157_680_000_000,
  '10year': 315_360_000_000,
  '20year': 630_720_000_000,
  '50year': 1_576_800_000_000,
}
const FAKE_MAX_BARS = 2500
const DAY_MS = 86_400_000

function hash32(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}
/** Deterministic noise in [0, 1) from a seed and an integer. */
function unit(seed: number, i: number): number {
  let t = (seed + Math.imul(i | 0, 0x9e3779b1)) | 0
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
/** Smooth fake price level for a symbol at an absolute time (slow swings, so every interval agrees). */
export function fakePriceAt(symbol: string, t: number): number {
  const h = hash32(symbol.toUpperCase())
  const base = 40 + (h % 260)
  const d = t / DAY_MS
  return base * (1 + 0.12 * Math.sin(d / 40 + (h % 7)) + 0.05 * Math.sin(d / 6 + (h % 5)) + 0.01 * Math.sin(d * 3))
}

/** Seeded, deterministic stand-in for get_equity_historicals: same argument rules as the Rust core, no network. Symbol NOPE has no data. */
export function fakeHistoricals(symbol: string, interval: string | null, start: string): RhHistorical[] {
  if (!RH_SYMBOL.test(symbol)) throw new Error('protocol error: invalid argument: symbol')
  if (interval !== null && !(interval in FAKE_INTERVAL_MS)) throw new Error('protocol error: invalid argument: interval')
  if (!(start.length >= 10 && start.length <= 40 && /^\d{4}[0-9T:Z.+-]*$/.test(start)) || !Number.isFinite(Date.parse(start)))
    throw new Error('protocol error: invalid argument: start time')
  const iv = interval ?? 'day'
  const out: RhHistorical = { symbol, interval: iv, bounds: 'regular', bars: [] }
  if (symbol.toUpperCase() === 'NOPE') return [out]
  const step = FAKE_INTERVAL_MS[iv]!
  const last = Math.floor(Date.now() / step) * step
  let first = Math.ceil(Date.parse(start) / step) * step
  if (last - first > (FAKE_MAX_BARS - 1) * step) first = last - (FAKE_MAX_BARS - 1) * step
  const seed = hash32(`${symbol.toUpperCase()}|${iv}`)
  const sigma = Math.min(0.03, 0.0006 * Math.sqrt(step / 60_000))
  const round = (v: number) => Math.round(v * 10000) / 10000
  for (let t = first; t <= last; t += step) {
    const k = t / step
    const open = fakePriceAt(symbol, t) * (1 + sigma * (unit(seed, k * 4) - 0.5) * 2)
    const close = fakePriceAt(symbol, t + step) * (1 + sigma * (unit(seed, k * 4 + 1) - 0.5) * 2)
    const high = Math.max(open, close) * (1 + sigma * unit(seed, k * 4 + 2))
    const low = Math.min(open, close) * (1 - sigma * unit(seed, k * 4 + 3))
    out.bars.push({
      begins_at: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      open_price: round(open),
      high_price: round(high),
      low_price: round(low),
      close_price: round(close),
      volume: Math.round(1e5 * (0.5 + unit(seed, k * 4 + 5))),
    })
  }
  return [out]
}


const FAKE_OPTION_BOUNDS = ['regular', '24_5', '24_7']

/** Seeded stand-in for get_option_historicals: OHLC only (NO volume, as on the real server). The all-zero uuid is an unknown contract. */
export function fakeOptionHistoricals(optionId: string, interval: string | null, start: string, bounds: string | null = null): RhHistorical {
  if (!OPTION_ID.test(optionId)) throw new Error('protocol error: invalid argument: option id')
  if (bounds !== null && !FAKE_OPTION_BOUNDS.includes(bounds)) throw new Error('protocol error: invalid argument: bounds')
  if (optionId === '00000000-0000-0000-0000-000000000000') throw new Error('protocol error: option contract not found (expired, unknown or not licensed for history)')
  const base = fakeHistoricals('AAPL', interval, start)[0]!
  const scale = 0.03 // a premium is a small fraction of the underlying
  const r = (v: number) => Math.round(Math.max(0.01, v * scale) * 100) / 100
  return {
    symbol: 'AAPL  261113C00085000',
    interval: base.interval,
    bounds: bounds ?? 'regular',
    bars: base.bars.map((b) => {
      const hi = Math.max(r(b.high_price ?? 0), r(b.open_price ?? 0), r(b.close_price ?? 0))
      const lo = Math.min(r(b.low_price ?? 0), r(b.open_price ?? 0), r(b.close_price ?? 0))
      return { begins_at: b.begins_at, open_price: r(b.open_price ?? 0), high_price: hi, low_price: lo, close_price: r(b.close_price ?? 0), volume: null }
    }),
  }
}

/** Drops null/undefined keys so the Rust side (deny_unknown_fields, Option<String>) sees only real fields. */
function stripEmpty<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T
}

function call<T>(cmd: string, args: Record<string, unknown>, fallback: () => T): Promise<T> {
  if (isTauri()) return invoke<T>(cmd, args)
  try {
    return Promise.resolve(fallback())
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

/** Tauri path of explain_ask: listens for this request's `explain:delta` events while the command runs, then stops listening. */
async function askStreaming(args: { model: string; digest: string; question: string; history: { role: string; text: string }[]; mode: string; requestId: string }, onDelta?: (t: string) => void): Promise<AskOut> {
  let off: (() => void) | null = null
  try {
    off = await listen<{ request_id: string; text: string }>('explain:delta', (e) => {
      if (e.payload.request_id === args.requestId) onDelta?.(e.payload.text)
    })
  } catch {
    off = null // no event bridge: the answer still arrives whole from the command
  }
  try {
    return await invoke<AskOut>('explain_ask', args)
  } finally {
    off?.()
  }
}

function callAsync<T>(cmd: string, args: Record<string, unknown>, fallback: () => Promise<T>): Promise<T> {
  if (isTauri()) return invoke<T>(cmd, args)
  try {
    return fallback()
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

// Note: there is deliberately no secretGet, no exercise/replace/advanced/crypto call and no generic raw-call wrapper.
// The only write entry points are the typed order commands below: place takes a review id and nothing else, so the
// webview never sends a ref_id or a raw tool call. Secrets and tokens never reach the webview.
export const api = {
  layoutList: () => call<LayoutMeta[]>('layout_list', {}, () => fake.layoutList()),
  layoutSave: (name: string, json: string) => call<LayoutMeta>('layout_save', { name, json }, () => fake.layoutSave(name, json)),
  layoutLoad: (name: string) => call<string | null>('layout_load', { name }, () => fake.layoutLoad(name)),
  layoutDelete: (name: string) => call<void>('layout_delete', { name }, () => fake.layoutDelete(name)),
  settingGet: (k: string) => call<string | null>('setting_get', { key: k }, () => fake.settingGet(k)),
  settingSet: (k: string, v: string) => call<void>('setting_set', { key: k, value: v }, () => fake.settingSet(k, v)),
  secretSet: (slot: string, v: string) => call<void>('secret_set', { slot, value: v }, () => fake.secretSet(slot, v)),
  secretExists: (slot: string) => call<boolean>('secret_exists', { slot }, () => fake.secretExists(slot)),
  secretDelete: (slot: string) => call<void>('secret_delete', { slot }, () => fake.secretDelete(slot)),
  vaultStatus: () => call<VaultStatus>('vault_status', {}, () => fake.vaultStatus()),
  vaultCreate: (passphrase: string) => call<void>('vault_create', { passphrase }, () => fake.vaultCreate(passphrase)),
  vaultUnlock: (passphrase: string) => call<void>('vault_unlock', { passphrase }, () => fake.vaultUnlock(passphrase)),
  vaultLock: () => call<void>('vault_lock', {}, () => fake.vaultLock()),
  rhStatus: () => call<RhStatus>('rh_status', {}, () => fakeRh.status()),
  rhConnect: () => call<void>('rh_connect', {}, () => fakeRh.connect()),
  rhPendingLoginUrl: () => call<string | null>('rh_pending_login_url', {}, () => null),
  rhDisconnect: () => call<void>('rh_disconnect', {}, () => fakeRh.disconnect()),
  rhAccounts: () => call<RhAccount[]>('rh_accounts', {}, () => fakeRh.getAccounts()),
  rhPortfolio: (account: string) => call<RhPortfolio>('rh_portfolio', { account }, () => fakeRh.getPortfolio(account)),
  rhPositions: (account: string) => call<RhPosition[]>('rh_positions', { account }, () => fakeRh.getPositions(account)),
  /** Read-only: open option positions with strike, call/put and quote joined in Rust (M10). */
  rhOptionPositions: (account: string) =>
    call<RhOptionPosition[]>('rh_option_positions', { account }, () => fakeRh.getOptionPositions(account)),
  rhOrders: (account: string, state: string | null) =>
    call<RhOrder[]>('rh_orders', { account, state }, () => fakeRh.getOrders(account, state)),
  rhQuotes: (symbols: string[]) => call<RhQuote[]>('rh_quotes', { symbols }, () => fakeRh.getQuotes(symbols)),
  rhHistoricals: (symbol: string, interval: string | null, start: string) =>
    call<RhHistorical[]>('rh_historicals', { symbol, interval, start }, () => fakeHistoricals(symbol, interval, start)),
  rhOptionHistoricals: (optionId: string, interval: string | null, start: string, bounds: string | null = null) =>
    call<RhHistorical>('rh_option_historicals', { optionId, interval, start, bounds }, () => fakeOptionHistoricals(optionId, interval, start, bounds)),
  // M11 local storage: candles + sampled snapshots (SQLite in Rust, in-memory fake outside Tauri). No network, no tool names.
  candlesStore: (source: string, instrument: string, interval: string, bars: StoredCandle[]) =>
    call<number>('candles_store', { source, instrument, interval, bars }, () => fake.candlesStore(source, instrument, interval, bars)),
  candlesLoad: (source: string, instrument: string, interval: string, from: number, to: number, limit: number) =>
    call<StoredCandle[]>('candles_load', { source, instrument, interval, from, to, limit }, () => fake.candlesLoad(source, instrument, interval, from, to, limit)),
  snapshotStore: (kind: string, key: string, json: string) => call<void>('snapshot_store', { kind, key, json }, () => fake.snapshotStore(kind, key, json)),
  candlesStats: () => call<CandleStats>('candles_stats', {}, () => fake.candlesStats()),
  /** M13: next and last earnings date for one symbol (read-only get_earnings_results). */
  rhEarnings: (symbol: string) => call<EarningsInfo>('rh_earnings', { symbol }, () => fakeRh.getEarnings(symbol)),
  rhOptionChain: (symbol: string, expiration: string | null) =>
    call<RhOptionChain>('rh_option_chain', { symbol, expiration }, () => fakeRh.getOptionChain(symbol, expiration)),
  rhReviewEquityOrder: (args: EquityOrderArgs) =>
    call<ReviewOut>('rh_review_equity_order', { args: stripEmpty(args) }, () => fakeRh.reviewEquity(args)),
  rhReviewOptionOrder: (args: OptionOrderArgs) =>
    call<ReviewOut>('rh_review_option_order', { args: stripEmpty(args) }, () => fakeRh.reviewOption(args)),
  rhPlaceOrder: (reviewId: string) => call<PlaceOutcome>('rh_place_order', { reviewId }, () => fakeRh.placeOrder(reviewId)),
  rhCancelEquityOrder: (account: string, orderId: string) =>
    call<boolean>('rh_cancel_equity_order', { account, orderId }, () => fakeRh.cancel(account, orderId)),
  rhCancelOptionOrder: (account: string, orderId: string) =>
    call<boolean>('rh_cancel_option_order', { account, orderId }, () => fakeRh.cancel(account, orderId)),
  rhTradeApprovalSetting: (account: string) =>
    call<RhApprovalSetting>('rh_trade_approval_setting', { account }, () => fakeRh.approvalSetting(account)),
  rhTradeApprovals: (account: string, state: string | null) =>
    call<{ approvals: RhApproval[] }>('rh_trade_approvals', { account, state }, () => fakeRh.approvals(account, state)),
  rhDeclineTradeApproval: (account: string, approvalId: string) =>
    call<{ result: unknown }>('rh_decline_trade_approval', { account, approvalId }, () => fakeRh.declineApproval(account, approvalId)),
  rhWatchlists: () => call<RhWatchlist[]>('rh_watchlists', {}, () => fakeRh.getWatchlists()),
  rhOptionWatchlist: () => call<RhOptionWatchlist>('rh_option_watchlist', {}, () => fakeRh.getOptionWatchlist()),
  rhWatchlistItems: (listId: string) =>
    call<RhWatchlistContents>('rh_watchlist_items', { listId }, () => fakeRh.getWatchlistItems(listId)),
  rhWatchlistCreate: (name: string, emoji: string | null, description: string | null) =>
    call<Record<string, unknown>>('rh_watchlist_create', { name, emoji, description }, () => fakeRh.createWatchlist(name, emoji, description)),
  rhWatchlistUpdate: (listId: string, name: string | null, emoji: string | null, description: string | null) =>
    call<Record<string, unknown>>('rh_watchlist_update', { listId, name, emoji, description }, () => fakeRh.updateWatchlist(listId, name, emoji, description)),
  rhWatchlistAdd: (listId: string, symbols: string[]) =>
    call<Record<string, unknown>>('rh_watchlist_add', { listId, symbols }, () => fakeRh.addToWatchlist(listId, symbols)),
  rhWatchlistRemove: (listId: string, symbols: string[]) =>
    call<Record<string, unknown>>('rh_watchlist_remove', { listId, symbols }, () => fakeRh.removeFromWatchlist(listId, symbols)),
  rhOptionWatchlistAdd: (optionIds: string[]) =>
    call<Record<string, unknown>>('rh_option_watchlist_add', { optionIds }, () => fakeRh.addOptionToWatchlist(optionIds)),
  rhOptionWatchlistRemove: (optionIds: string[]) =>
    call<Record<string, unknown>>('rh_option_watchlist_remove', { optionIds }, () => fakeRh.removeOptionFromWatchlist(optionIds)),
  rhRealizedPnl: (account: string, span: string, assetClasses: string[] | null) =>
    call<RhRealizedPnl>('rh_realized_pnl', { account, span, assetClasses }, () => fakeRh.getRealizedPnl(account, span, assetClasses ?? [])),
  rhPnlTrades: (account: string, span: string, symbol: string | null, cursor: string | null) =>
    call<RhPnlTrades>('rh_pnl_trades', { account, span, symbol, cursor }, () => fakeRh.getPnlTrades(account, span, symbol, cursor)),
  journalList: (filter: JournalFilter) => call<JournalNote[]>('journal_list', { filter: stripEmpty(filter) }, () => fake.journalList(filter)),
  journalAdd: (note: NewJournalNote) => call<JournalNote>('journal_add', { note: stripEmpty(note) }, () => fake.journalAdd(note)),
  journalUpdate: (id: number, body: string, tags: string[]) => call<JournalNote>('journal_update', { id, body, tags }, () => fake.journalUpdate(id, body, tags)),
  journalDelete: (id: number) => call<void>('journal_delete', { id }, () => fake.journalDelete(id)),
  journalExportCsv: (span: string, account: string) =>
    call<JournalExport>('journal_export_csv', { span, account }, () => fake.journalExportCsv(span, account)),
  // TraderMatrix: four typed read-only calls plus key presence. The key is written with secretSet and never read back.
  tmStatus: () => call<TmStatus>('tm_status', {}, () => fakeTm.status()),
  tmApexLevels: (symbol: string, expiration?: string) =>
    callAsync<ApexLevels>('tm_apex_levels', { symbol, expiration: expiration ?? null }, () => fakeTm.apex(symbol, expiration)),
  tmExpectedMove: (symbol: string) => callAsync<ExpectedMove>('tm_expected_move', { symbol }, () => fakeTm.expectedMove(symbol)),
  tmIvRank: (symbol: string) => callAsync<IvRank>('tm_iv_rank', { symbol }, () => fakeTm.ivRank(symbol)),
  tmSnapshot: (symbol: string) => callAsync<TmSnapshot>('tm_snapshot', { symbol }, () => fakeTm.snapshot(symbol)),
  // M8 watchlist sync: list, add ONE symbol, create an empty list. There is deliberately no TM remove/delete/update wrapper.
  tmWatchlists: () => callAsync<TmWatchlists>('tm_watchlists', {}, () => fakeTm.watchlists()),
  tmWatchlistAdd: (list: string, ticker: string) => callAsync<TmAddOutcome>('tm_watchlist_add', { list, ticker }, () => fakeTm.watchlistAdd(list, ticker)),
  // M14 explain-only chat: one ask command. M14b: provider, address and key are saved by ONE command (llm_config_set); the key is never read back.
  // M16 B1: the reply streams as `explain:delta` events tagged with `requestId` (onDelta gets each piece); the returned AskOut is the authority.
  explainAsk: (model: string, digest: string, question: string, history: { role: string; text: string }[], mode: string, requestId = 'r-compat', onDelta?: (t: string) => void): Promise<AskOut> =>
    isTauri() ? askStreaming({ model, digest, question, history, mode, requestId }, onDelta) : fakeExplain.ask(model, digest, question, history, mode, requestId, onDelta),
  /** Stop: ends the in-flight request with this id (a no-op for any other id). */
  explainStop: (requestId: string) => callAsync<void>('explain_stop', { requestId }, async () => fakeExplain.stop(requestId)),
  explainUsageSummary: (resetSession: boolean) => callAsync<UsageSummary>('explain_usage_summary', { resetSession }, async () => fakeExplain.summary(resetSession)),
  explainThreadList: (symbol: string | null) => callAsync<ThreadMeta[]>('explain_thread_list', { symbol }, async () => fakeThreads.list(symbol)),
  explainThreadLoad: (threadId: number) => callAsync<StoredMessage[]>('explain_thread_load', { threadId }, async () => fakeThreads.load(threadId)),
  /** null in, null out when "save history" is off (nothing was written). */
  explainThreadAppend: (threadId: number | null, symbol: string, messages: NewMessage[]) =>
    callAsync<AppendOut | null>('explain_thread_append', { threadId, symbol, messages }, async () => fakeThreads.append(threadId, symbol, messages)),
  explainThreadDelete: (threadId: number, messageId: number | null) => callAsync<void>('explain_thread_delete', { threadId, messageId }, async () => fakeThreads.delete(threadId, messageId)),
  explainThreadDeleteAll: () => callAsync<void>('explain_thread_delete_all', {}, async () => fakeThreads.deleteAll()),
  explainThreadExport: (threadId: number | null) => callAsync<string>('explain_thread_export', { threadId }, async () => fakeThreads.exportMarkdown(threadId)),
  llmConfigSet: (provider: string, baseUrl: string | null, apiKey: string | null, model: string | null, compat: boolean | null, lanHttp: boolean | null = null) =>
    callAsync<LlmStatus>('llm_config_set', { provider, baseUrl, apiKey, model, compat, lanHttp }, async () => fakeLlm.set(provider, baseUrl, apiKey, model, compat, lanHttp)),
  llmConfigStatus: () => callAsync<LlmStatus>('llm_config_status', {}, async () => fakeLlm.status()),
  llmConfigClear: () => callAsync<void>('llm_config_clear', {}, async () => fakeLlm.clear()),
  llmTest: () => callAsync<void>('llm_test', {}, () => fakeExplain.test()),
  llmDetect: () => callAsync<LlmDetect>('llm_detect', {}, async () => ({ ...fakeLlm.detect })),
  tmWatchlistCreate: (name: string) => callAsync<TmWatchlistMeta>('tm_watchlist_create', { name }, () => fakeTm.watchlistCreate(name)),
  rhCaptureTools: () =>
    call<RhCapture>('rh_capture_tools', {}, () => {
      throw new Error('rh_capture_tools is not available outside Tauri')
    }),
  secretBackendStatus: () =>
    call<BackendStatus>('secret_backend_status', {}, () => ({
      available: false,
      backend: 'browser-fake',
      detail: 'not running inside Tauri',
    })),
}
