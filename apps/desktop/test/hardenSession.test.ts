import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake, fakeRh, fakeTm, TM_KEY_SLOT, type RhAccount } from '../src/lib/api'
import { disconnectSession, wipeSession } from '../src/stores/session'
import { useJournalStore } from '../src/stores/journal'
import { useOrdersStore } from '../src/stores/orders'
import { useRhStore } from '../src/stores/rh'
import { useTmStore } from '../src/stores/tm'
import { useVaultStore } from '../src/stores/vault'

const acct: RhAccount = {
  account_number: 'AGEN0002', rhs_account_number: 'RHS1', rhc_account_number: null, agentic_allowed: true, option_level: null,
  kind: 'margin', is_default: true, unsettled_funds: null, nickname: null, brokerage_account_type: null,
}

beforeEach(() => {
  fake.reset()
  fakeRh.accounts = [acct]
  fakeRh.last = { AAA: 100 }
  useRhStore.getState().wipe()
  useOrdersStore.getState().wipe()
})

describe('F5 wipeSession', () => {
  it('resets rh, orders, journal and TM state in one call', async () => {
    await useRhStore.getState().connect()
    fake.secrets.add(TM_KEY_SLOT)
    fakeTm.spotFor = () => 100
    await useTmStore.getState().loadSymbol('AAPL', ['move'])
    useOrdersStore.setState({ phase: 'unknown', outcome: { kind: 'unknown', message: 'x' }, error: 'e', approvals: [{ approval_id: 'a', account_number: 'X', asset_class: 'c', state: 's' }] })
    useJournalStore.setState({ trades: [{ trade_key: 'k', symbol: 'A', side: 'buy', quantity: 1, price: 1, realized_gain: 1, timestamp: null }], pnlAccount: 'AGEN0002' })
    expect(useTmStore.getState().bySymbol.AAPL).toBeTruthy()

    wipeSession()

    expect(useRhStore.getState().accounts).toEqual([])
    expect(useRhStore.getState().account).toBeNull()
    expect(useOrdersStore.getState().phase).toBe('idle')
    expect(useOrdersStore.getState().outcome).toBeNull()
    expect(useOrdersStore.getState().approvals).toEqual([])
    expect(useJournalStore.getState().trades).toEqual([])
    expect(useJournalStore.getState().pnlAccount).toBeNull()
    expect(useTmStore.getState().bySymbol).toEqual({})
    expect(useTmStore.getState().status).toBeNull()
    // display preferences are not session data
    expect(useTmStore.getState().settings).toBeTruthy()
  })
  it('a review that lands after the wipe is dropped', async () => {
    await useRhStore.getState().connect()
    const p = useOrdersStore.getState().review({
      kind: 'equity',
      args: { account_number: 'AGEN0002', symbol: 'AAA', side: 'buy', type: 'limit', quantity: '1', limit_price: '90', time_in_force: 'gfd', market_hours: 'regular_hours' },
    })
    wipeSession()
    await p
    expect(useOrdersStore.getState().phase).toBe('idle')
    expect(useOrdersStore.getState().reviewOut).toBeNull()
  })
  it('Disconnect wipes, then disconnects', async () => {
    await useRhStore.getState().connect()
    await disconnectSession()
    expect(useRhStore.getState().accounts).toEqual([])
    expect(fakeRh.connected).toBe(false)
  })
  it('Lock vault wipes the session', async () => {
    await api.vaultCreate('longenough1')
    await useRhStore.getState().connect()
    await useVaultStore.getState().lock()
    expect(useRhStore.getState().accounts).toEqual([])
    expect(useRhStore.getState().account).toBeNull()
  })
})
