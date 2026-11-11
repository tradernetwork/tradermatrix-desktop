/**
 * TraderMatrix data store (read-only). Per-symbol cache with the same TTLs as the Rust core (5 min for every leg since M20a),
 * in-flight de-duplication, and an epoch so a response that lands after the cache was dropped is ignored.
 * M20a: the Rust core owns the call budget (10/min, 200/day). This store (1) honors `paused` without calling at all, (2) passes a priority
 * (interactive by default; the alert poller and the positions pane say otherwise), (3) loads a symbol the user is merely passing through only
 * after it has been on screen for SETTLE_MS (`scheduleSymbol`), so five quick switches cost the final symbol's calls, not five symbols' worth.
 * The API key is NEVER held here: it passes through `saveKey` as an argument and goes straight to the secret store.
 * Only `key_present` booleans (TmStatus) live in state.
 */
import { create } from 'zustand'
import { api, TM_KEY_SLOT, type ApexLevels, type ExpectedMove, type IvRank, type QuotaStatus, type TmPriority, type TmSnapshot, type TmStatus } from '../lib/api'
import { isPaused, pausedMessage } from '../lib/tmQuota'
import { SnapshotSampler } from '../lib/snapshots'
import { parseTmSettings, TM_DEFAULT_SETTINGS, TM_SETTING_KEY, validateTmKey, type TmSettings } from '../lib/tmUi'
import type { TmOverlayData } from '../chart/tmOverlay'

export type TmLegName = 'snapshot' | 'apex' | 'move' | 'iv'
export const ALL_LEGS: readonly TmLegName[] = ['snapshot', 'apex', 'move', 'iv']
/** Apex levels move slowly (TM's own per-ticker change cooldown is 4 h), so they cache as long as the rest. Same numbers as the Rust core. */
export const TTL_MS: Record<TmLegName, number> = { apex: 300_000, move: 300_000, iv: 300_000, snapshot: 300_000 }
/** A symbol must stay on screen this long before the pane loads it from TraderMatrix (the first load of a surface is immediate). */
export const SETTLE_MS = 2500
const SYMBOL = /^[A-Z]{1,6}(\.[A-Z])?$/
const KEY_MISSING = 'TraderMatrix key not set'

export interface Leg<T> {
  data: T | null
  /** Raw message from the backend ('' when fine). Use tmErrorText() for display. */
  error: string
  loading: boolean
  /** Epoch ms of the last successful load. */
  at: number
}
export interface SymbolEntry {
  snapshot: Leg<TmSnapshot>
  apex: Leg<ApexLevels>
  move: Leg<ExpectedMove>
  iv: Leg<IvRank>
}
type LegData = { snapshot: TmSnapshot; apex: ApexLevels; move: ExpectedMove; iv: IvRank }

const emptyLeg = <T,>(): Leg<T> => ({ data: null, error: '', loading: false, at: 0 })
const emptyEntry = (): SymbolEntry => ({ snapshot: emptyLeg(), apex: emptyLeg(), move: emptyLeg(), iv: emptyLeg() })

const FETCH: { [K in TmLegName]: (symbol: string, priority: TmPriority) => Promise<LegData[K]> } = {
  snapshot: (s, p) => api.tmSnapshot(s, p),
  apex: (s, p) => api.tmApexLevels(s, undefined, p),
  move: (s, p) => api.tmExpectedMove(s, p),
  iv: (s, p) => api.tmIvRank(s, p),
}

/** TraderMatrix responses are kept in the local database as they are fetched (the store's 60 s / 300 s cache already paces this). Never the key or headers: only the typed response. */
const SNAPSHOT_KIND: Partial<Record<TmLegName, string>> = { apex: 'tm_levels', iv: 'tm_iv', move: 'tm_em' }
const tmSampler = new SnapshotSampler((kind, key, json) => api.snapshotStore(kind, key, json), 0)

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// module-level, not persisted
const inflight = new Map<string, Promise<void>>()
let epochNow = 0
/** One pending debounced load per surface ('chart', 'insight', ...). */
const pendingLoads = new Map<string, ReturnType<typeof setTimeout>>()
const lastScheduled = new Map<string, { symbol: string; epoch: number }>()

interface TmState {
  status: TmStatus | null
  statusError: string
  /** M20a: the local call budget (counts only). Null until the first read. */
  quota: QuotaStatus | null
  epoch: number
  bySymbol: Record<string, SymbolEntry>
  settings: TmSettings
  settingsLoaded: boolean
  keyBusy: boolean

