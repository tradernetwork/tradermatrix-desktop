/** Which alerts are watched, armed and snoozed (M17). Pure. */
import type { Alert, SnoozeChoice } from './types'

const EMPTY: ReadonlySet<number> = new Set()
const MIN_MS = 60_000

/** Watched at all: enabled, armed and not expired. A snoozed alert is still watched (its side is tracked) but never fires. */
export function isTracked(a: Alert, now: number): boolean {
  return a.enabled && a.armed && !(a.expires_at !== null && a.expires_at <= now)
}

export function isSnoozed(a: Alert, now: number, sessionSnoozed: ReadonlySet<number> = EMPTY): boolean {
  return (a.snooze_until ?? 0) > now || sessionSnoozed.has(a.id)
}

/** Armed and allowed to fire right now. */
export function isActive(a: Alert, now: number, sessionSnoozed: ReadonlySet<number> = EMPTY): boolean {
  return isTracked(a, now) && !isSnoozed(a, now, sessionSnoozed)
}

export function armedAlerts(alerts: readonly Alert[], now: number, sessionSnoozed: ReadonlySet<number> = EMPTY): Alert[] {
  return alerts.filter((a) => isActive(a, now, sessionSnoozed))
}

export function hasArmedAlerts(alerts: readonly Alert[], now: number, sessionSnoozed: ReadonlySet<number> = EMPTY): boolean {
  return alerts.some((a) => isActive(a, now, sessionSnoozed))
}

/** `alert_update.snooze_until` for a choice: 0 clears the snooze, null means "session" (kept in memory only, never stored). */
export function snoozeUntil(choice: SnoozeChoice, now: number): number | null {
  if (choice === 'off') return 0
  if (choice === 'session') return null
  return now + (choice === '15m' ? 15 : 60) * MIN_MS
}
