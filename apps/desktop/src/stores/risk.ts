/**
 * R tools store (M18). INFORMATIONAL ONLY: this store holds numbers and text; nothing here can gate, disable or change an order, and it
 * does not import the orders store or the ticket (a test greps for that). The ticket host calls `putDraft` / `attachOrder` with values it
 * took from the REVIEWED order; the Journal calls `confirmSuggestion` / `saveManual` on an explicit click. Nothing is ever promoted
 * automatically.
 */
import { create } from 'zustand'
import { api, type DraftFieldsIn, type ManualRiskIn, type RhPnlTrade, type RiskDraft, type RiskSettings, type RiskStatsOut, type TradeRisk } from '../lib/api'
import { DEFAULT_HELPER, SETTING_BASIS, SETTING_MODE, type HelperInputs } from '../lib/riskHelper'

const msg = (e: unknown): string => (e instanceof Error ? e.message.replace(/^invalid input: /, '') : String(e))

interface RiskState {
  settings: RiskSettings | null
  /** Stored trade risk by trade_key (editor prefill). */
  risk: Record<string, TradeRisk>
  drafts: RiskDraft[]
  /** The last joined stats answer (null until the Journal has loaded trades). */
  stats: RiskStatsOut | null
  /** The trade list the stats were last computed for (so a write can re-join without the Journal). */
  lastTrades: RhPnlTrade[]
  lastAccount: string | null
  error: string
  /** A plain, non-error remark (for example "no R recorded for this order"). */
  note: string
  /** What is typed into the sizing helper; shared so the ticket host can read the stop at review time. */
  helper: HelperInputs
  loaded: boolean

  load: () => Promise<void>
  setRiskPct: (pct: number) => Promise<boolean>
  setApproximation: (on: boolean) => Promise<boolean>
  rememberHelper: (v: { basis?: HelperInputs['basis']; mode?: HelperInputs['mode'] }) => Promise<void>
  /** Merges a patch; a different symbol, side or kind first clears the stop and price numbers (they were typed for something else). */
  setHelper: (patch: Partial<HelperInputs>) => void
  putDraft: (reviewId: string, fields: DraftFieldsIn) => Promise<boolean>
  attachOrder: (reviewId: string, orderId: string) => Promise<boolean>
  confirmSuggestion: (tradeKey: string, reviewId: string) => Promise<boolean>
  saveManual: (tradeKey: string, manual: ManualRiskIn) => Promise<boolean>
  refreshStats: (trades: RhPnlTrade[], accountMasked: string | null) => Promise<void>
  /** Session wipe: drops what came from Robinhood (trades, joined stats). Stored settings and drafts are local data and stay. */
  wipe: () => void
  reset: () => void
}

const INITIAL = {
  settings: null as RiskSettings | null,
  risk: {} as Record<string, TradeRisk>,
  drafts: [] as RiskDraft[],
  stats: null as RiskStatsOut | null,
  lastTrades: [] as RhPnlTrade[],
  lastAccount: null as string | null,
  error: '',
  note: '',
  helper: { ...DEFAULT_HELPER } as HelperInputs,
  loaded: false,
}

let statsSeq = 0

const CONTEXT_KEYS: (keyof HelperInputs)[] = ['entry', 'stop', 'width', 'credit', 'stopBuyback', 'strike']

