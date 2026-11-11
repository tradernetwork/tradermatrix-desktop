/** Header meter text (M16 B2): pure formatting over the `explain_usage_summary` numbers. */
import type { UsageSummary } from './api'

export function formatTokens(n: number): string {
  if (!(n >= 1000)) return String(Math.max(0, Math.round(n || 0)))
  const k = n / 1000
  return `${Number.isInteger(k) ? k : Math.round(k * 10) / 10}k`
}

/** $0.03, $0.0001 for tiny spends, and "<$0.0001" rather than a fake zero when something was spent. */
export function formatUsd(x: number): string {
  if (!(x > 0)) return '$0.00'
  if (x >= 0.01) return `$${x.toFixed(2)}`
  if (x >= 0.0001) return `$${x.toFixed(4)}`
  return '<$0.0001'
}

/** "42k / 60k tokens, $0.03 this month". 'est' = some tokens were estimated; an unknown model price says so instead of showing $0. */
export function meterText(u: UsageSummary | null): string {
  if (!u) return ''
  const tokens = `${formatTokens(u.session_tokens)} / ${formatTokens(u.session_cap)} tokens${u.session_estimated ? ' (est)' : ''}`
  if (!u.price_known) return `${tokens}, price unknown`
  const money = `${formatUsd(u.month_usd)} this month${u.month_estimated ? ' (est)' : ''}${u.month_unpriced ? ' + unpriced use' : ''}`
  return `${tokens}, ${money}`
}

/** For colouring the meter: near from 80% of either budget, over at the cap. */
export function budgetState(u: UsageSummary | null): 'ok' | 'near' | 'over' {
  if (!u) return 'ok'
  const a = u.session_cap > 0 ? u.session_tokens / u.session_cap : 0
  const b = u.month_cap > 0 ? u.month_usd / u.month_cap : 0
  const m = Math.max(a, b)
  return m >= 1 ? 'over' : m >= 0.8 ? 'near' : 'ok'
}
