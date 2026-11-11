/**
 * In-memory alert store for the dev page and tests (M17). Same rules as src-tauri/src/alerts.rs: validation, the single guarded fire (enabled, armed,
 * not snoozed, not expired, cooldown over), once alerts disable themselves, rearm alerts disarm until the price retreats, the capped history.
 * INFORM ONLY: nothing here knows about orders.
 */
import type { Alert, AlertEvent, AlertPatch, FireOutcome, NewAlert } from '../alerts/types'

const KINDS = ['price', 'verdict', 'pnl', 'iv', 'earnings', 'order']
const REF_KINDS = ['price', 'apex', 'flip', 'em_hi', 'em_lo', 'fib', 'atr', 'sma', 'pnl', 'verdict', 'iv', 'order']
const DIRS = ['up', 'down', 'either']
const MODES = ['cross', 'touch']
const REPEATS = ['once', 'rearm']
export const FAKE_MAX_ALERTS = 200
export const FAKE_MAX_EVENTS = 1000

const bad = (m: string): never => {
  throw new Error(`invalid input: ${m}`)
}
const sideOf = (px: number, level: number) => (px > level ? 1 : px < level ? -1 : 0)

export interface FireExtra {
  kind?: string
  label?: string
  missed?: boolean
}

export class FakeAlerts {
  alerts: Alert[] = []
  evs: AlertEvent[] = []
  private nextAlert = 1
  private nextEvent = 1

  reset(): void {
    this.alerts = []
    this.evs = []
    this.nextAlert = 1
    this.nextEvent = 1
  }

  eventCount(): number {
    return this.evs.length
  }

  get(id: number): Alert | undefined {
    return this.alerts.find((a) => a.id === id)
  }

  list(): Alert[] {
    return this.alerts.map((a) => ({ ...a }))
  }

