/**
 * Pure selectors and formatters for the desk header (M9): metrics strip, last-price line and status chips.
 * They only read what the panes already loaded (rh and orders stores); nothing here calls the backend.
 * Unknown is `null` and prints `-`, never 0.
 */
import type { RhApproval, RhOptionPosition, RhOrder, RhPortfolio, RhPosition, RhQuote, TmStatus, VaultStatus } from './api'
import { fmtMoney, fmtNum, fmtPct, fmtPrice, fmtQty, pnlClass, positionRow } from './format'
import { isCancelable } from './orderUi'
import { optionPnl } from './optionPositions'
import { classifyTmError } from './tmUi'

const fin = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

export interface DeskInput {
  connected: boolean
  /** The selected (ticket) account; null when none. */
  account: string | null
  portfolio: RhPortfolio | null
  positions: RhPosition[]
  optionPositions: RhOptionPosition[]
  quotes: Record<string, RhQuote>
  orders: RhOrder[]
  ordersError: string
  approvals: RhApproval[]
  /** The account `approvals` were read for (the list is only meaningful for that account). */
  approvalsAccount: string | null
}

export interface DeskMetrics {
  equity: number | null
  buyingPower: number | null
  cash: number | null
  positionsCount: number | null
  /** Sum of unrealized P&L over the positions that have a price; null when none can be priced. */
  unrealized: number | null
  /** Some positions had no quote, so `unrealized` is a partial sum. */
  unrealizedPartial: boolean
  /** Equity and option orders in a cancelable (open) state among the loaded orders; null after a failed read. */
  openOrders: number | null
  pendingApprovals: number | null
}

export const isPendingApproval = (a: RhApproval): boolean => a.state.toUpperCase().includes('PENDING')

const NONE: DeskMetrics = { equity: null, buyingPower: null, cash: null, positionsCount: null, unrealized: null, unrealizedPartial: false, openOrders: null, pendingApprovals: null }

export function deskMetrics(i: DeskInput): DeskMetrics {
  if (!i.connected || !i.account) return { ...NONE }
  const pf = i.portfolio
  const num = (n: number | null | undefined) => (fin(n) ? n : null)

  const pnls: Array<number | null> = [
    ...i.positions.map((p) => positionRow(p, i.quotes[p.symbol]?.last_trade_price ?? null).pnl),
    ...i.optionPositions.map((o) => optionPnl(o).pnl),
  ]
  const count = pnls.length
  const known = pnls.filter(fin)
  const unrealized = count === 0 ? 0 : known.length === 0 ? null : known.reduce((a, b) => a + b, 0)

  return {
    equity: num(pf?.equity_value),
    buyingPower: num(pf?.buying_power),
    cash: num(pf?.cash),
    positionsCount: count,
    unrealized,
    unrealizedPartial: known.length > 0 && known.length < count,
    openOrders: i.ordersError ? null : i.orders.filter(isCancelable).length,
    pendingApprovals: i.approvalsAccount === i.account ? i.approvals.filter(isPendingApproval).length : null,
  }
}

export function fmtMetric(n: number | null | undefined, kind: 'money' | 'count'): string {
  if (!fin(n)) return '-'
  return kind === 'money' ? fmtMoney(n) : fmtQty(n)
}

export interface PriceLine {
  last: string
  bid: string
  ask: string
  change: string
  changePct: string
  cls: 'bull' | 'bear' | ''
}

export function priceLine(q: RhQuote | null | undefined): PriceLine {
  const last = q?.last_trade_price ?? null
  const prev = q?.previous_close ?? null
  const have = fin(last) && fin(prev) && prev !== 0
  const diff = have ? last - prev : null
  const signed = (n: number) => (n > 0 && Number(n.toFixed(2)) !== 0 ? '+' : '') + fmtNum(n)
  return {
    last: fmtPrice(last),
    bid: fmtPrice(q?.bid_price ?? null),
    ask: fmtPrice(q?.ask_price ?? null),
    change: diff === null ? '-' : signed(diff),
    changePct: diff === null || !fin(prev) ? '-' : fmtPct((diff / prev) * 100),
    cls: pnlClass(diff),
  }
}

