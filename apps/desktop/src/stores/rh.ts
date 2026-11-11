import { create } from 'zustand'
import { copyText } from '../lib/clipboard'
import {
  api,
  isOptionsList,
  type RhAccount,
  type RhOptionWatchItem,
  type RhOptionPosition,
  type RhOrder,
  type RhPortfolio,
  type RhPosition,
  type RhQuote,
  type RhStatus,
  type RhWatchlist,
} from '../lib/api'
import { defaultAccount } from '../lib/format'
import { parseWatchSymbols, validateListName, validateEmoji, watchlistWritable } from '../lib/watchRules'
import { normalizeSymbol } from '../chart/useChartData'
import { isEquityTicker } from '../lib/symbols'
import { OPTION_ID_RE, type ChartOption } from '../chart/optionChart'
import { SnapshotSampler } from '../lib/snapshots'
import { QuotePoller } from './quotePoller'
import { useAlertsStore } from './alerts'

/** Quote snapshots go to the local database at most once per symbol per 60 s while the app runs (fire-and-forget). */
const quoteSampler = new SnapshotSampler((kind, key, json) => api.snapshotStore(kind, key, json))

export type ConnectState = 'disconnected' | 'connecting' | 'connected' | 'error'

export function connectState(s: { status: RhStatus | null; connecting: boolean; connectError: string }): ConnectState {
  if (s.connecting) return 'connecting'
  if (s.connectError) return 'error'
  return s.status?.connected ? 'connected' : 'disconnected'
}

/** Only listed equities can be quoted: the item must be an `instrument` (not a currency pair, option strategy, index) with a valid ticker. */
export function isEquitySymbol(s: { symbol: string; object_type: string }): boolean {
  return s.object_type === 'instrument' && isEquityTicker(s.symbol)
}

interface RhState {
  status: RhStatus | null
  connecting: boolean
  connectError: string

  accounts: RhAccount[]
  account: string | null
  portfolio: RhPortfolio | null
  positions: RhPosition[]
  positionsError: string
  positionsLoading: boolean
  /** Open option positions (M10), joined with contract and quote in Rust. Own error: a failing option read never hides equities. */
  optionPositions: RhOptionPosition[]
  optionPositionsError: string

  orders: RhOrder[]
  orderState: string
  ordersError: string

  watchlists: RhWatchlist[]
  listId: string | null
  listSymbols: string[]
  optionItems: RhOptionWatchItem[]
  watchError: string
  /** A write is in flight (single flight: a second click is ignored). */
  watchBusy: boolean
  /** Last successful watchlist write, shown next to the controls. */
  watchNote: string

  quotes: Record<string, RhQuote>
  quoteError: string
  /** More symbols are wanted than the poller's cap: some are not quoted. */
  quotesTruncated: boolean

  /** Symbol the chart pane shows; Watchlist and Positions rows set it. Not cleared on disconnect. */
  chartSymbol: string
  setChartSymbol: (s: string) => void
  /** M11 option mode: when set the chart shows this contract's price history instead of `chartSymbol`. Any equity pick clears it. */
  chartOption: ChartOption | null
  /** Sets the contract (and moves chartSymbol to its underlying); null goes back to the equity. A bad id is ignored. */
  setChartOption: (o: ChartOption | null) => void

