/**
 * Earnings dates (M13), read-only through `rh_earnings` (get_earnings_results). Per-symbol cache with a 5 minute TTL,
 * in-flight de-duplication, an epoch so a response that lands after a session wipe is dropped, and failures kept as an
 * error (the strike check then shows "-" for the event row; it never assumes "no earnings").
 */
import { create } from 'zustand'
import { api, type EarningsInfo } from '../lib/api'

export const EARNINGS_TTL_MS = 300_000
const SYMBOL = /^[A-Z0-9.-]{1,12}$/

export interface EarningsEntry {
  data: EarningsInfo | null
  /** Raw backend message; '' when fine. */
  error: string
  loading: boolean
  /** Epoch ms of the last successful load. */
  at: number
}

const EMPTY: EarningsEntry = { data: null, error: '', loading: false, at: 0 }
const inflight = new Map<string, Promise<void>>()
let epochNow = 0
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface EarningsState {
  bySymbol: Record<string, EarningsEntry>
  load: (symbol: string, force?: boolean) => Promise<void>
  /** Session wipe (Disconnect, Lock vault): drop everything and ignore in-flight answers. */
  wipe: () => void
}

export const useEarningsStore = create<EarningsState>((set, get) => {
  const patch = (symbol: string, p: Partial<EarningsEntry>) =>
    set((s) => ({ bySymbol: { ...s.bySymbol, [symbol]: { ...(s.bySymbol[symbol] ?? EMPTY), ...p } } }))
  return {
    bySymbol: {},
    load: (raw, force = false) => {
      const symbol = raw.trim().toUpperCase()
      if (!SYMBOL.test(symbol)) {
        patch(symbol || '?', { data: null, error: 'invalid input: symbol', loading: false, at: 0 })
        return Promise.resolve()
      }
      const cur = get().bySymbol[symbol]
      if (!force && cur?.data && Date.now() - cur.at < EARNINGS_TTL_MS) return Promise.resolve()
      const key = `${epochNow}:${symbol}`
      const have = inflight.get(key)
      if (have) return have
      const epoch = epochNow
      patch(symbol, { loading: true })
      const p = (async () => {
        try {
          const data = await api.rhEarnings(symbol)
          if (epoch === epochNow) patch(symbol, { data, error: '', loading: false, at: Date.now() })
        } catch (e) {
          // a failure clears the data: the event row goes back to "-" instead of showing a stale date
          if (epoch === epochNow) patch(symbol, { data: null, error: msg(e), loading: false, at: 0 })
        } finally {
          inflight.delete(key)
        }
      })()
      inflight.set(key, p)
      return p
    },
    wipe: () => {
      epochNow += 1
      inflight.clear()
      set({ bySymbol: {} })
    },
  }
})

/** 'ok' only when the lookup answered; an error, a pending load or no request yet is 'unknown'. */
export function earningsStatus(e: EarningsEntry | undefined): 'ok' | 'unknown' {
  return e?.data ? 'ok' : 'unknown'
}