export type ChipTone = 'ok' | 'warn' | 'bad' | 'muted'
export interface DeskChip {
  key: string
  text: string
  tone: ChipTone
  title?: string
}

export interface ChipInput {
  rh: 'disconnected' | 'connecting' | 'connected' | 'error'
  /** The ticket / selected account. */
  account: string | null
  /** human_must_approve_trades for that account: true ON, false OFF, null/undefined unknown. */
  approvalOn: boolean | null | undefined
  tm: TmStatus | null
  vault: VaultStatus | null
  fake: boolean
}

export function deskChips(i: ChipInput): DeskChip[] {
  const out: DeskChip[] = []
  if (i.fake) out.push({ key: 'fake', text: 'FAKE DATA', tone: 'bad', title: 'No Tauri backend: nothing here is real' })

  const rh: Record<ChipInput['rh'], [string, ChipTone]> = {
    connected: ['Robinhood: connected', 'ok'],
    connecting: ['Robinhood: connecting', 'warn'],
    error: ['Robinhood: error', 'bad'],
    disconnected: ['Robinhood: not connected', 'muted'],
  }
  out.push({ key: 'rh', text: rh[i.rh][0], tone: rh[i.rh][1] })

  if (!i.account) out.push({ key: 'approvals', text: 'Approvals: -', tone: 'muted', title: 'No account selected' })
  else if (i.approvalOn === true) out.push({ key: 'approvals', text: 'Approvals: ON', tone: 'ok', title: 'Orders wait for your approval in the Robinhood app' })
  else if (i.approvalOn === false) out.push({ key: 'approvals', text: 'Approvals: OFF', tone: 'warn', title: 'Orders go straight to the market after Place' })
  else out.push({ key: 'approvals', text: 'Approvals: ?', tone: 'muted', title: 'Approval setting not read yet' })

  const kind = i.tm?.last_error ? classifyTmError(i.tm.last_error) : null
  if (kind === 'locked') out.push({ key: 'tm', text: 'TM key: vault locked', tone: 'warn' })
  else if (!i.tm || !i.tm.key_present) out.push({ key: 'tm', text: 'TM key: missing', tone: 'muted' })
  else if (kind === 'rejected') out.push({ key: 'tm', text: 'TM key: rejected', tone: 'bad' })
  else out.push({ key: 'tm', text: 'TM key: ok', tone: 'ok' })

  if (!i.vault) out.push({ key: 'vault', text: 'Vault: -', tone: 'muted' })
  else if (i.vault.backend !== 'vault') out.push({ key: 'vault', text: `Secrets: ${i.vault.backend}`, tone: 'ok' })
  else if (i.vault.unlocked) out.push({ key: 'vault', text: 'Vault: unlocked', tone: 'ok' })
  else if (!i.vault.exists) out.push({ key: 'vault', text: 'Vault: not created', tone: 'warn' })
  else out.push({ key: 'vault', text: 'Vault: locked', tone: 'warn' })
  return out
}

/** ATR and range position of the chart symbol (M12), written by the chart pane from its bars. */
export interface DeskStats {
  symbol: string
  atrLen: number
  atr: number | null
  /** Position of the higher-timeframe close inside the swing, 0..1 (can exceed it when price left the swing). */
  rangePos: number | null
  /** Chart timeframe id the ATR was computed on (the strike check only uses a daily ATR). */
  tf?: string
}

/** Two header chips: `ATR(<len>) <value>` and `range pos 0.xx`. Unknown, or stats of another symbol, print "-". */
export function deskStatChips(stats: DeskStats | null | undefined, symbol: string): DeskChip[] {
  const s = stats && stats.symbol === symbol ? stats : null
  const atr = s && fin(s.atr) ? s.atr.toFixed(2) : '-'
  const pos = s && fin(s.rangePos) ? s.rangePos.toFixed(2) : '-'
  return [
    { key: 'atr', text: s ? `ATR(${s.atrLen}) ${atr}` : 'ATR -', tone: 'muted', title: 'Wilder ATR at the last bar, length per timeframe (per-timeframe table)' },
    { key: 'rangepos', text: `range pos ${pos}`, tone: 'muted', title: 'Where the higher-timeframe close sits in the swing high/low: 0 = at the low, 1 = at the high' },
  ]
}
