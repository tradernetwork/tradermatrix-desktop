/**
 * Dev-only entry (tm-dev.html): the TraderMatrix key panel and Insight pane against the FAKE api backend, which serves the
 * real TM sample responses (AAPL, 2026-11-11). No Tauri, no network, no real key (type anything starting td_live_ at least 20 chars).
 *   ?key=none|saved|rejected   key state at load (default saved); none lets you paste a fake key in the "TM key" popover
 *   &limit=1                   every read fails with a synthetic tier/limit error
 *   &locked=1                  the vault reports locked
 *   &fail=1                    every read fails as a transport error
 *   &symbol=AAPL               chart symbol (the pane follows it; the box below switches it)
 *   &delay=250                 ms each fake read takes (default 250, shows the loading state)
 *   &scale=1                   rescale the fixture prices to the symbol's fake chart price (off by default: raw fixture numbers)
 */
import '../styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { fake, fakePriceAt, fakeTm, isTauri, TM_KEY_SLOT } from '../lib/api'
import { normalizeSymbol } from '../chart/useChartData'
import { useRhStore } from '../stores/rh'
import { TmInsightPane } from './TmInsightPane'
import { TmKeyPanel } from './TmKeyPanel'

const q = new URLSearchParams(location.search)
const key = q.get('key') ?? 'saved'
const symbol = normalizeSymbol(q.get('symbol') ?? '') ?? 'AAPL'

if (!isTauri()) {
  if (key === 'saved' || key === 'rejected') fake.secrets.add(TM_KEY_SLOT)
  if (key === 'rejected') fakeTm.mode = 'rejected'
  if (q.get('limit') === '1') fakeTm.mode = 'tier'
  if (q.get('locked') === '1') fakeTm.mode = 'locked'
  if (q.get('fail') === '1') fakeTm.mode = 'transport'
  fakeTm.delayMs = Number(q.get('delay') ?? 250) || 0
  if (q.get('scale') === '1') fakeTm.spotFor = (s) => fakePriceAt(s, Date.now())
}
useRhStore.setState({ chartSymbol: symbol })

function SymbolBox() {
  return (
    <input
      aria-label="Symbol"
      defaultValue={symbol}
      maxLength={6}
      style={{ width: 72, textTransform: 'uppercase' }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const n = normalizeSymbol(e.currentTarget.value)
          if (n) useRhStore.getState().setChartSymbol(n)
        }
      }}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div className="toolbar">
        <span className="title">TM DEV</span>
        <SymbolBox />
        <span className="muted">fake backend, real TM sample responses, press Enter to switch symbol</span>
        <span className="spacer" />
        <TmKeyPanel />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TmInsightPane />
      </div>
    </div>
  </StrictMode>,
)
