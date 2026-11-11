/**
 * TraderMatrix <-> Robinhood watchlist sync (M8). Compares one TM list with one Robinhood custom list and ADDS what is
 * missing, in either direction or both. This module has no removal path: it calls only list/add/create wrappers
 * (a test greps this file). TM notes never arrive here (the Rust core drops them) and are never sent.
 *
 * Pacing: TM adds are one symbol per call (the Rust limiter paces them at 2/s), with progress and a Cancel honored
 * between symbols; Robinhood adds go in chunks of 50. A list that does not exist yet is created only when Apply runs
 * and only when something is going to be added to it.
 */
import { create } from 'zustand'
import { api, isOptionsList, type RhWatchlist, type TmWatchlist } from '../lib/api'
import { classifyTmError, tmErrorText } from '../lib/tmUi'
import { validateListName, watchlistWritable } from '../lib/watchRules'
import {
  actionsFor,
  chunk,
  computeSyncPlan,
  parseSyncPair,
  rhSymbolsOf,
  RH_CHUNK,
  SYNC_PAIR_KEY,
  tmFreeSlots,
  tmTickersOf,
  type Direction,
  type SkipNote,
  type SyncPlan,
} from '../lib/watchSync'
import { useRhStore } from './rh'

/** '' = nothing chosen, 'new' = create a list (named like the other side) when Apply needs it, else the list id as a string. */
export type Sel = string
export type SyncPhase = 'idle' | 'loading' | 'ready' | 'applying' | 'done'
export const MAX_TM_FAILS_IN_A_ROW = 3

export interface SyncFailure {
  symbol: string
  side: 'rh' | 'tm'
  error: string
}
export interface SyncResult {
  rhAdded: string[]
  tmAdded: string[]
  /** TM said "already on the list" (added:false): not an error. */
  already: string[]
  failed: SyncFailure[]
  skipped: SkipNote[]
  /** Symbols never attempted because of Cancel or an early stop. */
  notRun: number
  cancelled: boolean
  /** Why the run stopped early ('' = it did not). */
  stopped: string
  /** List creation failed or its name was refused: nothing was added. */
  aborted: string
  created: string[]
}
export interface TmLimits {
  tickers_per_list: number | null
  tickers_across_all_lists: number | null
  max_lists: number | null
}

interface SyncState {
  open: boolean
  phase: SyncPhase
  tmLists: TmWatchlist[]
  tmLimits: TmLimits
  /** Raw message ('' = TM loaded fine). Display with tmErrorText(). */
  tmError: string
  rhLists: RhWatchlist[]
  rhError: string
  tmSel: Sel
  rhSel: Sel
  direction: Direction
  plan: SyncPlan | null
  planLoading: boolean
  planError: string
  progress: { side: 'rh' | 'tm'; done: number; total: number } | null
  cancelRequested: boolean
  result: SyncResult | null

