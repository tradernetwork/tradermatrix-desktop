/**
 * Feeds for the non-price alerts (M17 tasks 9 to 11): P&L and strike-check verdict from the positions, earnings inside an expiry, IV rank from the TM cache,
 * order-state changes from the orders list, the once-per-launch app-closed pass, and the audio unlock. READ-ONLY: it calls the existing read commands
 * (positions, orders, earnings, TM iv) and hands plain numbers to the alerts store. INFORM ONLY: no order command and no ticket.
 */
import { optionPnl } from '../lib/optionPositions'
import { positionRow } from '../lib/format'
import { api, type EarningsInfo, type RhOptionPosition, type RhPosition, type RhQuote } from '../lib/api'
import { buildStrikeInput, localIsoDate, rowFromPosition, strikeCheck, type TmBits, type Verdict } from '../lib/strikeCheck'
import { quotePx } from '../alerts/engine'
import { LAST_RUN, useAlertsStore, type HoldingsView } from './alerts'
import { useRhStore } from './rh'
import { useTmStore } from './tm'

export const FEED_MS = 60_000
export const IV_MS = 300_000
const EARNINGS_DAY_MS = 86_400_000

export interface HoldingsArgs {
  options: readonly RhOptionPosition[]
  equities: readonly RhPosition[]
  quotes: Record<string, RhQuote | undefined>
  tmBits: (symbol: string) => TmBits
  earnings: (symbol: string) => EarningsInfo | null
  today: string
}

/** P&L per position and the strike-check verdict per short option, from the same pure functions the Positions pane uses. */
export function buildHoldings(a: HoldingsArgs): HoldingsView {
  const pnl: HoldingsView['pnl'] = {}
  const verdict: Record<string, Verdict> = {}
  const earn: HoldingsView['earningsInside'] = {}
  for (const e of a.equities) {
    const q = a.quotes[e.symbol]
    pnl[e.symbol] = positionRow(e, q ? quotePx(q) : null).pnl
  }
  for (const o of a.options) {
    pnl[o.option_id] = optionPnl(o).pnl
    if (o.side !== 'short') continue
    const q = a.quotes[o.chain_symbol]
    const e = a.earnings(o.chain_symbol)
    const input = buildStrikeInput({ side: 'sell', row: rowFromPosition(o), spot: q ? quotePx(q) : null, tm: a.tmBits(o.chain_symbol), earnings: e, earningsStatus: e ? 'ok' : 'unknown', today: a.today })
    if (!input) continue
    const r = strikeCheck(input)
    verdict[o.option_id] = r.verdict ?? 'unknown'
    earn[o.option_id] = r.eventInside
  }
  return { pnl, verdict, earningsInside: earn }
}

const earningsCache = new Map<string, { at: number; data: EarningsInfo | null }>()
async function earningsFor(symbol: string): Promise<EarningsInfo | null> {
  const c = earningsCache.get(symbol)
  if (c && Date.now() - c.at < EARNINGS_DAY_MS) return c.data
  let data: EarningsInfo | null = null
  try {
    data = await api.rhEarnings(symbol)
  } catch {
    /* unknown stays unknown: never "no earnings" */
  }
  earningsCache.set(symbol, { at: Date.now(), data })
  return data
}

const tmBits = (symbol: string): TmBits => {
  const e = useTmStore.getState().bySymbol[symbol]
  return { apex: e?.apex.data ?? null, move: e?.move.data ?? null, iv: e?.iv.data ?? null }
}

export function startAlertFeeds(): () => void {
  const alerts = () => useAlertsStore.getState()
  void alerts().loadPrefs()
  const unlock = () => alerts().unlockAudio()
  document.addEventListener('pointerdown', unlock, { once: true })

  let lastRun = 0
  let ranMissed = false
  let stopped = false
  void api.settingGet(LAST_RUN).then((v) => {
    lastRun = Number(v) || 0
  }).catch(() => undefined)

  const maybeMissed = () => {
    if (ranMissed || stopped) return
    const rh = useRhStore.getState()
    if (rh.status?.connected !== true || alerts().alerts.length === 0) return
    ranMissed = true
    void alerts().runMissed(lastRun).catch((e) => console.warn('missed-alert pass failed (ignored)', e))
  }
  const unsubRh = useRhStore.subscribe((s, prev) => {
    if (s.orders !== prev.orders) void alerts().onOrders(s.orders.map((o) => ({ id: o.id, symbol: o.symbol, state: o.state })))
    maybeMissed()
  })
  const unsubAlerts = useAlertsStore.subscribe(maybeMissed)

  let lastIv = 0
  let lastTm = 0
  const tick = async () => {
    if (stopped) return
    const list = alerts().alerts.filter((a) => a.enabled && a.armed)
    const rh = useRhStore.getState()
    if (rh.status?.connected === true) {
      if (list.some((a) => a.kind === 'order')) await rh.loadOrders()
      if (list.some((a) => a.kind === 'pnl' || a.kind === 'verdict' || a.kind === 'earnings')) {
        await rh.loadPositions()
        const syms = [...new Set(useRhStore.getState().optionPositions.filter((o) => o.side === 'short').map((o) => o.chain_symbol))]
        for (const s of syms) await earningsFor(s)
        if (list.some((a) => a.kind === 'verdict') && Date.now() - lastTm >= IV_MS) {
          lastTm = Date.now()
          // opportunistic: the same TM call budget as everything else, and dropped (never queued) when it is tight
          for (const s of syms) await useTmStore.getState().loadSymbol(s, ['apex', 'move', 'iv'], false, 'opportunistic')
        }
        const st = useRhStore.getState()
        await alerts().checkHoldings(buildHoldings({ options: st.optionPositions, equities: st.positions, quotes: st.quotes, tmBits, earnings: (s) => earningsCache.get(s)?.data ?? null, today: localIsoDate() }))
      }
    }
    const ivSyms = [...new Set(list.filter((a) => a.kind === 'iv').map((a) => a.symbol))]
    if (ivSyms.length > 0 && Date.now() - lastIv >= IV_MS) {
      lastIv = Date.now()
      const vals: Record<string, number> = {}
      for (const s of ivSyms) {
        await useTmStore.getState().loadSymbol(s, ['iv'], false, 'opportunistic')
        const v = useTmStore.getState().bySymbol[s]?.iv.data?.iv_rank
        if (typeof v === 'number' && Number.isFinite(v)) vals[s] = v
      }
      await alerts().checkIv(vals)
    }
    void api.settingSet(LAST_RUN, String(Date.now())).catch(() => undefined)
  }
  const id = setInterval(() => void tick().catch((e) => console.warn('alert feed failed (ignored)', e)), FEED_MS)
  return () => {
    stopped = true
    clearInterval(id)
    unsubRh()
    unsubAlerts()
    document.removeEventListener('pointerdown', unlock)
  }
}
