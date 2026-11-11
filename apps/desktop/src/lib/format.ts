import type { BackendStatus, RhAccount, RhPosition, VaultStatus } from './api'

const NBSP_FREE = (s: string) => s.replace(/−/g, '-')

/** True when `n` prints as zero at `dp` decimals (so it must not carry a minus sign). */
const roundsToZero = (n: number, dp: number): boolean => Number(Math.abs(n).toFixed(dp)) === 0

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  const v = roundsToZero(n, dp) ? 0 : n
  return NBSP_FREE(v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }))
}

/** A price: 4 decimals below $1 (sub-dollar tickers), else 2. */
export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  return fmtNum(n, Math.abs(n) < 1 ? 4 : 2)
}

export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  return (n < 0 && !roundsToZero(n, 2) ? '-$' : '$') + fmtNum(Math.abs(n))
}

/** Signed, e.g. +1.25% / -0.40%; an amount that rounds to zero prints 0.00%. */
export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  return (n > 0 && !roundsToZero(n, 2) ? '+' : '') + fmtNum(n) + '%'
}

/** Up to 4 decimals, trailing zeros trimmed (fractional shares). */
export function fmtQty(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  return NBSP_FREE(n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 }))
}

export function pnlClass(n: number | null | undefined): 'bull' | 'bear' | '' {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return ''
  return n > 0 ? 'bull' : 'bear'
}

export interface PositionRow {
  symbol: string
  qty: number | null
  avg: number | null
  last: number | null
  value: number | null
  /** Unrealized P&L in dollars: (last - avg) * qty. */
  pnl: number | null
  /** Unrealized P&L as a percent of cost basis; sign follows the position (shorts gain when price falls). */
  pnlPct: number | null
}

export function positionRow(p: RhPosition, last: number | null): PositionRow {
  const qty = p.quantity
  const avg = p.average_buy_price
  const have = last !== null && qty !== null && avg !== null
  const pnl = have ? (last - avg) * qty : null
  const cost = avg !== null && qty !== null ? avg * Math.abs(qty) : null
  const pnlPct = pnl !== null && cost !== null && cost > 0 ? (pnl / cost) * 100 : null
  return {
    symbol: p.symbol,
    qty,
    avg,
    last,
    value: last !== null && qty !== null ? last * qty : null,
    pnl,
    pnlPct,
  }
}

export function maskAccount(n: string): string {
  return '••••' + n.slice(-4)
}

export function accountLabel(a: RhAccount): string {
  const parts = [maskAccount(a.account_number)]
  if (a.kind) parts.push(a.kind)
  if (a.nickname) parts.push(a.nickname)
  if (a.agentic_allowed) parts.push('[agentic]')
  if (a.is_default) parts.push('(default)')
  return parts.join(' ')
}

/** The account with agentic_allowed first, then the default account, then the first one. */
export function defaultAccount(accounts: RhAccount[]): RhAccount | undefined {
  return accounts.find((a) => a.agentic_allowed) ?? accounts.find((a) => a.is_default) ?? accounts[0]
}

export interface Pill {
  text: string
  cls: 'ok' | 'warn'
  title: string
}

/** The toolbar `secrets:` pill. For the encrypted-vault backend it reports the vault state. */
export function secretsPill(status: BackendStatus | null, vault: VaultStatus | null): Pill {
  if (!status) return { text: 'secrets: ...', cls: 'warn', title: '' }
  if (status.backend === 'vault' || vault?.backend === 'vault') {
    if (vault?.unlocked) return { text: 'secrets: vault unlocked', cls: 'ok', title: status.detail }
    if (vault && !vault.exists) return { text: 'secrets: vault not created', cls: 'warn', title: status.detail }
    return { text: 'secrets: vault locked', cls: 'warn', title: status.detail }
  }
  return status.available
    ? { text: `secrets: ${status.backend}`, cls: 'ok', title: status.detail }
    : { text: 'secrets: unavailable', cls: 'warn', title: status.detail }
}
