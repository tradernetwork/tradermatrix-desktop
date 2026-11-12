/**
 * Dev-only entry (workspace-dev.html, M22): mounts the REAL app shell (Workspace = Toolbar + DeskHeader + dockview default layout with every real pane)
 * on the FAKE api backend. No Tauri, no login, no network, no real order; the vault is pre-unlocked in the fake and the red FAKE DATA banner shows.
 * Everything on screen is synthetic (sample symbols AAPL, MSFT, F, TSLA, SPY, NVDA and a DEMO account), so this page doubles as the source for public screenshots.
 *   ?w=1172&h=982        wrap the app in a fixed-size box (px) so a screenshot has exact dimensions (default: the whole window)
 *   &density=compact|comfortable   force the density (default: automatic, compact under 1300 px width)
 *   &strip=line|cards    metrics strip under the header (default line)
 *   &tm=1                TraderMatrix overlays on (Apex, flip, expected move) with the fake TM key present
 *   &symbol=AAPL         chart symbol
 */
import '../styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { normalizeSymbol } from '../chart/useChartData'
import { fake, fakePriceAt, fakeRh, fakeTm, isTauri, TM_KEY_SLOT, type RhAccount } from '../lib/api'
import { UI_DENSITY_KEY, UI_STRIP_KEY } from '../lib/layoutBudget'
import { useRhStore } from '../stores/rh'
import { Workspace } from './Workspace'

const q = new URLSearchParams(location.search)
const symbol = normalizeSymbol(q.get('symbol') ?? '') ?? 'AAPL'
const num = (k: string): number | null => {
  const n = Number(q.get(k))
  return Number.isFinite(n) && n >= 200 ? Math.round(n) : null
}
const w = num('w')
const h = num('h')

if (!isTauri()) {
  // vault already created and unlocked in the fake (no passphrase prompt over the screenshot)
  fake.vault = { passphrase: 'dev-only-fake-passphrase', unlocked: true }
  const d = q.get('density')
  if (d === 'compact' || d === 'comfortable') void fake.settingSet(UI_DENSITY_KEY, d)
  const s = q.get('strip')
  if (s === 'line' || s === 'cards') void fake.settingSet(UI_STRIP_KEY, s)
  if (q.get('tm') === '1') {
    fake.secrets.add(TM_KEY_SLOT) // presence flag only: the fake backend never sees a key
    fakeTm.spotFor = (sym) => fakePriceAt(sym, Date.now())
    void fake.settingSet('chart.tm', JSON.stringify({ apex: true, flip: true, move: true, horizon: '1 week' }))
  }
  const acct = (o: Partial<RhAccount>): RhAccount => ({
    account_number: 'DEMO00001111', rhs_account_number: null, rhc_account_number: null, agentic_allowed: false, option_level: '3',
    kind: 'margin', is_default: true, unsettled_funds: null, nickname: 'Main', brokerage_account_type: null, ...o,
  })
  fakeRh.approvalsOn = true
  fakeRh.accounts = [acct({ account_number: 'DEMO00005678', agentic_allowed: true, nickname: 'Demo agentic', kind: 'limited_margin' })]
  fakeRh.portfolios = { DEMO00005678: { total_value: 25000, equity_value: 22000, options_value: 0, cash: 3000, buying_power: 6000, currency: 'USD' } }
  const px = (sym: string) => fakePriceAt(sym, Date.now())
  fakeRh.positions = {
    DEMO00005678: [
      { symbol: 'AAPL', quantity: 40, average_buy_price: Math.round(px('AAPL') * 90) / 100, shares_available_for_sells: 40, shares_held_for_sells: 0 },
      { symbol: 'MSFT', quantity: 10, average_buy_price: Math.round(px('MSFT') * 105) / 100, shares_available_for_sells: 10, shares_held_for_sells: 0 },
      { symbol: 'TSLA', quantity: 3, average_buy_price: Math.round(px('TSLA') * 110) / 100, shares_available_for_sells: 3, shares_held_for_sells: 0 },
    ],
  }
  fakeRh.watchlists = [{ id: 'wl-demo', display_name: 'Demo list', icon_emoji: null, item_count: 4, owner_type: 'custom', allowed_object_types: ['instrument'] }]
  fakeRh.items = { 'wl-demo': ['SPY', 'AAPL', 'MSFT', 'NVDA'].map((sym, i) => ({ object_id: String(i), object_type: 'instrument', symbol: sym })) }
  const wobble = () => {
    for (const sym of new Set([symbol, 'SPY', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'F'])) {
      const last = fakePriceAt(sym, Date.now()) * (1 + 0.004 * Math.sin(Date.now() / 4000))
      fakeRh.last[sym] = last
      fakeRh.touch[sym] = { bid: Math.round((last - 0.03) * 100) / 100, ask: Math.round((last + 0.03) * 100) / 100 }
    }
  }
  wobble()
  setInterval(wobble, 2000)
  useRhStore.setState({ chartSymbol: symbol })
  void useRhStore.getState().connect()
}

const frame: React.CSSProperties = w && h ? { width: w, height: h, position: 'relative', overflow: 'hidden', outline: '1px solid #2a3550' } : { width: '100vw', height: '100vh' }
if (w && h) document.body.style.overflow = 'auto'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div id="dev-frame" style={frame}>
      <Workspace />
    </div>
  </StrictMode>,
)
