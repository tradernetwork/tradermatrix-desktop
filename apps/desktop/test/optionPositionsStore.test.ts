import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeRh, type RhAccount, type RhOptionPosition } from '../src/lib/api'
import { useRhStore } from '../src/stores/rh'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'SYN00000001', rhs_account_number: null, rhc_account_number: null, agentic_allowed: false, option_level: null,
  kind: 'margin', is_default: false, unsettled_funds: null, nickname: null, brokerage_account_type: null, ...o,
})
const optRow = (o: Partial<RhOptionPosition> = {}): RhOptionPosition => ({
  option_id: 'opt-1', chain_symbol: 'AAA', expiration_date: '2026-11-20', strike_price: 150, option_type: 'call', side: 'long', quantity: 1,
  average_price: 100, multiplier: 100, bid: 1, ask: 1.1, mark: 1.05, delta: 0.5, theta: -0.02, iv: 0.3, min_ticks: null, pending_buy: 0, pending_sell: 0, ...o,
})

beforeEach(() => {
  fake.reset()
  fakeRh.accounts = [acct({ account_number: 'MAIN0001', is_default: true }), acct({ account_number: 'AGEN0002', agentic_allowed: true })]
  fakeRh.optionPositions = { AGEN0002: [optRow()], MAIN0001: [optRow({ option_id: 'main-opt' })] }
  useRhStore.getState().wipe()
})
afterEach(() => {
  useRhStore.getState().watchQuotes('positions', [])
  vi.restoreAllMocks()
})

describe('option positions in the Robinhood store', () => {
  it('load with the account and refresh with loadPositions', async () => {
    await useRhStore.getState().connect()
    expect(useRhStore.getState().account).toBe('AGEN0002')
    expect(useRhStore.getState().optionPositions.map((r) => r.option_id)).toEqual(['opt-1'])
    fakeRh.optionPositions.AGEN0002 = [optRow({ option_id: 'opt-2' })]
    await useRhStore.getState().loadPositions()
    expect(useRhStore.getState().optionPositions.map((r) => r.option_id)).toEqual(['opt-2'])
  })
  it('a failing option read keeps equity positions and reports its own error', async () => {
    await useRhStore.getState().connect()
    vi.spyOn(api, 'rhOptionPositions').mockRejectedValue(new Error('tool error: nope'))
    await useRhStore.getState().loadPositions()
    expect(useRhStore.getState().optionPositionsError).toMatch(/nope/)
    expect(useRhStore.getState().positionsError).toBe('')
    expect(useRhStore.getState().portfolio).not.toBeNull()
  })
  it('switching account drops the other account rows first', async () => {
    await useRhStore.getState().connect()
    await useRhStore.getState().selectAccount('MAIN0001')
    expect(useRhStore.getState().optionPositions.map((r) => r.option_id)).toEqual(['main-opt'])
  })
  it('wipe clears them', async () => {
    await useRhStore.getState().connect()
    useRhStore.getState().wipe()
    expect(useRhStore.getState().optionPositions).toEqual([])
    expect(useRhStore.getState().optionPositionsError).toBe('')
  })
  it('a read that lands after a wipe is dropped', async () => {
    await useRhStore.getState().connect()
    let release: (v: RhOptionPosition[]) => void = () => undefined
    vi.spyOn(api, 'rhOptionPositions').mockReturnValue(new Promise((r) => (release = r)))
    const p = useRhStore.getState().loadPositions()
    await Promise.resolve()
    useRhStore.getState().wipe()
    release([optRow({ option_id: 'late' })])
    await p
    expect(useRhStore.getState().optionPositions).toEqual([])
  })
  it('the read goes through the one read-only api entry and never a write', async () => {
    const spy = vi.spyOn(api, 'rhOptionPositions')
    const place = vi.spyOn(api, 'rhPlaceOrder')
    await useRhStore.getState().connect()
    expect(spy).toHaveBeenCalledWith('AGEN0002')
    expect(place).not.toHaveBeenCalled()
  })
})
