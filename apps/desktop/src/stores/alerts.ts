/**
 * Alerts store (M17). Holds the stored alerts and history, the toast queue and the session snoozes, and runs one evaluation pass per quote batch.
 * INFORM ONLY: it talks to the alert commands and nothing else. Events are always stored; only the TOASTS are rate limited (see alerts/spam.ts).
 */
import { create } from 'zustand'
import { armedAlerts, snoozeUntil } from '../alerts/active'
import { Deliverer } from '../alerts/deliver'
import { runAlertTick } from '../alerts/engine'
import { sideOf } from '../alerts/evaluate'
import { resolveRef } from '../alerts/levelRefs'
import { runMissedPass } from '../alerts/missed'
import { sessionAt } from '../alerts/session'
import { createSound } from '../alerts/sound'
import { SpamGate } from '../alerts/spam'
import { diffOrders, evalLevelTrigger, verdictFire, type OrderSnap } from '../alerts/triggers'
import type { Alert, AlertEvent, AlertPatch, NewAlert, Side, SnoozeChoice } from '../alerts/types'
import { api, type RhQuote } from '../lib/api'
import type { Verdict } from '../lib/strikeCheck'
import { snapFor } from './alertLevels'

export interface ToastItem {
  id: string
  kind: 'fire' | 'more'
  text: string
  symbol: string
  at: number
}

