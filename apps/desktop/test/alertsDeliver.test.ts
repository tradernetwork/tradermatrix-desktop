import { describe, expect, it, vi } from 'vitest'
import { Deliverer, type DeliverDeps } from '../src/alerts/deliver'
import type { AlertEvent } from '../src/alerts/types'

const ev = (over: Partial<AlertEvent> = {}): AlertEvent => ({ id: 1, alert_id: 1, fired_at: 1, symbol: 'AAA', label: 'AAA above 100.00', trigger_px: 101, ref_px: 100, quote_age_s: 1, kind: 'fire', seen: false, missed: false, ...over })
function mk(over: Partial<DeliverDeps> = {}) {
  const d = { notify: vi.fn(async () => 'shown'), playSound: vi.fn(), onUnavailable: vi.fn(), prefs: () => ({ sound: true, os: true }), ...over }
  return { d, dl: new Deliverer(d as DeliverDeps) }
}

describe('delivery (task 8)', () => {
  it('a normal fire plays the sound and asks for an OS notice with the label and price', async () => {
    const { d, dl } = mk()
    await dl.deliver(ev())
    expect(d.playSound).toHaveBeenCalledTimes(1)
    expect(d.notify).toHaveBeenCalledWith('AAA above 100.00', 'last 101.00')
  })
  it('a failing notify never throws and sets the unavailable flag exactly once; it is not retried', async () => {
    const { d, dl } = mk({ notify: vi.fn(async () => { throw new Error('no daemon') }) })
    await expect(dl.deliver(ev())).resolves.toBeUndefined()
    await dl.deliver(ev({ id: 2 }))
    await dl.deliver(ev({ id: 3 }))
    expect(d.notify).toHaveBeenCalledTimes(1)
    expect(d.onUnavailable).toHaveBeenCalledTimes(1)
  })
  it('an "unavailable" answer counts as a failure too', async () => {
    const { d, dl } = mk({ notify: vi.fn(async () => 'unavailable') })
    await dl.deliver(ev())
    await dl.deliver(ev({ id: 2 }))
    expect(d.notify).toHaveBeenCalledTimes(1)
    expect(d.onUnavailable).toHaveBeenCalledTimes(1)
  })
  it('sound off plays nothing; OS off asks for nothing', async () => {
    const { d, dl } = mk({ prefs: () => ({ sound: false, os: false }) })
    await dl.deliver(ev())
    expect(d.playSound).not.toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
  })
  it('a missed-while-closed event never plays a sound and never reaches the OS (Review Focus 5)', async () => {
    const { d, dl } = mk()
    await dl.deliver(ev({ missed: true, kind: 'missed' }))
    expect(d.playSound).not.toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
  })
  it('a sound that throws is swallowed', async () => {
    const { dl } = mk({ playSound: vi.fn(() => { throw new Error('blocked') }) })
    await expect(dl.deliver(ev())).resolves.toBeUndefined()
  })
})
