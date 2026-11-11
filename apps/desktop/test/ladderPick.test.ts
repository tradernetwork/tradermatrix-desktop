import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fake } from '../src/lib/api'
import { ladderFillIntent, pickLadderRow } from '../src/chart/tmDesk/ladderPick'
import type { LadderRow } from '../src/chart/tmDesk/ladder'
import { useOrdersStore } from '../src/stores/orders'
import { useTicketIntentStore } from '../src/stores/ticketIntent'

const row = (o: Partial<LadderRow> = {}): LadderRow => ({ kind: 'level', price: 362.5, label: 'APEX 362.5', source: 'tm', rank: 1, y: 10, labelY: 12, chip: true, ...o })
const ctx = { chartSymbol: 'AAPL', ticketSymbol: 'AAPL', optionMode: false }

beforeEach(() => {
  fake.reset()
  useTicketIntentStore.setState({ pending: null, at: 0, seq: 0 })
})

describe('ladder click', () => {
  it('fills ONLY the limit price: a limit equity intent for the chart symbol, nothing else', () => {
    const i = ladderFillIntent(row(), ctx)!
    expect(i).toEqual({ kind: 'equity', symbol: 'AAPL', orderType: 'limit', limit: '362.50', source: 'ladder' })
    expect(Object.keys(i).sort()).toEqual(['kind', 'limit', 'orderType', 'source', 'symbol'])
  })
  it('sub-dollar levels keep 4 decimals', () => {
    expect(ladderFillIntent(row({ price: 0.5 }), ctx)!).toMatchObject({ limit: '0.5000' })
  })
  it('goes through fillTicket and never reviews or places (spy on the orders store)', () => {
    const review = vi.spyOn(useOrdersStore.getState(), 'review' as never)
    const place = vi.spyOn(useOrdersStore.getState(), 'place' as never)
    expect(pickLadderRow(row(), ctx)).toBe(true)
    const pending = useTicketIntentStore.getState().pending
    expect(pending).toMatchObject({ kind: 'equity', symbol: 'AAPL', limit: '362.50', orderType: 'limit' })
    expect(review).not.toHaveBeenCalled()
    expect(place).not.toHaveBeenCalled()
    expect(useOrdersStore.getState().phase).toBe('idle')
  })
  it('is ignored when the ticket symbol differs from the chart symbol, in option mode, or for the "here" row', () => {
    expect(pickLadderRow(row(), { ...ctx, ticketSymbol: 'MSFT' })).toBe(false)
    expect(pickLadderRow(row(), { ...ctx, optionMode: true })).toBe(false)
    expect(pickLadderRow(row({ kind: 'here', source: 'here' }), ctx)).toBe(false)
    expect(useTicketIntentStore.getState().pending).toBeNull()
    expect(useTicketIntentStore.getState().seq).toBe(0)
  })
  it('ticks are clickable like labels; a bad price or symbol is refused', () => {
    expect(pickLadderRow(row({ kind: 'tick' }), ctx)).toBe(true)
    expect(pickLadderRow(row({ price: -1 }), ctx)).toBe(false)
    expect(pickLadderRow(row({ price: NaN }), ctx)).toBe(false)
    expect(pickLadderRow(row(), { ...ctx, chartSymbol: 'not a symbol', ticketSymbol: 'not a symbol' })).toBe(false)
  })
})
