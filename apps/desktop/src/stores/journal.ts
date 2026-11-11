import { create } from 'zustand'
import { api, type JournalNote, type PnlSpan, type RhPnlTrade, type RhRealizedPnl } from '../lib/api'
import { maskAccount } from '../lib/format'
import { exportMessage } from '../lib/journalUi'
import { validateNoteInput } from '../lib/journalRules'
import { useRhStore } from './rh'

export interface NoteInput {
  body: string
  tags: string[]
  /** Attach the note to this trade (trade_key + symbol + masked account). */
  trade?: RhPnlTrade | null
}

interface JournalState {
  span: PnlSpan
  pnl: RhRealizedPnl | null
  trades: RhPnlTrade[]
  tradesCursor: string | null
  pnlAccount: string | null
  pnlLoading: boolean
  pnlError: string

  notes: JournalNote[]
  notesError: string
  filterSymbol: string
  filterText: string
  /** trade_key whose note editor is open. */
  selectedKey: string | null

  exportNote: string
  exportError: string

  setSpan: (s: PnlSpan) => Promise<void>
  loadPnl: () => Promise<void>
  loadMoreTrades: () => Promise<void>
  loadNotes: () => Promise<void>
  setFilter: (symbol: string, text: string) => Promise<void>
  selectTrade: (key: string | null) => void
  addNote: (n: NoteInput) => Promise<boolean>
  editNote: (id: number, body: string, tags: string[]) => Promise<boolean>
  removeNote: (id: number) => Promise<boolean>
  exportCsv: () => Promise<void>
  reset: () => void
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const INITIAL = {
  span: 'month' as PnlSpan,
  pnl: null as RhRealizedPnl | null,
  trades: [] as RhPnlTrade[],
  tradesCursor: null as string | null,
  pnlAccount: null as string | null,
  pnlLoading: false,
  pnlError: '',
  notes: [] as JournalNote[],
  notesError: '',
  filterSymbol: '',
  filterText: '',
  selectedKey: null as string | null,
  exportNote: '',
  exportError: '',
}

let pnlSeq = 0
let notesSeq = 0

export const useJournalStore = create<JournalState>((set, get) => {
  const account = () => useRhStore.getState().account

  const reloadNotes = async (): Promise<void> => {
    const my = ++notesSeq
    try {
      const notes = await api.journalList({ symbol: get().filterSymbol.trim() || null, text: get().filterText.trim() || null, limit: 500 })
      if (my === notesSeq) set({ notes, notesError: '' })
    } catch (e) {
      // keep the rows on screen; say what failed
      if (my === notesSeq) set({ notesError: msg(e) })
    }
  }

  /** Runs a local write, then re-reads the list. A refused write leaves the list untouched and shows the reason. */
  const writeNote = async (op: () => Promise<unknown>): Promise<boolean> => {
    set({ notesError: '' })
    try {
      await op()
    } catch (e) {
      set({ notesError: msg(e) })
      return false
    }
    await reloadNotes()
    return true
  }

  return {
    ...INITIAL,

    setSpan: async (s) => {
      pnlSeq += 1
      set({ span: s, pnl: null, trades: [], tradesCursor: null, selectedKey: null, pnlError: '', exportNote: '', exportError: '' })
      await get().loadPnl()
    },

    loadPnl: async () => {
      const acct = account()
      if (!acct) {
        set({ pnlError: 'No account selected.', pnlLoading: false })
        return
      }
      const span = get().span
      const my = ++pnlSeq
      // data for another account is never shown under this one
      if (get().pnlAccount !== acct) set({ pnl: null, trades: [], tradesCursor: null, selectedKey: null })
      set({ pnlLoading: true, pnlError: '' })
      try {
        const [pnl, t] = await Promise.all([api.rhRealizedPnl(acct, span, null), api.rhPnlTrades(acct, span, null, null)])
        if (my !== pnlSeq) return
        set({ pnl, trades: t.trades, tradesCursor: t.next_cursor, pnlAccount: acct, pnlLoading: false })
      } catch (e) {
        if (my === pnlSeq) set({ pnlLoading: false, pnlError: msg(e) })
      }
    },

    loadMoreTrades: async () => {
      const acct = account()
      const cursor = get().tradesCursor
      if (!acct || !cursor) return
      const span = get().span
      const my = ++pnlSeq
      set({ pnlLoading: true, pnlError: '' })
      try {
        const t = await api.rhPnlTrades(acct, span, null, cursor)
        if (my !== pnlSeq) return
        const have = new Set(get().trades.map((x) => x.trade_key))
        set({ trades: [...get().trades, ...t.trades.filter((x) => !have.has(x.trade_key))], tradesCursor: t.next_cursor, pnlLoading: false })
      } catch (e) {
        if (my === pnlSeq) set({ pnlLoading: false, pnlError: msg(e) })
      }
    },

    loadNotes: reloadNotes,

    setFilter: async (symbol, text) => {
      set({ filterSymbol: symbol, filterText: text })
      await reloadNotes()
    },

    selectTrade: (key) => set({ selectedKey: get().selectedKey === key ? null : key }),

    addNote: async (n) => {
      const bad = validateNoteInput(n.body, n.tags)
      if (bad) {
        set({ notesError: bad })
        return false
      }
      const acct = account()
      return writeNote(() =>
        api.journalAdd({
          body: n.body,
          tags: n.tags,
          symbol: n.trade?.symbol || null,
          trade_key: n.trade?.trade_key ?? null,
          account_masked: n.trade && acct ? maskAccount(acct) : null,
        }),
      )
    },

    editNote: async (id, body, tags) => {
      const bad = validateNoteInput(body, tags)
      if (bad) {
        set({ notesError: bad })
        return false
      }
      return writeNote(() => api.journalUpdate(id, body, tags))
    },

    removeNote: async (id) => writeNote(() => api.journalDelete(id)),

    exportCsv: async () => {
      const acct = account()
      if (!acct) {
        set({ exportNote: '', exportError: 'No account selected.' })
        return
      }
      set({ exportNote: '', exportError: '' })
      try {
        set({ exportNote: exportMessage(await api.journalExportCsv(get().span, acct)) })
      } catch (e) {
        set({ exportError: msg(e) })
      }
    },

    reset: () => {
      pnlSeq += 1
      notesSeq += 1
      set({ ...INITIAL })
    },
  }
})
