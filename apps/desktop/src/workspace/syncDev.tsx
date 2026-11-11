/**
 * Dev-only entry (sync-dev.html): the Watchlist pane and its Sync dialog against the FAKE api backend. No Tauri, no network,
 * no real key (fake key state only), no real list. The fake TraderMatrix account is the sanitized list_watchlists fixture
 * (My Watchlist: AAAA BBBB; Desk CSP: CCCC DDDD BRK.B; Empty list). The fake Robinhood has "Mine" (AAAA BBBB EEEE FFFF BF-B BTC),
 * a followed list and an options list.
 *   ?tm=none|saved|rejected   TM key state at load (default saved); none shows the key-missing message, rejected the rejected one
 *   &fail=1                   every TM add fails with a tool error (watch the 3-in-a-row stop)
 *   &cap=1                    TM allows only 4 tickers per list (watch the capacity skip, and the full-list refusal)
 *   &many=1                   "Mine" holds 120 extra symbols (Robinhood chunks of 50, TM progress and Cancel)
 *   &delay=300                ms each fake TM call takes (default 300, so progress and Cancel are visible)
 */
import '../styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { fake, fakeRh, fakeTm, isTauri, TM_KEY_SLOT, type RhAccount, type RhWatchlistItem } from '../lib/api'
import { useRhStore } from '../stores/rh'
import { TmKeyPanel } from './TmKeyPanel'
import { WatchlistPane } from './WatchlistPane'

const q = new URLSearchParams(location.search)
const tm = q.get('tm') ?? 'saved'

const inst = (symbol: string, object_type = 'instrument'): RhWatchlistItem => ({ object_id: `obj-${symbol}`, object_type, symbol })

if (!isTauri()) {
  if (tm === 'saved' || tm === 'rejected') fake.secrets.add(TM_KEY_SLOT)
  if (tm === 'rejected') fakeTm.mode = 'rejected'
  if (q.get('fail') === '1') fakeTm.failAdds = 'tool error: synthetic TraderMatrix failure (dev page)'
  if (q.get('cap') === '1') fakeTm.wl.tickers_per_list = 4
  fakeTm.delayMs = Number(q.get('delay') ?? 300) || 0

  const many = q.get('many') === '1' ? Array.from({ length: 120 }, (_, i) => `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}Z`) : []
  const account: RhAccount = {
    account_number: 'DEMO00001111', rhs_account_number: null, rhc_account_number: null, agentic_allowed: false, option_level: '3',
    kind: 'margin', is_default: true, unsettled_funds: null, nickname: 'Main', brokerage_account_type: null,
  }
  fakeRh.accounts = [account]
  fakeRh.watchlists = [
    { id: 'wl-mine', display_name: 'Mine', icon_emoji: null, item_count: 6 + many.length, owner_type: 'custom', allowed_object_types: ['instrument'] },
    { id: 'wl-hot', display_name: 'Top Movers', icon_emoji: null, item_count: 1, owner_type: 'robinhood', allowed_object_types: ['instrument'] },
    { id: 'wl-opt', display_name: 'My Options', icon_emoji: null, item_count: 0, owner_type: 'custom', allowed_object_types: ['option_strategy'] },
  ]
  fakeRh.items = {
    'wl-mine': [...['AAAA', 'BBBB', 'EEEE', 'FFFF', 'BF-B'].map((s) => inst(s)), inst('BTC', 'currency_pair'), ...many.map((s) => inst(s))],
    'wl-hot': [inst('XXXX')],
  }
  void useRhStore.getState().connect()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div className="toolbar">
        <span className="title">SYNC DEV</span>
        <span className="muted">fake backend, no network, no real list or key. Press Sync in the pane.</span>
        <span className="spacer" />
        <TmKeyPanel />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WatchlistPane />
      </div>
    </div>
  </StrictMode>,
)
