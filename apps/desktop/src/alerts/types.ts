/** Alert shapes (M17). They mirror src-tauri/src/alerts.rs one to one. INFORM ONLY: nothing in src/alerts may touch orders or the ticket. */
export type AlertKind = 'price' | 'verdict' | 'pnl' | 'iv' | 'earnings' | 'order'
export type AlertRefKind = 'price' | 'apex' | 'flip' | 'em_hi' | 'em_lo' | 'fib' | 'atr' | 'sma' | 'pnl' | 'verdict' | 'iv' | 'order'
export type AlertDir = 'up' | 'down' | 'either'
export type AlertMode = 'cross' | 'touch'
export type AlertRepeat = 'once' | 'rearm'
export type Side = -1 | 0 | 1

export interface Alert {
  id: number
  symbol: string
  kind: AlertKind
  ref_kind: AlertRefKind
  ref_param: string | null
  /** The level. For a by-reference alert this is the frozen value (display and fallback only). */
  price: number
  dir: AlertDir
  tf: string | null
  mode: AlertMode
  repeat: AlertRepeat
  cooldown_s: number
  hysteresis_pct: number
  /** UTC epoch ms. */
  expires_at: number | null
  snooze_until: number | null
  enabled: boolean
  extended_hours: boolean
  last_side: number | null
  armed: boolean
  last_fired_at: number | null
  created_at: number
}

export interface NewAlert {
  symbol: string
  kind: AlertKind
  ref_kind: AlertRefKind
  ref_param?: string | null
  price: number
  dir: AlertDir
  tf?: string | null
  mode: AlertMode
  repeat: AlertRepeat
  cooldown_s?: number | null
  hysteresis_pct?: number | null
  expires_at?: number | null
  extended_hours?: boolean
  last_side?: number | null
}

/** `snooze_until` 0 clears a snooze. `observe_px` re-arms a fired `rearm` alert once the price has retreated. `last_side` is how a drag resets the side. */
export interface AlertPatch {
  price?: number
  dir?: AlertDir
  mode?: AlertMode
  cooldown_s?: number
  hysteresis_pct?: number
  expires_at?: number
  snooze_until?: number
  enabled?: boolean
  extended_hours?: boolean
  last_side?: number
  armed?: boolean
  observe_px?: number
}

export type EventKind = 'fire' | 'level_gone' | 'missed'

export interface AlertEvent {
  id: number
  alert_id: number
  fired_at: number
  symbol: string
  label: string
  trigger_px: number
  ref_px: number
  quote_age_s: number
  kind: string
  seen: boolean
  missed: boolean
}

export type FireOutcome = { outcome: 'fired'; event: AlertEvent } | { outcome: 'skipped'; reason: string }

export type SnoozeChoice = 'off' | '15m' | '1h' | 'session'