  refreshStatus: () => Promise<void>
  /** Returns '' on success or a message. The key is not stored anywhere in this store. */
  saveKey: (key: string) => Promise<string>
  removeKey: () => Promise<string>
  invalidate: () => void
  loadSymbol: (symbol: string, legs?: readonly TmLegName[], force?: boolean, priority?: TmPriority) => Promise<void>
  /** A symbol switch: the surface's FIRST load is immediate, later ones wait SETTLE_MS (a newer call for the same surface replaces the pending one). Cached legs cost nothing either way. */
  scheduleSymbol: (surface: string, symbol: string, legs?: readonly TmLegName[], priority?: TmPriority) => void
  /** Local only (never calls TraderMatrix). Bumps `epoch` when a pause has just ended, so panes reload. */
  refreshQuota: () => Promise<void>
  saveBudgets: (perMin: number, perDay: number) => Promise<string>
  loadSettings: () => Promise<void>
  setToggle: (k: 'apex' | 'flip' | 'move', v: boolean) => void
  setHorizon: (h: string) => void
  reset: () => void
  /** Session wipe (Disconnect, Lock vault): drop cached data, status and in-flight loads; display settings are kept. */
  wipe: () => void
}

export const useTmStore = create<TmState>((set, get) => {
  const setLeg = <K extends TmLegName>(symbol: string, leg: K, patch: Partial<Leg<LegData[K]>>) =>
    set((s) => {
      const e = s.bySymbol[symbol] ?? emptyEntry()
      return { bySymbol: { ...s.bySymbol, [symbol]: { ...e, [leg]: { ...(e[leg] as Leg<LegData[K]>), ...patch } } as SymbolEntry } }
    })

  const persist = () => void api.settingSet(TM_SETTING_KEY, JSON.stringify(get().settings)).catch(() => undefined)

  const fetchLeg = <K extends TmLegName>(symbol: string, leg: K, force: boolean, priority: TmPriority): Promise<void> => {
    const cur = get().bySymbol[symbol]?.[leg] as Leg<LegData[K]> | undefined
    if (!force && cur?.data && Date.now() - cur.at < TTL_MS[leg]) return Promise.resolve()
    // A paused day sends nothing: no command, no handshake. Fresh cached data was served above; a stale leg now says "TM paused until ..." (a degraded state).
    const q = get().quota
    if (isPaused(q, Date.now())) {
      setLeg(symbol, leg, { data: null, error: pausedMessage(q as QuotaStatus), loading: false, at: 0 })
      return Promise.resolve()
    }
    const key = `${epochNow}:${leg}:${symbol}`
    const have = inflight.get(key)
    if (have) return have
    const epoch = epochNow
    setLeg(symbol, leg, { loading: true })
    const p = (async () => {
      try {
        const data = await (FETCH[leg] as (s: string, p: TmPriority) => Promise<LegData[K]>)(symbol, priority)
        if (epoch === epochNow) {
          setLeg(symbol, leg, { data: data as LegData[K], error: '', loading: false, at: Date.now() })
          const kind = SNAPSHOT_KIND[leg]
          if (kind) tmSampler.offer(kind, symbol, data)
        }
      } catch (e) {
        // an error clears the data, so overlays quietly disappear; failures are never cached
        if (epoch === epochNow) setLeg(symbol, leg, { data: null, error: msg(e), loading: false, at: 0 })
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, p)
    return p
  }

  return {
    status: null,
    statusError: '',
    quota: null,
    epoch: 0,
    bySymbol: {},
    settings: { ...TM_DEFAULT_SETTINGS },
    settingsLoaded: false,
    keyBusy: false,

    refreshQuota: async () => {
      try {
        const next = await api.tmQuotaStatus()
        const wasPaused = get().quota?.paused === true
        set({ quota: next })
        if (wasPaused && !isPaused(next, Date.now())) set({ epoch: get().epoch + 1 })
      } catch {
        /* the chip simply keeps its last numbers */
      }
    },

    saveBudgets: async (perMin, perDay) => {
      try {
        set({ quota: await api.tmQuotaSet(perMin, perDay) })
        return ''
      } catch (e) {
        return msg(e)
      }
    },

    refreshStatus: async () => {
      try {
        set({ status: await api.tmStatus(), statusError: '' })
      } catch (e) {
        set({ statusError: msg(e) })
      }
    },

    saveKey: async (key) => {
      const bad = validateTmKey(key)
      if (bad) return bad
      set({ keyBusy: true })
      try {
        await api.secretSet(TM_KEY_SLOT, key.trim())
      } catch (e) {
        set({ keyBusy: false })
        return msg(e).split(key.trim()).join('[hidden]')
      }
      get().invalidate()
      await get().refreshStatus()
      set({ keyBusy: false })
      return ''
    },

    removeKey: async () => {
      set({ keyBusy: true })
      try {
        await api.secretDelete(TM_KEY_SLOT)
      } catch (e) {
        set({ keyBusy: false })
        return msg(e)
      }
      get().invalidate()
      await get().refreshStatus()
      set({ keyBusy: false })
      return ''
    },

    invalidate: () => {
      epochNow += 1
      inflight.clear()
      set({ bySymbol: {}, epoch: get().epoch + 1 })
    },

    scheduleSymbol: (surface, raw, legs = ALL_LEGS, priority = 'interactive') => {
      const symbol = raw.trim().toUpperCase()
      const prev = pendingLoads.get(surface)
      if (prev !== undefined) clearTimeout(prev)
      pendingLoads.delete(surface)
      const last = lastScheduled.get(surface)
      // Only a DIFFERENT symbol under the same cache generation waits: a first load, the same symbol again (a toggle) and a reload after
      // the cache was dropped (key saved, pause ended) go straight away.
      const first = !last || last.symbol === symbol || last.epoch !== get().epoch
      lastScheduled.set(surface, { symbol, epoch: get().epoch })
      const run = () => {
        pendingLoads.delete(surface)
        void get().loadSymbol(symbol, legs, false, priority)
      }
      const cached = legs.every((l) => {
        const cur = get().bySymbol[symbol]?.[l]
        return !!cur?.data && Date.now() - cur.at < TTL_MS[l]
      })
      if (first || cached) run()
      else pendingLoads.set(surface, setTimeout(run, SETTLE_MS))
    },

    loadSymbol: async (raw, legs = ALL_LEGS, force = false, priority = 'interactive') => {
      const symbol = raw.trim().toUpperCase()
      if (!SYMBOL.test(symbol)) {
        for (const l of legs) setLeg(symbol, l, { data: null, error: 'invalid input: symbol must be 1-6 letters, optionally .X (for example AAPL or BRK.B)', loading: false })
        return
      }
      if (get().status === null) await get().refreshStatus()
      const st = get().status
      if (st && !st.key_present) {
        // no key (or a locked vault): say so on every leg and send nothing
        for (const l of legs) setLeg(symbol, l, { data: null, error: st.last_error ?? KEY_MISSING, loading: false, at: 0 })
        return
      }
      await Promise.all(legs.map((l) => fetchLeg(symbol, l, force, priority)))
      const failed = legs.some((l) => get().bySymbol[symbol]?.[l].error)
      if (failed) await get().refreshStatus()
      await get().refreshQuota()
    },

    loadSettings: async () => {
      let raw: string | null = null
      try {
        raw = await api.settingGet(TM_SETTING_KEY)
      } catch {
        raw = null
      }
      set({ settings: parseTmSettings(raw), settingsLoaded: true })
    },
    setToggle: (k, v) => {
      set({ settings: { ...get().settings, [k]: v } })
      persist()
    },
    setHorizon: (h) => {
      set({ settings: { ...get().settings, horizon: h } })
      persist()
    },

    wipe: () => {
      epochNow += 1
      inflight.clear()
      for (const t of pendingLoads.values()) clearTimeout(t)
      pendingLoads.clear()
      lastScheduled.clear()
      set({ quota: null, status: null, statusError: '', epoch: get().epoch + 1, bySymbol: {}, keyBusy: false })
    },

    reset: () => {
      epochNow += 1
      inflight.clear()
      for (const t of pendingLoads.values()) clearTimeout(t)
      pendingLoads.clear()
      lastScheduled.clear()
      set({ quota: null, status: null, statusError: '', epoch: 0, bySymbol: {}, settings: { ...TM_DEFAULT_SETTINGS }, settingsLoaded: false, keyBusy: false })
    },
  }
})

/** Overlay input for the chart, or null when nothing enabled has data (the overlay then disappears). */
export function buildOverlayData(settings: TmSettings, apex: ApexLevels | null, move: ExpectedMove | null): TmOverlayData | null {
  const show = { apex: settings.apex && !!apex, flip: settings.flip && !!apex, move: settings.move && !!move }
  if (!show.apex && !show.flip && !show.move) return null
  return { apex, move, horizon: settings.horizon, show }
}

export function selectOverlay(s: Pick<TmState, 'bySymbol' | 'settings'>, symbol: string): TmOverlayData | null {
  const e = s.bySymbol[symbol.toUpperCase()]
  return buildOverlayData(s.settings, e?.apex.data ?? null, e?.move.data ?? null)
}
