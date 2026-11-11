/**
 * Dev-only entry (alerts-dev.html): the Alerts pane and the toast against the FAKE backend. No Robinhood, no real quotes, no order path.
 *   ?seed=3|none   seeds three alerts (AAPL up through 190, MSFT down through 410 snoozed an hour, SPY either way through 600 on rearm); none = empty (default 3)
 *   &fired=1       one fired event in History (unseen badge) and its toast on screen
 *   &missed=1      two events with missed=1 ("While you were away" in History)
 *   &kinds=1       also seeds an IV rank, a P&L, a verdict, an earnings and an order alert (list text only; their feeds do not run here)
 *   &many=1        with fired=1: eight more fires on one symbol so the 5-per-hour cap shows the "N more alerts" summary toast
 */
import '../styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { fakeAlerts } from '../lib/alertsFake'
import { isTauri } from '../lib/api'
import { useAlertsStore } from '../stores/alerts'
import { AlertToast } from './AlertToast'
import { AlertsPane } from './AlertsPane'
import { FakeBanner } from './FakeBanner'

const q = new URLSearchParams(location.search)
const seed = q.get('seed') ?? '3'
const now = Date.now()

async function boot(): Promise<void> {
  const s = useAlertsStore.getState()
  if (!isTauri() && seed !== 'none') {
    const a = await s.create({ symbol: 'AAPL', kind: 'price', ref_kind: 'price', price: 190, dir: 'up', mode: 'cross', repeat: 'once' })
    const m = await s.create({ symbol: 'MSFT', kind: 'price', ref_kind: 'apex', ref_param: '410', price: 410, dir: 'down', mode: 'cross', repeat: 'rearm' })
    await s.create({ symbol: 'SPY', kind: 'price', ref_kind: 'price', price: 600, dir: 'either', mode: 'cross', repeat: 'rearm' })
    if (m) await s.snooze(m.id, '1h')
    if (q.get('fired') === '1' && a) {
      fakeAlerts.update(a.id, { last_side: -1 })
      const out = fakeAlerts.fire(a.id, 1, 190.42, 1.2)
      if (out.outcome === 'fired') s.notifyFired(out.event)
    }
  }
  if (!isTauri() && q.get('kinds') === '1') {
    await s.create({ symbol: 'NVDA', kind: 'iv', ref_kind: 'iv', price: 60, dir: 'up', mode: 'cross', repeat: 'rearm' })
    await s.create({ symbol: 'AAPL', kind: 'pnl', ref_kind: 'pnl', ref_param: JSON.stringify({ pos: 'o1', thr: -500, opt: true }), price: 500, dir: 'down', mode: 'cross', repeat: 'once' })
    await s.create({ symbol: 'AAPL', kind: 'verdict', ref_kind: 'verdict', ref_param: JSON.stringify({ opt: 'o1', to: 'exposed' }), price: 190, dir: 'either', mode: 'cross', repeat: 'once' })
    await s.create({ symbol: 'TSLA', kind: 'earnings', ref_kind: 'verdict', ref_param: JSON.stringify({ opt: 'o2' }), price: 300, dir: 'either', mode: 'cross', repeat: 'once' })
    await s.create({ symbol: 'SPY', kind: 'order', ref_kind: 'order', price: 1, dir: 'either', mode: 'cross', repeat: 'once' })
  }
  if (!isTauri()) {
    if (q.get('missed') === '1') {
      fakeAlerts.seedEvent({ symbol: 'NVDA', label: 'NVDA above 140.00', trigger_px: 141.3, ref_px: 140, fired_at: now - 6 * 3_600_000, missed: true })
      fakeAlerts.seedEvent({ symbol: 'TSLA', label: 'TSLA below 300.00', trigger_px: 297.9, ref_px: 300, fired_at: now - 5 * 3_600_000, missed: true })
    }
    if (q.get('many') === '1' && q.get('fired') === '1') {
      for (let i = 0; i < 8; i++) {
        const ev = fakeAlerts.seedEvent({ symbol: 'AAPL', label: `AAPL above ${190 + i}.00`, trigger_px: 191 + i, ref_px: 190 + i })
        s.notifyFired(ev)
      }
    }
  }
  await s.loadEvents()
}
void boot()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <FakeBanner />
      <div className="toolbar">
        <span className="title">ALERTS DEV</span>
        <span className="muted">fake backend, seeded alerts, no quotes are polled</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, maxWidth: 560 }}>
        <AlertsPane />
      </div>
      <AlertToast />
    </div>
  </StrictMode>,
)
