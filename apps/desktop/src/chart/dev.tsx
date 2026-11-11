/**
 * Dev-only entry (chart-dev.html): mounts just the ChartPane against the FAKE api backend, no Tauri,
 * no login, no network. `?symbol=AAPL&tf=15m&ind=tm_ema_ribbon,broken` picks what to show.
 * `&tm=1` turns on the TraderMatrix overlays (Apex levels, gamma flip, expected move) with the real TM sample responses
 * rescaled to the symbol's fake price; `&tm=1&tmhorizon=2 weeks` picks the band. Add `&ind=none` to hide the default indicator.
 * M11: `&vol=1` plain volume pane, `&vol=1&split=1` (or just `&split=1`) the ESTIMATED buy/sell split, `&vol=0` no pane (default: split).
 * `&opt=1` starts in option mode on a fake contract ("AAPL 2026-11-13 85 C", no volume pane); `&opt=bad` uses an unknown contract (visible error).
 * M12 desk overlay (SMA 50/200 + key Fib are on by default): `&desk=0` hides every layer, `&fib=off|key|all`, `&fvg=1`, `&atr=0|1|auto` (1 = on; auto needs `&pos=long|short` to
 * fake an open position in the symbol), `&sma=none` or `&sma=20,50,200`, `&narrow=1`, `&lb=120` (lookback override). Example: `chart-dev.html?desk=1&fib=all&fvg=1&atr=1&tf=15m`.
 * M13: `&ladder=1` turns the right-gutter level ladder on (and the fake TM overlays, unless `&tm=0`): `chart-dev.html?desk=1&ladder=1&fib=all&atr=1&fvg=1&tm=1`.
 * The candle store is the in-memory fake: the toolbar shows the running "N candles stored" count.
 */
import '../styles/app.css'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useRhStore } from '../stores/rh'
import { fake, fakePriceAt, fakeRh, fakeTm, isTauri, TM_KEY_SLOT } from '../lib/api'
import { useTmStore } from '../stores/tm'
import type { ChartOption } from './optionChart'
import { VOLUME_SETTING_KEY } from './volumeMode'
import { DEFAULT_DESK_SETTINGS, DESK_SETTING_KEY, serializeDeskSettings, type AtrMode, type DeskSettings, type FibMode } from './tmDesk/deskSettings'
import { TIMEFRAMES, type TimeframeId } from './bars'
import { builtinById } from './builtinScripts'
import { ChartPane } from './ChartPane'
import { useIndicatorStore } from './indicatorStore'
import { normalizeSymbol } from './useChartData'

const q = new URLSearchParams(location.search)
const symbol = normalizeSymbol(q.get('symbol') ?? '') ?? 'SPY'
const tf = (TIMEFRAMES.find((t) => t.id === q.get('tf'))?.id ?? '1D') as TimeframeId

const BROKEN = 'x = define(5, name="X", min=1)\nplt(ind.ema(close, nosuchname), name="broken")\n'
const wanted = (q.get('ind') ?? 'tm_ema_ribbon').split(',').filter((x) => x && x !== 'none')
const active = wanted.flatMap((id, i) => {
  const src = id === 'broken' ? BROKEN : builtinById(id)?.source
  return src ? [{ id: `${id}-${i + 1}`, scriptId: id, label: id === 'broken' ? 'Broken script' : id, source: src, inputs: {} }] : []
})
useIndicatorStore.setState({ active, loaded: true })

if (!isTauri()) {
  // pretend to be connected so the 5 s quote poll runs; the last price wobbles around the fake curve
  fakeRh.connected = true
  const wobble = () => {
    for (const s of new Set([symbol, 'SPY', 'AAPL', 'TSLA', 'QQQ'])) fakeRh.last[s] = fakePriceAt(s, Date.now()) * (1 + 0.004 * Math.sin(Date.now() / 4000))
  }
  wobble()
  setInterval(wobble, 2000)
}

if ((q.get('tm') === '1' || (q.get('ladder') === '1' && q.get('tm') !== '0')) && !isTauri()) {
  fake.secrets.add(TM_KEY_SLOT) // presence flag only: the fake backend never sees a key
  fakeTm.spotFor = (s) => fakePriceAt(s, Date.now())
  useTmStore.setState({
    settings: { apex: true, flip: true, move: true, horizon: q.get('tmhorizon') ?? '1 week' },
    settingsLoaded: true,
  })
}

if (!isTauri()) {
  const vol = q.get('vol')
  const mode = vol === '0' ? 'off' : q.get('split') === '1' ? 'split' : vol === '1' ? 'vol' : null
  if (mode) fake.settingSet(VOLUME_SETTING_KEY, mode)
}

if (!isTauri()) {
  const has = ['desk', 'fib', 'fvg', 'atr', 'sma', 'narrow', 'lb', 'ladder'].some((k) => q.has(k))
  if (has) {
    const off = q.get('desk') === '0'
    const sma = q.get('sma')
    const list = sma === null ? null : sma === 'none' ? [] : sma.split(',')
    const atr = q.get('atr')
    const fib = q.get('fib')
    const lb = Number(q.get('lb'))
    const d: DeskSettings = {
      fib: off ? 'off' : fib === 'off' || fib === 'key' || fib === 'all' ? (fib as FibMode) : DEFAULT_DESK_SETTINGS.fib,
      fvg: !off && q.get('fvg') === '1',
      sma: off ? { p20: false, p50: false, p200: false } : list ? { p20: list.includes('20'), p50: list.includes('50'), p200: list.includes('200') } : { ...DEFAULT_DESK_SETTINGS.sma },
      atr: off || atr === '0' ? 'off' : atr === '1' ? 'on' : atr === 'auto' ? ('auto' as AtrMode) : DEFAULT_DESK_SETTINGS.atr,
      narrow: q.get('narrow') === '1',
      lookbackOverride: Number.isFinite(lb) && lb > 0 ? lb : null,
      ladder: q.get('ladder') === '1',
    }
    fake.settingSet(DESK_SETTING_KEY, serializeDeskSettings(d))
  }
  const pos = q.get('pos')
  if (pos === 'long' || pos === 'short') {
    useRhStore.setState({ positions: [{ symbol, quantity: pos === 'short' ? -10 : 10, average_buy_price: 100, shares_available_for_sells: 10, shares_held_for_sells: 0 }] })
  }
}

const OPT_OK = '0f3c2a1e-5b7d-4c9a-8e21-3a4b5c6d7e8f'
const OPT_BAD = '00000000-0000-0000-0000-000000000000'
const optParam = q.get('opt')
const startOption: ChartOption | null =
  optParam === '1' || optParam === 'bad' ? { id: optParam === 'bad' ? OPT_BAD : OPT_OK, label: 'AAPL 2026-11-13 85 C', underlying: 'AAPL' } : null

function Dev() {
  const [option, setOption] = useState<ChartOption | null>(startOption)
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ChartPane symbol={startOption ? 'AAPL' : symbol} initialTimeframe={tf} option={option} onOptionBack={() => setOption(null)} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dev />
  </StrictMode>,
)
