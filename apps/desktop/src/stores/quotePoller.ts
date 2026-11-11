import type { RhQuote } from '../lib/api'
import { isEquityTicker } from '../lib/symbols'

export const QUOTE_CHUNK = 20
export const POLL_MS = 5000
/** Hard cap on symbols per poll. 200 symbols = 10 Robinhood calls per 5 s = 2/s, under the 4/s ceiling. */
export const MAX_POLL_SYMBOLS = 200

/** Robinhood calls one poll costs (the Rust side chunks quotes by 20). */
export function callsPerPoll(symbols: number): number {
  return Math.ceil(symbols / QUOTE_CHUNK)
}

export function callsPerSecond(symbols: number, intervalMs = POLL_MS): number {
  return callsPerPoll(symbols) / (intervalMs / 1000)
}

/** Who gets quotes first when the list is cut at the cap: the ticket symbol, then positions, the chart, then the watchlist. */
export const OWNER_PRIORITY = ['ticket', 'positions', 'chart', 'watchlist'] as const

/** While the window is hidden and at least one alert is armed, the poller keeps going at this pace (webview timer throttling when hidden is unverified). */
export const HIDDEN_ARMED_MS = 15_000

export interface QuoteMeta {
  /** Epoch ms when the fetch that produced these quotes began. */
  startedAt: number
}

export interface PollerOptions {
  fetch: (symbols: string[]) => Promise<RhQuote[]>
  onQuotes: (q: RhQuote[], meta: QuoteMeta) => void
  /** True while at least one alert is armed: the poller then also runs (every 15 s) while the window is hidden. */
  hasArmedAlerts?: () => boolean
  onError?: (message: string) => void
  intervalMs?: number
  isHidden?: () => boolean
  maxSymbols?: number
}

/**
 * One shared quote poller: panes register the symbols they show, the poller unions them and makes ONE
 * batched `fetch` per tick. Skips ticks while the window is hidden, never overlaps requests, and
 * refreshes immediately when the window becomes visible again.
 */
export class QuotePoller {
  private owners = new Map<string, string[]>()
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight = false
  /** Bumped by clear(): a response that belongs to an older epoch is dropped. */
  private epoch = 0
  private kick: ReturnType<typeof setTimeout> | null = null
  private lastFetchAt = Number.NEGATIVE_INFINITY
  private readonly o: Required<Omit<PollerOptions, 'onError'>> & Pick<PollerOptions, 'onError'>

  constructor(opts: PollerOptions) {
    this.o = {
      intervalMs: POLL_MS,
      maxSymbols: MAX_POLL_SYMBOLS,
      isHidden: () => typeof document !== 'undefined' && document.hidden,
      hasArmedAlerts: () => false,
      ...opts,
    }
  }

  /** Every wanted symbol: priority owners first, then the rest in registration order; de-duplicated. */
  private all(): string[] {
    const seen = new Set<string>()
    const rank = (o: string) => {
      const i = (OWNER_PRIORITY as readonly string[]).indexOf(o)
      return i === -1 ? OWNER_PRIORITY.length : i
    }
    const order = [...this.owners.keys()].sort((a, b) => rank(a) - rank(b))
    for (const o of order) for (const s of this.owners.get(o)!) seen.add(s)
    return [...seen]
  }

  symbols(): string[] {
    return this.all().slice(0, this.o.maxSymbols)
  }

  /** More symbols are wanted than the cap allows (the tail is not quoted). */
  get truncated(): boolean {
    return this.all().length > this.o.maxSymbols
  }

  /** The pace right now: 15 s while hidden with an armed alert, else the normal interval. */
  currentIntervalMs(): number {
    return this.o.isHidden() && this.o.hasArmedAlerts() ? HIDDEN_ARMED_MS : this.o.intervalMs
  }

  get running(): boolean {
    return this.timer !== null
  }

  /** Replace the symbol list for `owner` (a pane id). An empty list removes it. */
  setOwner(owner: string, symbols: string[]): void {
    const before = this.symbols().join(',')
    const clean = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(isEquityTicker))]
    if (clean.length) this.owners.set(owner, clean)
    else this.owners.delete(owner)
    const after = this.symbols()
    if (after.length === 0) return this.stop()
    if (!this.timer) this.timer = setInterval(() => void this.tick(), this.o.intervalMs)
    // Coalesce: several panes registering in the same turn produce one batched fetch, not one each.
    if (after.join(',') !== before && !this.kick) {
      this.kick = setTimeout(() => {
        this.kick = null
        void this.tick()
      }, 0)
    }
  }

  /** Call when document visibility flips back to visible. */
  resume(): void {
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.kick) clearTimeout(this.kick)
    this.kick = null
  }

  clear(): void {
    this.owners.clear()
    this.epoch += 1
    this.inflight = false
    this.stop()
  }

  /** Returns true when a fetch was made. */
  async tick(): Promise<boolean> {
    const syms = this.symbols()
    if (this.inflight || syms.length === 0) return false
    const started = Date.now()
    if (this.o.isHidden()) {
      if (!this.o.hasArmedAlerts() || started - this.lastFetchAt < HIDDEN_ARMED_MS) return false
    }
    this.lastFetchAt = started
    this.inflight = true
    const epoch = this.epoch
    try {
      const q = await this.o.fetch(syms)
      if (epoch === this.epoch) this.o.onQuotes(q, { startedAt: started })
    } catch (e) {
      if (epoch === this.epoch) this.o.onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      if (epoch === this.epoch) this.inflight = false
    }
    return true
  }
}