  create(n: NewAlert, now = Date.now()): Alert {
    if (!/^[A-Za-z0-9.-]{1,12}$/.test(n.symbol)) bad('symbol must be 1 to 12 characters: A-Z, 0-9, \'.\' or \'-\'')
    if (!KINDS.includes(n.kind)) bad('bad kind')
    if (!REF_KINDS.includes(n.ref_kind)) bad('bad reference kind')
    if (!DIRS.includes(n.dir)) bad('bad direction')
    if (!MODES.includes(n.mode)) bad('bad mode')
    if (!REPEATS.includes(n.repeat)) bad('bad repeat')
    if (!(Number.isFinite(n.price) && n.price > 0 && n.price < 1e9)) bad('price must be a finite number above 0')
    const cooldown = n.cooldown_s ?? 300
    if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 86_400) bad('cooldown must be 0 to 86400 seconds')
    const hyst = n.hysteresis_pct ?? 0.05
    if (!(Number.isFinite(hyst) && hyst >= 0 && hyst <= 5)) bad('hysteresis must be 0 to 5 percent')
    if (n.ref_param != null && (n.ref_kind === 'price' || n.ref_param.length === 0 || n.ref_param.length > 256)) bad('bad reference parameter')
    if (n.tf != null && !/^[A-Za-z0-9]{1,8}$/.test(n.tf)) bad('bad timeframe')
    if (n.last_side != null && ![-1, 0, 1].includes(n.last_side)) bad('side must be -1, 0 or 1')
    if (this.alerts.length >= FAKE_MAX_ALERTS) bad('too many alerts (200 at most)')
    const a: Alert = {
      id: this.nextAlert++, symbol: n.symbol.toUpperCase(), kind: n.kind, ref_kind: n.ref_kind, ref_param: n.ref_param ?? null, price: n.price, dir: n.dir,
      tf: n.tf ?? null, mode: n.mode, repeat: n.repeat, cooldown_s: cooldown, hysteresis_pct: hyst, expires_at: n.expires_at ?? null, snooze_until: null,
      enabled: true, extended_hours: n.extended_hours ?? false, last_side: n.last_side ?? null, armed: true, last_fired_at: null, created_at: now,
    }
    this.alerts.push(a)
    return { ...a }
  }

  update(id: number, p: AlertPatch): Alert {
    if (p.dir !== undefined && !DIRS.includes(p.dir)) bad('bad direction')
    if (p.mode !== undefined && !MODES.includes(p.mode)) bad('bad mode')
    if (p.price !== undefined && !(Number.isFinite(p.price) && p.price > 0)) bad('price must be a finite number above 0')
    if (p.cooldown_s !== undefined && !(p.cooldown_s >= 0 && p.cooldown_s <= 86_400)) bad('cooldown must be 0 to 86400 seconds')
    if (p.hysteresis_pct !== undefined && !(p.hysteresis_pct >= 0 && p.hysteresis_pct <= 5)) bad('hysteresis must be 0 to 5 percent')
    if (p.last_side !== undefined && ![-1, 0, 1].includes(p.last_side)) bad('side must be -1, 0 or 1')
    if (p.observe_px !== undefined && !(Number.isFinite(p.observe_px) && p.observe_px > 0)) bad('observed price must be a finite number above 0')
    const a = this.get(id)
    if (!a) throw new Error('not found: alert')
    const { observe_px, ...rest } = p
    Object.assign(a, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)))
    if (observe_px !== undefined && a.repeat === 'rearm' && a.enabled && !a.armed) {
      const band = (a.price * a.hysteresis_pct) / 100
      const back = a.last_side === 1 ? observe_px <= a.price - band : a.last_side === -1 ? observe_px >= a.price + band : false
      if (back) {
        a.armed = true
        a.last_side = sideOf(observe_px, a.price)
      }
    }
    return { ...a }
  }

  delete(id: number): void {
    if (!this.get(id)) throw new Error('not found: alert')
    this.alerts = this.alerts.filter((a) => a.id !== id)
  }

  fire(id: number, side: number, px: number, ageS: number, now = Date.now(), extra: FireExtra = {}): FireOutcome {
    if (![-1, 0, 1].includes(side)) bad('side must be -1, 0 or 1')
    if (!(Number.isFinite(px) && px > 0)) bad('trigger price must be a finite number above 0')
    if (!(Number.isFinite(ageS) && ageS >= 0)) bad('quote age must be a finite number of seconds, 0 or more')
    const kind = extra.kind ?? 'fire'
    if (!['fire', 'missed', 'level_gone'].includes(kind)) bad('bad event kind')
    if (extra.label !== undefined && (extra.label.length < 1 || extra.label.length > 160 || /[\u0000-\u001f]/.test(extra.label))) bad('label must be 1 to 160 characters without control characters')
    const a = this.get(id)
    if (!a) return { outcome: 'skipped', reason: 'missing' }
    if (kind === 'level_gone') {
      if (!a.enabled) return { outcome: 'skipped', reason: 'disabled' }
      if (a.snooze_until !== null && a.snooze_until > now) return { outcome: 'skipped', reason: 'snoozed' }
      a.snooze_until = now + 24 * 3_600_000
      const ev: AlertEvent = { id: this.nextEvent++, alert_id: a.id, fired_at: now, symbol: a.symbol, label: extra.label ?? `${a.symbol} level gone`, trigger_px: px, ref_px: a.price, quote_age_s: ageS, kind, seen: false, missed: false }
      this.evs.push(ev)
      return { outcome: 'fired', event: { ...ev } }
    }
    const ok =
      a.enabled && a.armed && (a.snooze_until === null || a.snooze_until <= now) && (a.expires_at === null || a.expires_at > now) &&
      (a.last_fired_at === null || a.last_fired_at <= now - a.cooldown_s * 1000)
    a.last_side = side
    if (!ok) {
      const reason = !a.enabled ? 'disabled' : !a.armed ? 'disarmed' : a.snooze_until !== null && a.snooze_until > now ? 'snoozed' : a.expires_at !== null && a.expires_at <= now ? 'expired' : 'cooldown'
      return { outcome: 'skipped', reason }
    }
    a.last_fired_at = now
    if (a.repeat === 'once') a.enabled = false
    if (a.repeat === 'rearm') a.armed = false
    const way = side === 1 ? 'above' : side === -1 ? 'below' : 'at'
    const ev: AlertEvent = { id: this.nextEvent++, alert_id: a.id, fired_at: now, symbol: a.symbol, label: extra.label ?? `${a.symbol} ${way} ${a.price.toFixed(2)}`, trigger_px: px, ref_px: a.price, quote_age_s: ageS, kind, seen: false, missed: extra.missed === true || kind === 'missed' }
    this.evs.push(ev)
    if (this.evs.length > FAKE_MAX_EVENTS) this.evs.splice(0, this.evs.length - FAKE_MAX_EVENTS)
    return { outcome: 'fired', event: { ...ev } }
  }

  /** Dev/test seeding of a history row (a fired or missed event) without going through `fire`. */
  seedEvent(e: Partial<AlertEvent> & { symbol: string; label: string }): AlertEvent {
    const ev: AlertEvent = { id: this.nextEvent++, alert_id: 0, fired_at: Date.now(), trigger_px: 0, ref_px: 0, quote_age_s: 0, kind: 'fire', seen: false, missed: false, ...e }
    this.evs.push(ev)
    return { ...ev }
  }

  events(limit: number | null, unseenOnly: boolean): AlertEvent[] {
    const n = Math.min(Math.max(limit ?? 200, 1), 1000)
    return this.evs
      .filter((e) => !unseenOnly || !e.seen)
      .sort((a, b) => b.fired_at - a.fired_at || b.id - a.id)
      .slice(0, n)
      .map((e) => ({ ...e }))
  }

  ack(ids: number[] | null): number {
    if (ids !== null && ids.length > 500) bad('too many ids')
    let n = 0
    for (const e of this.evs) {
      if (!e.seen && (ids === null || ids.includes(e.id))) {
        e.seen = true
        n += 1
      }
    }
    return n
  }
}

export const fakeAlerts = new FakeAlerts()
