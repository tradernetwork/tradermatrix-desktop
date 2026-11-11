/**
 * Ladder row click (M13): FILL the ticket's limit price through the existing `fillTicket` path and nothing else. This module
 * never reviews, places or cancels anything, and never sets a side or a size. A click is ignored when the ticket is not on the
 * chart's symbol (the fill would silently re-point the ticket), in option mode, or on the "you are here" row.
 */
import { priceText, type EquityIntent } from '../../lib/ticketIntent'
import { fillTicket } from '../../stores/ticketIntent'
import type { LadderRow } from './ladder'

export interface PickContext {
  chartSymbol: string
  /** The symbol the order ticket is on (it follows the app's chart symbol). */
  ticketSymbol: string
  optionMode: boolean
}

export function ladderFillIntent(row: Pick<LadderRow, 'kind' | 'price'>, ctx: PickContext): EquityIntent | null {
  if (ctx.optionMode || row.kind === 'here') return null
  if (ctx.chartSymbol === '' || ctx.chartSymbol !== ctx.ticketSymbol) return null
  if (!Number.isFinite(row.price) || row.price <= 0) return null
  return { kind: 'equity', symbol: ctx.chartSymbol, orderType: 'limit', limit: priceText(row.price), source: 'ladder' }
}

/** true = the ticket was filled. */
export function pickLadderRow(row: Pick<LadderRow, 'kind' | 'price'>, ctx: PickContext): boolean {
  const intent = ladderFillIntent(row, ctx)
  return intent !== null && fillTicket(intent)
}
