import type { Alert } from '../src/alerts/types'

export const mkAlert = (over: Partial<Alert> = {}): Alert => ({
  id: 1, symbol: 'AAA', kind: 'price', ref_kind: 'price', ref_param: null, price: 100, dir: 'up', tf: null, mode: 'cross', repeat: 'once',
  cooldown_s: 300, hysteresis_pct: 0.05, expires_at: null, snooze_until: null, enabled: true, extended_hours: false, last_side: null, armed: true,
  last_fired_at: null, created_at: 1, ...over,
})