  openDialog: () => Promise<void>
  closeDialog: () => void
  /** Re-read both sides (after a TM or Robinhood change elsewhere). */
  refresh: () => Promise<void>
  select: (side: 'tm' | 'rh', value: Sel) => Promise<void>
  setDirection: (d: Direction) => void
  apply: () => Promise<void>
  cancel: () => void
  reset: () => void
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const NO_LIMITS: TmLimits = { tickers_per_list: null, tickers_across_all_lists: null, max_lists: null }
const blankResult = (): SyncResult => ({ rhAdded: [], tmAdded: [], already: [], failed: [], skipped: [], notRun: 0, cancelled: false, stopped: '', aborted: '', created: [] })

const initial = () => ({
  open: false,
  phase: 'idle' as SyncPhase,
  tmLists: [] as TmWatchlist[],
  tmLimits: NO_LIMITS,
  tmError: '',
  rhLists: [] as RhWatchlist[],
  rhError: '',
  tmSel: '' as Sel,
  rhSel: '' as Sel,
  direction: 'both' as Direction,
  plan: null as SyncPlan | null,
  planLoading: false,
  planError: '',
  progress: null as SyncState['progress'],
  cancelRequested: false,
  result: null as SyncResult | null,
})

// module-level: a stale plan response must not overwrite a newer one; Cancel is read between symbols
let planSeq = 0
let cancelFlag = false

export const useWatchSyncStore = create<SyncState>((set, get) => {
  const persistPair = async () => {
    const { tmSel, rhSel } = get()
    const o: Record<string, string> = {}
    if (tmSel && tmSel !== 'new') o.tm = tmSel
    if (rhSel && rhSel !== 'new') o.rh = rhSel
    if (Object.keys(o).length === 0) return
    try {
      await api.settingSet(SYNC_PAIR_KEY, JSON.stringify(o))
    } catch {
      /* remembering the pairing is a convenience */
    }
  }

  /** Reads both sides. A TM failure is kept apart (own message) and never blocks the Robinhood side from loading. */
  const loadLists = async (): Promise<void> => {
    const [tm, rh] = await Promise.allSettled([api.tmWatchlists(), api.rhWatchlists()])
    const patch: Partial<SyncState> = {}
    if (tm.status === 'fulfilled') {
      patch.tmLists = tm.value.lists
      patch.tmLimits = { tickers_per_list: tm.value.tickers_per_list, tickers_across_all_lists: tm.value.tickers_across_all_lists, max_lists: tm.value.max_lists }
      patch.tmError = ''
    } else {
      patch.tmError = msg(tm.reason)
    }
    if (rh.status === 'fulfilled') {
      patch.rhLists = rh.value.filter((w) => watchlistWritable(w) && !isOptionsList(w))
      patch.rhError = ''
    } else {
      patch.rhError = msg(rh.reason)
    }
    set(patch)
  }

  const refreshPlan = async (): Promise<void> => {
    const seq = ++planSeq
    const { tmSel, rhSel, tmLists, tmLimits, tmError } = get()
    const tmList = tmSel !== '' && tmSel !== 'new' ? tmLists.find((l) => String(l.id) === tmSel) : undefined
    const rhKnown = rhSel === 'new' || get().rhLists.some((l) => l.id === rhSel)
    if (tmSel === '' || rhSel === '' || tmError !== '' || (tmSel !== 'new' && !tmList) || !rhKnown) {
      set({ plan: null, planLoading: false, planError: '' })
      return
    }
    set({ planLoading: true, planError: '' })
    let items: { symbol: string; object_type?: string | null }[] = []
    if (rhSel !== 'new') {
      try {
        items = (await api.rhWatchlistItems(rhSel)).items
      } catch (e) {
        if (seq === planSeq) set({ plan: null, planLoading: false, planError: msg(e) })
        return
      }
    }
    if (seq !== planSeq) return
    const tmFree = tmFreeSlots(tmLists, tmList ? tmList.id : null, tmLimits)
    const plan = computeSyncPlan(tmList ? tmTickersOf(tmList) : [], rhSymbolsOf(items), tmFree === undefined ? undefined : { tmFree })
    set({ plan, planLoading: false, planError: '' })
  }

  const restorePair = async () => {
    let raw: string | null = null
    try {
      raw = await api.settingGet(SYNC_PAIR_KEY)
    } catch {
      return
    }
    const p = parseSyncPair(raw)
    const { tmLists, rhLists } = get()
    set({
      tmSel: p.tm !== null && p.tm !== 'new' && tmLists.some((l) => String(l.id) === p.tm) ? p.tm : '',
      rhSel: p.rh !== null && p.rh !== 'new' && rhLists.some((l) => l.id === p.rh) ? p.rh : '',
    })
  }

  return {
    ...initial(),

    openDialog: async () => {
      cancelFlag = false
      set({ ...initial(), open: true, phase: 'loading' })
      await loadLists()
      await restorePair()
      set({ phase: 'ready' })
      await refreshPlan()
    },

    closeDialog: () => {
      if (get().phase === 'applying') return
      planSeq++
      set({ ...initial() })
    },

    refresh: async () => {
      if (get().phase === 'applying') return
      await loadLists()
      await refreshPlan()
    },

    select: async (side, value) => {
      if (get().phase === 'applying') return
      set(side === 'tm' ? { tmSel: value, result: null } : { rhSel: value, result: null })
      await persistPair()
      await refreshPlan()
    },

    setDirection: (d) => {
      if (get().phase !== 'applying') set({ direction: d })
    },

    cancel: () => {
      if (get().phase !== 'applying') return
      cancelFlag = true
      set({ cancelRequested: true })
    },

    reset: () => {
      planSeq++
      cancelFlag = false
      set({ ...initial() })
    },

    apply: async () => {
      const s0 = get()
      if (s0.phase === 'applying' || !s0.plan || s0.tmSel === '' || s0.rhSel === '' || (s0.tmSel === 'new' && s0.rhSel === 'new')) return
      cancelFlag = false
      const { plan, direction } = s0
      const { addToRh, addToTm } = actionsFor(plan, direction)
      const res = blankResult()
      res.skipped = [...(direction === 'tm_to_rh' ? [] : plan.skippedForTm), ...(direction === 'rh_to_tm' ? [] : plan.skippedForRh)]
      set({ phase: 'applying', result: null, progress: null, cancelRequested: false })

      const tmSource = s0.tmSel === 'new' ? undefined : s0.tmLists.find((l) => String(l.id) === s0.tmSel)
      const rhSource = s0.rhSel === 'new' ? undefined : s0.rhLists.find((l) => l.id === s0.rhSel)
      let rhTarget = s0.rhSel
      let tmTarget = s0.tmSel

      // 1. Create what is needed (and only that). A failure aborts before anything is added.
      if (s0.rhSel === 'new' && addToRh.length > 0) {
        const name = (tmSource?.name ?? '').trim()
        const bad = validateListName(name)
        if (bad) {
          res.aborted = `Cannot create a Robinhood list named "${name.slice(0, 60)}": ${bad}`
        } else {
          try {
            const r = (await api.rhWatchlistCreate(name, null, null)) as { watchlist?: { id?: unknown } }
            const id = r.watchlist?.id
            if (typeof id !== 'string') throw new Error('Robinhood did not return the new list id')
            rhTarget = id
            res.created.push(`Robinhood: ${name}`)
            set({ rhSel: id })
          } catch (e) {
            res.aborted = `Could not create the Robinhood list "${name}": ${msg(e)}`
          }
        }
      } else if (s0.tmSel === 'new' && addToTm.length > 0) {
        const name = (rhSource?.display_name ?? '').trim()
        try {
          const m = await api.tmWatchlistCreate(name)
          tmTarget = String(m.id)
          res.created.push(`TraderMatrix: ${m.name}`)
          set({ tmSel: tmTarget })
        } catch (e) {
          res.aborted = `Could not create the TraderMatrix list "${name}": ${msg(e)}`
        }
      }

      if (!res.aborted) {
        // 2. Robinhood: chunks of 50, a failed chunk is reported per symbol and the rest still run.
        if (addToRh.length > 0) {
          const chunks = chunk(addToRh, RH_CHUNK)
          let done = 0
          for (let i = 0; i < chunks.length; i++) {
            if (cancelFlag) {
              res.cancelled = true
              res.notRun += chunks.slice(i).reduce((n, c) => n + c.length, 0)
              break
            }
            set({ progress: { side: 'rh', done, total: addToRh.length } })
            try {
              await api.rhWatchlistAdd(rhTarget, chunks[i])
              res.rhAdded.push(...chunks[i])
            } catch (e) {
              for (const symbol of chunks[i]) res.failed.push({ symbol, side: 'rh', error: msg(e) })
            }
            done += chunks[i].length
          }
        }
        // 3. TraderMatrix: one symbol at a time, Cancel between symbols, 3 failures in a row stop the run.
        if (addToTm.length > 0) {
          if (res.cancelled) {
            res.notRun += addToTm.length
          } else {
            let fails = 0
            for (let i = 0; i < addToTm.length; i++) {
              if (cancelFlag) {
                res.cancelled = true
                res.notRun += addToTm.length - i
                break
              }
              set({ progress: { side: 'tm', done: i, total: addToTm.length } })
              const symbol = addToTm[i]
              try {
                const o = await api.tmWatchlistAdd(tmTarget, symbol)
                if (o.added) res.tmAdded.push(symbol)
                else res.already.push(symbol)
                fails = 0
              } catch (e) {
                const m = msg(e)
                res.failed.push({ symbol, side: 'tm', error: m })
                fails += 1
                const kind = classifyTmError(m)
                if (kind === 'key_missing' || kind === 'locked' || kind === 'rejected') {
                  res.stopped = `Stopped: ${tmErrorText(m)}`
                } else if (fails >= MAX_TM_FAILS_IN_A_ROW) {
                  res.stopped = `Stopped after ${MAX_TM_FAILS_IN_A_ROW} TraderMatrix failures in a row. Last error: ${tmErrorText(m)}`
                }
                if (res.stopped) {
                  res.notRun += addToTm.length - i - 1
                  break
                }
              }
              set({ progress: { side: 'tm', done: i + 1, total: addToTm.length } })
            }
          }
        }
      }

      // 4. Reload both sides, remember the pairing, recompute the diff (a re-run does only what is left).
      set({ progress: null, result: res, cancelRequested: false })
      await persistPair()
      await loadLists()
      set({ phase: 'done' })
      await refreshPlan()
      if (res.rhAdded.length > 0 || res.created.some((c) => c.startsWith('Robinhood'))) void useRhStore.getState().loadWatchlists()
    },
  }
})
