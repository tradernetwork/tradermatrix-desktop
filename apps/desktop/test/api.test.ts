import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake, fakeRh } from '../src/lib/api'

beforeEach(() => fake.reset())

describe('api fake (same rules as the Rust core)', () => {
  it('round trips layouts and is case-insensitive', async () => {
    await api.layoutSave('Main', '{"a":1}')
    await api.layoutSave('MAIN', '{"a":2}')
    expect((await api.layoutList()).length).toBe(1)
    expect(await api.layoutLoad('main')).toBe('{"a":2}')
    expect(await api.layoutLoad('nope')).toBeNull()
    await api.layoutDelete('main')
    await api.layoutDelete('main')
    expect(await api.layoutList()).toEqual([])
  })
  it('rejects bad names', async () => {
    for (const bad of ['', 'a'.repeat(65), 'a\nb', ' lead', 'trail ']) {
      await expect(api.layoutSave(bad, '{}')).rejects.toThrow(/invalid input/)
    }
    await expect(api.layoutSave('a'.repeat(64), '{}')).resolves.toBeTruthy()
  })
  it('rejects bad json', async () => {
    await expect(api.layoutSave('n', '{nope')).rejects.toThrow(/invalid input/)
    await expect(api.layoutSave('n', `"${'a'.repeat(1024 * 1024)}"`)).rejects.toThrow(/1 MiB/)
  })
  it('lists newest first', async () => {
    await api.layoutSave('a', '{}')
    await api.layoutSave('b', '{}')
    await api.layoutSave('a', '{}')
    expect((await api.layoutList()).map((l) => l.name)).toEqual(['a', 'b'])
  })
  it('allowlists secret slots and never exposes a getter', async () => {
    await expect(api.secretSet('nope', 'x')).rejects.toThrow(/unknown secret slot/)
    await expect(api.secretSet('tm_api_key', '')).rejects.toThrow(/empty/)
    await api.secretSet('tm_api_key', 'x')
    expect(await api.secretExists('tm_api_key')).toBe(true)
    await api.secretDelete('tm_api_key')
    expect(await api.secretExists('tm_api_key')).toBe(false)
    expect('secretGet' in api).toBe(false)
  })
  it('exposes only the pinned typed order entry points, no raw-call or secret-read one', () => {
    const names = Object.keys(api)
    // M6: exactly these names may contain place/cancel/decline/review (mirrors the pinned Rust command set).
    const allowed = [
      'rhReviewEquityOrder', 'rhReviewOptionOrder', 'rhPlaceOrder', 'rhCancelEquityOrder', 'rhCancelOptionOrder',
      'rhTradeApprovals', 'rhTradeApprovalSetting', 'rhDeclineTradeApproval',
    ]
    for (const n of allowed) expect(names, n).toContain(n)
    expect(names.filter((n) => /place|cancel|decline|review/i.test(n)).sort()).toEqual(
      ['rhCancelEquityOrder', 'rhCancelOptionOrder', 'rhDeclineTradeApproval', 'rhPlaceOrder', 'rhReviewEquityOrder', 'rhReviewOptionOrder'].sort(),
    )
    for (const bad of [/exercise/i, /replace/i, /raw/i, /advanced/i, /crypto/i, /secretGet/i, /^call$/i, /refId/i]) {
      expect(names.filter((n) => bad.test(n)), String(bad)).toEqual([])
    }
  })
  it('fake order backend: strict arguments, no ref_id from the webview, agentic accounts only', async () => {
    fakeRh.accounts = [
      { account_number: 'MAIN0001', rhs_account_number: null, rhc_account_number: null, agentic_allowed: false, option_level: null, kind: null, is_default: true, unsettled_funds: null, nickname: null, brokerage_account_type: null },
      { account_number: 'AGEN0002', rhs_account_number: null, rhc_account_number: null, agentic_allowed: true, option_level: null, kind: null, is_default: false, unsettled_funds: null, nickname: null, brokerage_account_type: null },
    ]
    const ok = { account_number: 'AGEN0002', symbol: 'AAA', side: 'buy', type: 'limit', quantity: '1', limit_price: '90' }
    await expect(api.rhReviewEquityOrder(ok)).rejects.toThrow(/not connected/)
    await api.rhConnect()
    await expect(api.rhReviewEquityOrder({ ...ok, ref_id: 'x' } as never)).rejects.toThrow(/unknown field/)
    await expect(api.rhReviewEquityOrder({ ...ok, symbol: 'aapl' })).rejects.toThrow(/symbol/)
    await expect(api.rhReviewEquityOrder({ ...ok, account_number: 'MAIN0001' })).rejects.toThrow(/agentic/)
    await expect(api.rhPlaceOrder('nope')).rejects.toThrow(/unknown review id/)
    const r = await api.rhReviewEquityOrder(ok)
    expect(r.account_masked).toBe('\u2022\u2022\u2022\u20220002')
    await expect(api.rhCancelEquityOrder('AGEN0002', 'not-a-uuid')).rejects.toThrow(/UUID/)
    await expect(api.rhTradeApprovals('AGEN0002', 'bogus')).rejects.toThrow(/approval state/)
    await expect(api.rhDeclineTradeApproval('AGEN0002', 'bad id!')).rejects.toThrow(/approval id/)
  })
  it('fake Robinhood backend rejects calls before login and bad arguments after', async () => {
    await expect(api.rhAccounts()).rejects.toThrow(/not connected/)
    await api.rhConnect()
    await expect(api.rhPositions('bad account')).rejects.toThrow(/invalid argument/)
    await expect(api.rhQuotes(['a b'])).rejects.toThrow(/invalid argument/)
    await expect(api.rhQuotes(Array.from({ length: 401 }, (_, i) => `S${i}`))).rejects.toThrow(/too many/)
    await api.rhDisconnect()
    await expect(api.rhQuotes(['AAA'])).rejects.toThrow(/not connected/)
  })
  it('settings round trip', async () => {
    await api.settingSet('k', 'v')
    expect(await api.settingGet('k')).toBe('v')
    expect(await api.settingGet('z')).toBeNull()
  })
})
