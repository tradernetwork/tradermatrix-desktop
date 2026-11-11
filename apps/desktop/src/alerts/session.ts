/** US equity session clock for the alert stale guard (M17). Eastern time via Intl; exchange holidays are NOT known (a holiday looks like a normal weekday). */
export interface SessionInfo {
  /** Regular or extended hours are open. */
  open: boolean
  /** Open, but only pre-market (04:00 to 09:30 ET) or after-hours (16:00 to 20:00 ET). */
  extendedOnly: boolean
}

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })

export function sessionAt(ms: number): SessionInfo {
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  const wd = parts.weekday
  if (wd === 'Sat' || wd === 'Sun') return { open: false, extendedOnly: false }
  const min = Number(parts.hour) * 60 + Number(parts.minute)
  if (min >= 9 * 60 + 30 && min < 16 * 60) return { open: true, extendedOnly: false }
  if ((min >= 4 * 60 && min < 9 * 60 + 30) || (min >= 16 * 60 && min < 20 * 60)) return { open: true, extendedOnly: true }
  return { open: false, extendedOnly: false }
}
