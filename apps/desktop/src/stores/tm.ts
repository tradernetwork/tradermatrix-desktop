/**
 * TraderMatrix data store (read-only). Per-symbol cache with the same TTLs as the Rust core (apex 60 s, the rest 5 min),
 * in-flight de-duplication, and an epoch so a response that lands after the cache was dropped is ignored.
 * The API key is NEVER held here: it passes through `saveKey` as an argument and goes straight to the secret store.
 * Only `key_present` booleans (TmStatus) live in state.
 */
import { create } from 'zustand'
import { api, TM_KEY_SLOT, type ApexLevels, type ExpectedMove, type IvRank, type TmSnapshot, type TmStatus } from '../lib/api'
import { SnapshotSampler } from '../lib/snapshots'
import { parseTmSettings, TM_DEFAULT_SETTINGS, TM_SETTING_KEY, validateTmKey, type TmSettings } from '../lib/tmUi'
import type { TmOverlayData } from '../chart/tmOverlay'

export type TmLegName = 'snapshot' | 'apex' | 'move' | 'iv'
export const ALL_LEGS: readonly TmLegName[] = ['snapshot', 'apex', 'move', 'iv']
export const TTL_MS: Record<TmLegName, number> = { apex: 60_000, move: 300_000, iv: 300_000, snapshot: 300_000 }
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

const FETCH: { [K in TmLegName]: (symbol: string) => Promise<LegData[K]> } = {
  snapshot: (s) => api.tmSnapshot(s),
  apex: (s) => api.tmApexLevels(s),
  move: (s) => api.tmExpectedMove(s),
  iv: (s) => api.tmIvRank(s),
}

/** TraderMatrix responses are kept in the local database as they are fetched (the store's 60 s / 300 s cache already paces this). Never the key or headers: only the typed response. */
const SNAPSHOT_KIND: Partial<Record<TmLegName, string>> = { apex: 'tm_levels', iv: 'tm_iv', move: 'tm_em' }
const tmSampler = new SnapshotSampler((kind, key, json) => api.snapshotStore(kind, key, json), 0)

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// module-level, not persisted
const inflight = new Map<string, Promise<void>>()
let epochNow = 0

interface TmState {
  status: TmStatus | null
  statusError: string
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
  loadSymbol: (symbol: string, legs?: readonly TmLegName[], force?: boolean) => Promise<void>
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

  const fetchLeg = <K extends TmLegName>(symbol: string, leg: K, force: boolean): Promise<void> => {
    const cur = get().bySymbol[symbol]?.[leg] as Leg<LegData[K]> | undefined
    if (!force && cur?.data && Date.now() - cur.at < TTL_MS[leg]) return Promise.resolve()
    const key = `${epochNow}:${leg}:${symbol}`
    const have = inflight.get(key)
    if (have) return have
    const epoch = epochNow
    setLeg(symbol, leg, { loading: true })
    const p = (async () => {
      try {
        const data = await (FETCH[leg] as (s: string) => Promise<LegData[K]>)(symbol)
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
    epoch: 0,
    bySymbol: {},
    settings: { ...TM_DEFAULT_SETTINGS },
    settingsLoaded: false,
    keyBusy: false,

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

    loadSymbol: async (raw, legs = ALL_LEGS, force = false) => {
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
      await Promise.all(legs.map((l) => fetchLeg(symbol, l, force)))
      const failed = legs.some((l) => get().bySymbol[symbol]?.[l].error)
      if (failed) await get().refreshStatus()
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
      set({ status: null, statusError: '', epoch: get().epoch + 1, bySymbol: {}, keyBusy: false })
    },

    reset: () => {
      epochNow += 1
      inflight.clear()
      set({ status: null, statusError: '', epoch: 0, bySymbol: {}, settings: { ...TM_DEFAULT_SETTINGS }, settingsLoaded: false, keyBusy: false })
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