  refreshStatus: () => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  captureNote: string
  loginLinkNote: string
  loginLinkFallback: string
  copyLoginLink: () => Promise<void>
  captureTools: () => Promise<void>
  loadAccounts: () => Promise<void>
  selectAccount: (n: string) => Promise<void>
  loadPositions: () => Promise<void>
  setOrderState: (s: string) => Promise<void>
  /** Reads orders for `account` (default: the selected one). true = the list was read; false = it failed or was superseded. */
  loadOrders: (account?: string) => Promise<boolean>
  loadWatchlists: () => Promise<void>
  selectList: (id: string) => Promise<void>
  /** Typed or pasted symbols (commas/spaces). Validated here and again in Rust. true = saved on the server. */
  addSymbols: (input: string) => Promise<boolean>
  removeSymbol: (symbol: string) => Promise<boolean>
  createList: (name: string, emoji: string) => Promise<boolean>
  renameList: (name: string) => Promise<boolean>
  watchQuotes: (owner: string, symbols: string[]) => void
  /** Session wipe (Disconnect, Lock vault): drop every Robinhood-derived value, stop polling, orphan in-flight reads. */
  wipe: () => void
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const EMPTY = {
  accounts: [] as RhAccount[],
  account: null as string | null,
  portfolio: null as RhPortfolio | null,
  positions: [] as RhPosition[],
  positionsError: '',
  optionPositions: [] as RhOptionPosition[],
  optionPositionsError: '',
  orders: [] as RhOrder[],
  ordersError: '',
  watchlists: [] as RhWatchlist[],
  listId: null as string | null,
  listSymbols: [] as string[],
  optionItems: [] as RhOptionWatchItem[],
  watchError: '',
  watchBusy: false,
  watchNote: '',
  quotes: {} as Record<string, RhQuote>,
  quoteError: '',
  quotesTruncated: false,
}

export const useRhStore = create<RhState>((set, get) => {
  /** Bumped by wipe(): any read that started before it must not write state afterwards. */
  let epoch = 0
  let ordersSeq = 0
  const poller = new QuotePoller({
    fetch: (symbols) => api.rhQuotes(symbols),
    hasArmedAlerts: () => useAlertsStore.getState().armedCount() > 0,
    onQuotes: (list, meta) => {
      set((s) => {
        const quotes = { ...s.quotes }
        for (const q of list) {
          quotes[q.symbol] = q
          quoteSampler.offer('quote', q.symbol, q)
        }
        return { quotes, quoteError: '' }
      })
      // the ONE alert subscriber: evaluates only symbols that have alerts; errors never reach the quote path
      void useAlertsStore.getState().onQuotes(list, meta).catch((e) => console.warn('alert evaluation failed (ignored)', e))
    },
    onError: (m) => set({ quoteError: m }),
  })
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) poller.resume()
    })
  }

  /** Re-reads the selected list and the list headers without clearing what is on screen (a failed reload keeps the old rows). */
  const reloadSelected = async (id: string): Promise<void> => {
    const myEpoch = epoch
    const options = isOptionsList(get().watchlists.find((w) => w.id === id))
    const [watchlists, contents, optionList] = await Promise.all([
      api.rhWatchlists(),
      options ? Promise.resolve(null) : api.rhWatchlistItems(id),
      options ? api.rhOptionWatchlist() : Promise.resolve(null),
    ])
    if (get().listId !== id || myEpoch !== epoch) return
    set({
      watchlists,
      ...(contents ? { listSymbols: contents.items.filter(isEquitySymbol).map((i) => i.symbol) } : {}),
      ...(optionList ? { optionItems: optionList.items } : {}),
    })
  }

  /** One write on the selected list. Refuses read-only lists, single flight, reloads from the server afterwards. */
  const writeToList = async (op: (listId: string) => Promise<unknown>, okNote: string): Promise<boolean> => {
    const id = get().listId
    if (!id || !watchlistWritable(get().watchlists.find((w) => w.id === id))) {
      set({ watchError: 'This list is read-only.', watchNote: '' })
      return false
    }
    if (get().watchBusy) return false
    set({ watchBusy: true, watchError: '', watchNote: '' })
    try {
      await op(id)
    } catch (e) {
      set({ watchBusy: false, watchError: msg(e) })
      return false
    }
    try {
      await reloadSelected(id)
      set({ watchBusy: false, watchNote: okNote })
    } catch (e) {
      set({ watchBusy: false, watchError: `Saved, but the list could not be reloaded: ${msg(e)}` })
    }
    return true
  }

  return {
    status: null,
    connecting: false,
    connectError: '',
    captureNote: '',
    loginLinkNote: '',
    loginLinkFallback: '',
    ...EMPTY,
    positionsLoading: false,
    orderState: '',
    chartSymbol: 'SPY',
    setChartSymbol: (s) => {
      const n = normalizeSymbol(s)
      if (n) set({ chartSymbol: n, chartOption: null })
    },
    chartOption: null,
    setChartOption: (o) => {
      if (o === null) return set({ chartOption: null })
      const under = normalizeSymbol(o.underlying)
      if (!under || !OPTION_ID_RE.test(o.id)) return
      set({ chartOption: { id: o.id, label: o.label, underlying: under }, chartSymbol: under })
    },

    refreshStatus: async () => {
      try {
        set({ status: await api.rhStatus() })
      } catch (e) {
        set({ status: null, connectError: msg(e) })
      }
    },

    connect: async () => {
      if (get().connecting) return
      set({ connecting: true, connectError: '', loginLinkNote: '', loginLinkFallback: '' })
      try {
        await api.rhConnect()
        await get().refreshStatus()
        set({ connecting: false })
        if (get().status?.connected) {
          await get().loadAccounts()
          await get().loadWatchlists()
        }
      } catch (e) {
        set({ connecting: false, connectError: msg(e) })
        await get().refreshStatus()
      }
    },

    copyLoginLink: async () => {
      set({ loginLinkFallback: '' })
      let url: string | null = null
      try {
        url = await api.rhPendingLoginUrl()
      } catch (e) {
        set({ loginLinkNote: `Could not get the login link: ${msg(e)}` })
        return
      }
      if (!url) {
        set({ loginLinkNote: 'No login in progress.' })
        return
      }
      if (await copyText(url)) set({ loginLinkNote: 'Login link copied. Paste it into any browser.' })
      else set({ loginLinkNote: 'Select the link below and copy it.', loginLinkFallback: url })
    },

    captureTools: async () => {
      set({ captureNote: 'Saving tool list...' })
      try {
        const c = await api.rhCaptureTools()
        set({ captureNote: `Saved ${c.count} tools to ${c.path}` })
      } catch (e) {
        set({ captureNote: `Capture failed: ${msg(e)}` })
      }
    },

    wipe: () => {
      epoch += 1
      ordersSeq += 1
      poller.clear()
      set({ ...EMPTY, status: null, orderState: '', positionsLoading: false })
    },

    disconnect: async () => {
      get().wipe()
      try {
        await api.rhDisconnect()
      } catch (e) {
        set({ connectError: msg(e) })
      }
      set({ ...EMPTY, connectError: get().connectError })
      await get().refreshStatus()
    },

    loadAccounts: async () => {
      const myEpoch = epoch
      try {
        const accounts = await api.rhAccounts()
        if (myEpoch !== epoch) return
        const keep = get().account && accounts.some((a) => a.account_number === get().account)
        set({ accounts, positionsError: '' })
        const pick = keep ? get().account : (defaultAccount(accounts)?.account_number ?? null)
        if (pick) await get().selectAccount(pick)
      } catch (e) {
        if (myEpoch === epoch) set({ positionsError: msg(e) })
      }
    },

    selectAccount: async (n) => {
      set({ account: n, portfolio: null, positions: [], optionPositions: [], optionPositionsError: '', orders: [] })
      await Promise.all([get().loadPositions(), get().loadOrders()])
    },

    loadPositions: async () => {
      const account = get().account
      if (!account) return
      const myEpoch = epoch
      set({ positionsLoading: true, positionsError: '' })
      // Option positions ride the same refresh but fail on their own (own error, equities unaffected).
      const optionsRead = api.rhOptionPositions(account).then(
        (rows) => ({ rows }),
        (e: unknown) => ({ error: msg(e) }),
      )
      try {
        const [portfolio, positions] = await Promise.all([api.rhPortfolio(account), api.rhPositions(account)])
        if (get().account !== account || myEpoch !== epoch) return
        set({ portfolio, positions, positionsLoading: false })
      } catch (e) {
        if (get().account === account && myEpoch === epoch) set({ positionsLoading: false, positionsError: msg(e) })
      }
      const o = await optionsRead
      if (get().account !== account || myEpoch !== epoch) return
      if ('rows' in o) set({ optionPositions: o.rows, optionPositionsError: '' })
      else set({ optionPositionsError: o.error })
    },

    setOrderState: async (s) => {
      set({ orderState: s })
      await get().loadOrders()
    },

    loadOrders: async (target) => {
      const account = target ?? get().account
      if (!account) return false
      const my = ++ordersSeq
      const myEpoch = epoch
      set({ ordersError: '' })
      try {
        const orders = await api.rhOrders(account, get().orderState || null)
        if (my !== ordersSeq || myEpoch !== epoch || get().account !== account) return false
        set({ orders })
        return true
      } catch (e) {
        if (my === ordersSeq && myEpoch === epoch && get().account === account) set({ ordersError: msg(e) })
        return false
      }
    },

    loadWatchlists: async () => {
      const myEpoch = epoch
      try {
        const watchlists = await api.rhWatchlists()
        if (myEpoch !== epoch) return
        set({ watchlists, watchError: '' })
        const cur = get().listId
        const pick = cur && watchlists.some((w) => w.id === cur) ? cur : (watchlists.find((w) => !isOptionsList(w)) ?? watchlists[0])?.id
        if (pick) await get().selectList(pick)
      } catch (e) {
        if (myEpoch === epoch) set({ watchError: msg(e) })
      }
    },

    selectList: async (id) => {
      const myEpoch = epoch
      set({ listId: id, listSymbols: [], optionItems: [], watchError: '' })
      const options = isOptionsList(get().watchlists.find((w) => w.id === id))
      try {
        if (options) {
          // get_watchlist_items is rejected upstream (400) for options lists; they have their own tool.
          const o = await api.rhOptionWatchlist()
          if (get().listId !== id || myEpoch !== epoch) return
          set({ optionItems: o.items, watchError: '' })
        } else {
          const c = await api.rhWatchlistItems(id)
          if (get().listId !== id || myEpoch !== epoch) return
          const symbols = c.items.filter(isEquitySymbol).map((i) => i.symbol)
          set({ listSymbols: symbols, watchError: '' })
        }
      } catch (e) {
        if (get().listId === id && myEpoch === epoch) set({ watchError: msg(e) })
      }
    },

    // ---- watchlist writes: the displayed rows are never edited locally. A write goes to the server, then the list is
    // re-read; if the write fails the old rows stay and the error is shown. ----
    addSymbols: async (input) => {
      const { symbols, error } = parseWatchSymbols(input)
      if (error) {
        set({ watchError: error, watchNote: '' })
        return false
      }
      if (symbols.length === 0) return false
      return writeToList((id) => api.rhWatchlistAdd(id, symbols), `Added ${symbols.join(', ')}.`)
    },

    removeSymbol: async (symbol) => writeToList((id) => api.rhWatchlistRemove(id, [symbol]), `Removed ${symbol}.`),

    createList: async (name, emoji) => {
      const bad = validateListName(name) || validateEmoji(emoji)
      if (bad) {
        set({ watchError: bad, watchNote: '' })
        return false
      }
      if (get().watchBusy) return false
      set({ watchBusy: true, watchError: '', watchNote: '' })
      let created: string | null = null
      try {
        const r = await api.rhWatchlistCreate(name.trim(), emoji.trim() || null, null)
        const wl = (r as { watchlist?: { id?: unknown } }).watchlist
        created = typeof wl?.id === 'string' ? wl.id : null
      } catch (e) {
        set({ watchBusy: false, watchError: msg(e) })
        return false
      }
      try {
        const watchlists = await api.rhWatchlists()
        set({ watchlists })
        if (created && watchlists.some((w) => w.id === created)) await get().selectList(created)
        set({ watchBusy: false, watchNote: `Created ${name.trim()}.` })
      } catch (e) {
        set({ watchBusy: false, watchError: `Created, but the lists could not be reloaded: ${msg(e)}` })
      }
      return true
    },

    renameList: async (name) => {
      const bad = validateListName(name)
      if (bad) {
        set({ watchError: bad, watchNote: '' })
        return false
      }
      return writeToList((id) => api.rhWatchlistUpdate(id, name.trim(), null, null), `Renamed to ${name.trim()}.`)
    },

    watchQuotes: (owner, symbols) => {
      poller.setOwner(owner, symbols)
      const truncated = poller.truncated
      if (truncated !== get().quotesTruncated) set({ quotesTruncated: truncated })
    },
  }
})