export const useRiskStore = create<RiskState>((set, get) => {
  const reJoin = async (): Promise<void> => {
    const { lastTrades, lastAccount } = get()
    if (lastTrades.length > 0) await get().refreshStats(lastTrades, lastAccount)
  }

  return {
    ...INITIAL,

    load: async () => {
      try {
        const [state, basis, mode] = await Promise.all([api.riskGet(), api.settingGet(SETTING_BASIS).catch(() => null), api.settingGet(SETTING_MODE).catch(() => null)])
        const risk: Record<string, TradeRisk> = {}
        for (const r of state.risk) risk[r.trade_key] = r
        const h = get().helper
        const next: Partial<HelperInputs> = {}
        if (!h.touched) next.riskPct = String(state.settings.default_risk_pct)
        if (basis === 'spread_max_loss' || basis === 'stop_mult') next.basis = basis
        if (mode === 'pct' || mode === 'usd') next.mode = mode
        set({ settings: state.settings, risk, drafts: state.drafts, error: '', loaded: true, helper: { ...h, ...next } })
      } catch (e) {
        set({ error: msg(e) })
      }
    },

    setRiskPct: async (pct) => {
      try {
        const settings = await api.riskSet({ default_risk_pct: pct })
        set({ settings, error: '', helper: { ...get().helper, riskPct: String(settings.default_risk_pct) } })
        return true
      } catch (e) {
        set({ error: msg(e) })
        return false
      }
    },

    setApproximation: async (on) => {
      try {
        set({ settings: await api.riskSet({ r_fallback_enabled: on }), error: '' })
        return true
      } catch (e) {
        set({ error: msg(e) })
        return false
      }
    },

    rememberHelper: async (v) => {
      set({ helper: { ...get().helper, ...v } })
      try {
        if (v.basis) await api.settingSet(SETTING_BASIS, v.basis)
        if (v.mode) await api.settingSet(SETTING_MODE, v.mode)
      } catch {
        // a remembered convenience only
      }
    },

    setHelper: (patch) => {
      const cur = get().helper
      const moved = (patch.symbol !== undefined && patch.symbol !== cur.symbol) || (patch.kind !== undefined && patch.kind !== cur.kind) || (patch.side !== undefined && patch.side !== cur.side)
      const base: HelperInputs = { ...cur }
      if (moved) {
        for (const k of CONTEXT_KEYS) (base as unknown as Record<string, unknown>)[k] = ''
        base.touched = false
      }
      set({ helper: { ...base, ...patch } })
    },

    putDraft: async (reviewId, fields) => {
      try {
        const d = await api.riskDraftPut({ review_id: reviewId, fields })
        set({ drafts: [d, ...get().drafts.filter((x) => x.review_id !== d.review_id)], error: '', note: '' })
        return true
      } catch (e) {
        set({ error: msg(e) })
        return false
      }
    },

    attachOrder: async (reviewId, orderId) => {
      try {
        const d = await api.riskDraftPut({ review_id: reviewId, order_id: orderId })
        set({ drafts: [d, ...get().drafts.filter((x) => x.review_id !== d.review_id)], error: '' })
        return true
      } catch (e) {
        const m = msg(e)
        // an expired or never-created draft simply means this order has no R (never guessed)
        if (/^not found/i.test(m)) set({ note: 'No R recorded for this order: the planned risk was not saved with the review, or it expired.' })
        else set({ error: m })
        return false
      }
    },

    confirmSuggestion: async (tradeKey, reviewId) => {
      try {
        const row = await api.riskPromote({ trade_key: tradeKey, review_id: reviewId })
        set({ risk: { ...get().risk, [row.trade_key]: row }, drafts: get().drafts.filter((d) => d.review_id !== reviewId), error: '' })
      } catch (e) {
        set({ error: msg(e) })
        return false
      }
      await reJoin()
      return true
    },

    saveManual: async (tradeKey, manual) => {
      try {
        const row = await api.riskPromote({ trade_key: tradeKey, manual })
        set({ risk: { ...get().risk, [row.trade_key]: row }, error: '' })
      } catch (e) {
        set({ error: msg(e) })
        return false
      }
      await reJoin()
      return true
    },

    refreshStats: async (trades, accountMasked) => {
      const my = ++statsSeq
      set({ lastTrades: trades, lastAccount: accountMasked })
      try {
        const out = await api.riskStats(
          accountMasked,
          trades.map((t) => ({ trade_key: t.trade_key, symbol: t.symbol, side: t.side, quantity: t.quantity, realized_gain: t.realized_gain, timestamp: t.timestamp })),
        )
        if (my === statsSeq) set({ stats: out, error: '' })
      } catch (e) {
        if (my === statsSeq) set({ error: msg(e) })
      }
    },

    wipe: () => {
      statsSeq += 1
      set({ stats: null, lastTrades: [], lastAccount: null, error: '', note: '' })
    },

    reset: () => {
      statsSeq += 1
      set({ ...INITIAL, helper: { ...DEFAULT_HELPER } })
    },
  }
})