const MAX_EVENTS_KEPT = 200
const MAX_TOASTS = 8
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const gate = new SpamGate()
let toastSeq = 0
const sound = createSound()
export const PREF_SOUND = 'alerts.sound'
export const PREF_OS = 'alerts.os'
export const LAST_RUN = 'alerts.last_run'
const FIRE_PX = 1 // a non-price alert has no trigger price; the fire command needs a positive number
const safeJson = <T,>(s: string | null): T | null => {
  try {
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}

interface AlertsState {
  alerts: Alert[]
  events: AlertEvent[]
  unseen: number
  toasts: ToastItem[]
  /** Alert ids snoozed "for the session": in memory only, gone on restart. */
  sessionSnoozed: number[]
  error: string
  prefs: { sound: boolean; os: boolean }
  /** The OS notification failed once: the toggle shows "OS notifications unavailable" and nothing is retried. */
  osUnavailable: boolean
  load: () => Promise<void>
  loadEvents: () => Promise<void>
  create: (n: NewAlert) => Promise<Alert | null>
  update: (id: number, patch: AlertPatch) => Promise<Alert | null>
  setEnabled: (id: number, enabled: boolean) => Promise<void>
  remove: (id: number) => Promise<void>
  snooze: (id: number, choice: SnoozeChoice) => Promise<void>
  ack: (ids?: number[]) => Promise<void>
  dismissToast: (id: string) => void
  /** Records a fired event: history, unseen badge and (spam permitting) a toast. */
  notifyFired: (e: AlertEvent) => void
  armedCount: () => number
  loadPrefs: () => Promise<void>
  setPref: (k: 'sound' | 'os', v: boolean) => Promise<void>
  /** First user click: primes audio. */
  unlockAudio: () => void
  /** A price alert from the chart (right-click, Alt+A, a level). The side is recorded by the first observation. */
  createPriceAlert: (a: { symbol: string; price: number; dir: 'up' | 'down' | 'either'; ref?: { ref_kind: NewAlert['ref_kind']; ref_param: string | null } | null }) => Promise<Alert | null>
  /** A manual alert dragged to a new price: the price and the side (against `lastPx`) are rewritten in ONE update, so a drag never fires. */
  dragTo: (id: number, price: number, lastPx: number) => Promise<Alert | null>
  /** A by-reference alert dragged: becomes a manual alert at the new price (new row, old row removed). */
  convertAndMove: (id: number, price: number, lastPx: number) => Promise<Alert | null>
  /** Order changes from the Robinhood orders list (plain projections). */
  onOrders: (orders: OrderSnap[]) => Promise<void>
  /** P&L and verdict alerts from what the app holds; the caller supplies the numbers. */
  checkHoldings: (h: HoldingsView) => Promise<void>
  /** IV rank per symbol (0..100). */
  checkIv: (ivBySymbol: Record<string, number>) => Promise<void>
  /** The app-closed pass (once per launch). */
  runMissed: (since: number) => Promise<void>
  /** One pass over a quote batch (called by the quote poller). */
  onQuotes: (q: RhQuote[], meta: { startedAt: number }) => Promise<void>
  /** Session wipe: toasts and the spam window go; the alerts themselves are local data and stay. */
  wipe: () => void
  reset: () => void
}

export interface HoldingsView {
  /** Current P&L in dollars per position key (an option_id or an equity symbol); a missing key = unknown. */
  pnl: Record<string, number | null>
  /** Strike-check verdict per option_id (short legs); a missing key = unknown. */
  verdict: Record<string, Verdict>
  /** Earnings date inside the trade, per option_id: true / false / null (unknown). */
  earningsInside: Record<string, boolean | null>
}

const INITIAL = { alerts: [] as Alert[], events: [] as AlertEvent[], unseen: 0, toasts: [] as ToastItem[], sessionSnoozed: [] as number[], error: '', prefs: { sound: true, os: true }, osUnavailable: false }

export const useAlertsStore = create<AlertsState>((set, get) => {
  const patchLocal = (id: number, p: Partial<Alert>) => set((s) => ({ alerts: s.alerts.map((a) => (a.id === id ? { ...a, ...p } : a)) }))
  const replace = (a: Alert) => set((s) => ({ alerts: s.alerts.some((x) => x.id === a.id) ? s.alerts.map((x) => (x.id === a.id ? a : x)) : [...s.alerts, a] }))
  const refresh = async () => {
    try {
      set({ alerts: await api.alertList() })
    } catch (e) {
      set({ error: msg(e) })
    }
  }

  const deliverer = new Deliverer({
    notify: (t, b) => api.alertNotify(t, b),
    playSound: () => sound.play(),
    onUnavailable: () => set({ osUnavailable: true }),
    prefs: () => get().prefs,
  })
  const fireExtra = async (a: Alert, side: number, px: number, label: string): Promise<void> => {
    try {
      const out = await api.alertFire(a.id, side, px, 0, { label })
      if (out.outcome === 'fired') {
        get().notifyFired(out.event)
        await refresh()
      }
    } catch (e) {
      set({ error: msg(e) })
    }
  }
  const verdictSeen = new Map<number, Verdict>()
  let ordersSeen: OrderSnap[] | null = null

  return {
    ...INITIAL,

    loadPrefs: async () => {
      try {
        const [snd, os] = await Promise.all([api.settingGet(PREF_SOUND), api.settingGet(PREF_OS)])
        set({ prefs: { sound: snd !== 'off', os: os !== 'off' } })
      } catch {
        /* defaults stay */
      }
    },

    setPref: async (k, v) => {
      set((s) => ({ prefs: { ...s.prefs, [k]: v } }))
      if (k === 'os' && v) deliverer.reset()
      if (k === 'os' && v) set({ osUnavailable: false })
      try {
        await api.settingSet(k === 'sound' ? PREF_SOUND : PREF_OS, v ? 'on' : 'off')
      } catch (e) {
        set({ error: msg(e) })
      }
    },

    unlockAudio: () => sound.unlock(),

    createPriceAlert: async ({ symbol, price, dir, ref }) => {
      const p = Number(price.toFixed(2))
      if (!(p > 0)) {
        set({ error: 'price must be above 0' })
        return null
      }
      return get().create({ symbol, kind: 'price', ref_kind: ref?.ref_kind ?? 'price', ref_param: ref?.ref_param ?? null, price: p, dir, mode: 'cross', repeat: 'once' })
    },

    dragTo: async (id, price, lastPx) => {
      const p = Number(price.toFixed(2))
      if (!(p > 0)) return null
      // price and side in one update: after a drag the next observation sees no flip, so releasing never fires
      return get().update(id, { price: p, last_side: sideOf(lastPx, p) })
    },

    convertAndMove: async (id, price, lastPx) => {
      const a = get().alerts.find((x) => x.id === id)
      if (!a) return null
      const made = await get().createPriceAlert({ symbol: a.symbol, price, dir: a.dir })
      if (!made) return null
      await get().remove(id)
      return get().dragTo(made.id, price, lastPx)
    },

    onOrders: async (orders) => {
      const changes = diffOrders(ordersSeen, orders)
      ordersSeen = orders
      for (const c of changes) {
        const hits = get().alerts.filter((a) => a.kind === 'order' && a.enabled && a.armed && a.symbol === c.symbol)
        for (const a of hits) await fireExtra(a, 0, FIRE_PX, c.text)
      }
    },

    checkHoldings: async (h) => {
      for (const a of get().alerts) {
        if (!a.enabled || !a.armed) continue
        if (a.kind === 'pnl') {
          const cfg = safeJson<{ pos: string; thr: number; opt?: boolean }>(a.ref_param)
          const v = cfg ? h.pnl[cfg.pos] : null
          if (!cfg || v === null || v === undefined || !Number.isFinite(cfg.thr)) continue
          const r = evalLevelTrigger(cfg.thr, cfg.thr < 0 ? 'down' : 'up', a.last_side as Side | null, v)
          if (r.observed && r.side !== a.last_side) {
            set((s) => ({ alerts: s.alerts.map((x) => (x.id === a.id ? { ...x, last_side: r.side } : x)) }))
            void api.alertUpdate(a.id, { last_side: r.side }).catch((e) => set({ error: msg(e) }))
          }
          if (r.fire) await fireExtra(a, r.side, FIRE_PX, `${a.symbol} P&L ${v.toFixed(2)} crossed ${cfg.thr}${cfg.opt ? ' (option P&L units unverified)' : ''}`)
        } else if (a.kind === 'verdict') {
          const cfg = safeJson<{ opt: string; to: Verdict }>(a.ref_param)
          if (!cfg) continue
          const next = h.verdict[cfg.opt]
          if (!next) continue
          const prev = verdictSeen.get(a.id) ?? null
          const r = verdictFire(prev, next, cfg.to)
          verdictSeen.set(a.id, r.next)
          if (r.fire) await fireExtra(a, 0, FIRE_PX, `${a.symbol} strike check: ${prev} to ${next}`)
        } else if (a.kind === 'earnings') {
          const cfg = safeJson<{ opt: string }>(a.ref_param)
          if (cfg && h.earningsInside[cfg.opt] === true) await fireExtra(a, 0, FIRE_PX, `${a.symbol} earnings fall inside your short's expiry`)
        }
      }
    },

    checkIv: async (ivBySymbol) => {
      for (const a of get().alerts) {
        if (a.kind !== 'iv' || !a.enabled || !a.armed) continue
        const v = ivBySymbol[a.symbol]
        if (v === undefined || !Number.isFinite(v)) continue
        const r = evalLevelTrigger(a.price, a.dir, a.last_side as Side | null, v)
        if (r.observed && r.side !== a.last_side) {
          set((s) => ({ alerts: s.alerts.map((x) => (x.id === a.id ? { ...x, last_side: r.side } : x)) }))
          void api.alertUpdate(a.id, { last_side: r.side }).catch((e) => set({ error: msg(e) }))
        }
        if (r.fire) await fireExtra(a, r.side, FIRE_PX, `${a.symbol} IV rank ${v.toFixed(1)} crossed ${a.price}`)
      }
    },

    runMissed: async (since) => {
      const rep = await runMissedPass(get().alerts, {
        since,
        loadCandles: (a, from) => api.candlesLoad('rh_equity', a.symbol, '5m', from, Date.now(), 2000),
        quotes: (syms) => api.rhQuotes(syms),
        fire: (id, side, px, age, extra) => api.alertFire(id, side, px, age, extra),
      })
      if (rep.events.length > 0) {
        // stored and listed under "While you were away"; one in-app summary toast, never a sound or an OS notice
        set((s) => ({ events: [...rep.events, ...s.events].slice(0, MAX_EVENTS_KEPT), unseen: s.unseen + rep.events.length }))
        toastSeq += 1
        const t: ToastItem = { id: `t${toastSeq}`, kind: 'more', text: `${rep.events.length} alert${rep.events.length === 1 ? '' : 's'} crossed while you were away`, symbol: '', at: Date.now() }
        set((s) => ({ toasts: [...s.toasts, t].slice(-MAX_TOASTS) }))
        await refresh()
      }
    },

    load: async () => {
      await refresh()
      await get().loadEvents()
    },

    loadEvents: async () => {
      try {
        const events = await api.alertEvents(MAX_EVENTS_KEPT, false)
        set({ events, unseen: events.filter((e) => !e.seen).length })
      } catch (e) {
        set({ error: msg(e) })
      }
    },

    create: async (n) => {
      try {
        const a = await api.alertCreate(n)
        replace(a)
        set({ error: '' })
        return a
      } catch (e) {
        set({ error: msg(e) })
        return null
      }
    },

    update: async (id, patch) => {
      try {
        const a = await api.alertUpdate(id, patch)
        replace(a)
        set({ error: '' })
        return a
      } catch (e) {
        set({ error: msg(e) })
        return null
      }
    },

    setEnabled: async (id, enabled) => {
      await get().update(id, { enabled })
    },

    remove: async (id) => {
      try {
        await api.alertDelete(id)
        set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id), sessionSnoozed: s.sessionSnoozed.filter((x) => x !== id) }))
      } catch (e) {
        set({ error: msg(e) })
      }
    },

    snooze: async (id, choice) => {
      const a = get().alerts.find((x) => x.id === id)
      if (!a) return
      const until = snoozeUntil(choice, Date.now())
      set((s) => ({ sessionSnoozed: choice === 'session' ? [...new Set([...s.sessionSnoozed, id])] : s.sessionSnoozed.filter((x) => x !== id) }))
      if (until !== null) await get().update(id, { snooze_until: until })
      else if ((a.snooze_until ?? 0) > 0) await get().update(id, { snooze_until: 0 })
    },

    ack: async (ids) => {
      try {
        await api.alertEventsAck(ids ?? null)
        set((s) => {
          const events = s.events.map((e) => (!ids || ids.includes(e.id) ? { ...e, seen: true } : e))
          return { events, unseen: events.filter((e) => !e.seen).length }
        })
      } catch (e) {
        set({ error: msg(e) })
      }
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    notifyFired: (e) => {
      const now = Date.now()
      set((s) => ({ events: [e, ...s.events.filter((x) => x.id !== e.id)].slice(0, MAX_EVENTS_KEPT), unseen: s.unseen + (e.seen ? 0 : 1) }))
      void deliverer.deliver(e)
      const adm = gate.admit(e.symbol, now)
      if (adm.show) {
        toastSeq += 1
        const t: ToastItem = { id: `t${toastSeq}`, kind: 'fire', text: `${e.label} (last ${e.trigger_px.toFixed(2)})`, symbol: e.symbol, at: now }
        set((s) => ({ toasts: [...s.toasts, t].slice(-MAX_TOASTS) }))
      } else {
        // ONE summary toast, updated in place
        const t: ToastItem = { id: 'more', kind: 'more', text: `${adm.more} more alert${adm.more === 1 ? '' : 's'}`, symbol: '', at: now }
        set((s) => ({ toasts: [...s.toasts.filter((x) => x.id !== 'more'), t].slice(-MAX_TOASTS) }))
      }
    },

    armedCount: () => armedAlerts(get().alerts, Date.now(), new Set(get().sessionSnoozed)).length,

    onQuotes: async (q, meta) => {
      const alerts = get().alerts
      if (alerts.length === 0) return
      const rep = await runAlertTick(alerts, q, meta, {
        now: () => Date.now(),
        session: sessionAt,
        sessionSnoozed: new Set(get().sessionSnoozed),
        levelFor: (a) => resolveRef(a, snapFor(a.symbol)),
        follow: (id, level, side) => {
          patchLocal(id, { price: level, last_side: side })
          void api.alertUpdate(id, { price: level, last_side: side }).catch((e) => set({ error: msg(e) }))
        },
        levelGone: async (a, px) => {
          const out = await api.alertFire(a.id, 0, px, 0, { kind: 'level_gone', label: `${a.symbol} level gone: ${a.ref_kind} ${a.ref_param ?? ''} (alert snoozed 24 h)`.replace(/\s+/g, ' ') })
          if (out.outcome === 'fired') {
            get().notifyFired(out.event)
            await refresh()
          }
        },
        fire: (id, side, px, age) => api.alertFire(id, side, px, age),
        setSide: (id, side) => {
          patchLocal(id, { last_side: side })
          if (side !== null) void api.alertUpdate(id, { last_side: side }).catch((e) => set({ error: msg(e) }))
        },
        rearm: (id, px) => void api.alertUpdate(id, { observe_px: px }).then(replace).catch((e) => set({ error: msg(e) })),
      })
      if (rep.fired.length > 0) {
        for (const e of rep.fired) get().notifyFired(e)
        await refresh()
      }
    },

    wipe: () => {
      gate.reset()
      deliverer.reset()
      ordersSeen = null
      verdictSeen.clear()
      set({ toasts: [] })
    },

    reset: () => {
      gate.reset()
      deliverer.reset()
      ordersSeen = null
      verdictSeen.clear()
      set({ ...INITIAL })
    },
  }
})
