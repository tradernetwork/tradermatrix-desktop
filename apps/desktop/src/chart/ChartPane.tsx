import type { InputDef } from '@rebull/script'
import * as klc from 'klinecharts'
import type { Chart } from 'klinecharts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TM_DEFAULT_HORIZONS, tmErrorText } from '../lib/tmUi'
import { buildOverlayData, useTmStore } from '../stores/tm'
import { api, type CandleStats } from '../lib/api'
import { useChartContext } from '../stores/chartContext'
import { askAbout } from '../stores/explainFocus'
import { fibDigest, summarizeBars } from '../lib/explainDigest'
import { useRhStore } from '../stores/rh'
import { useDeskStatsStore } from '../stores/deskStats'
import { DEFAULT_TIMEFRAME, isIntraday, TIMEFRAMES, timeframeById, timezoneFor, type Candle, type Timeframe, type TimeframeId } from './bars'
import { backfillFromStore, SRC_EQUITY, SRC_OPTION, storeCandlesQuiet, storeStatusText } from './candleStore'
import type { ChartOption } from './optionChart'
import { DEFAULT_VOLUME_MODE, parseVolumeMode, VOLUME_MODES, VOLUME_SETTING_KEY, type VolumeMode } from './volumeMode'
import { applyVolume, registerVolumeIndicators, removeVolume } from './volumeIndicator'
import { builtinById } from './builtinScripts'
import { chartStyles } from './chartTheme'
import { IndicatorMenu } from './IndicatorMenu'
import { useIndicatorStore } from './indicatorStore'
import {
  attachScript,
  detachScript,
  onScriptResult,
  registerScriptIndicator,
  scriptStatus,
  updateScript,
  type ActiveIndicator,
} from './scriptIndicator'
import { attachTm, clearTmRegistry, detachTm, registerTmIndicator } from './tmIndicator'
import { attachDesk, detachDesk, registerDeskIndicator } from './tmDesk/deskIndicator'
import { anyLayer, cycleLayer, DEFAULT_DESK_SETTINGS, DESK_SETTING_KEY, parseDeskSettings, resolveAtr, serializeDeskSettings, soloLayer, type DeskLayer, type DeskSettings } from './tmDesk/deskSettings'
import { createOverlayMemo } from './tmDesk/overlay'
import { buildLadder, collectLadderLevels, type LadderRow } from './tmDesk/ladder'
import { LadderColumn } from './tmDesk/LadderColumn'
import { pickLadderRow } from './tmDesk/ladderPick'
import { ChartFeed, loadCandles, type LoadResult, nextBars, normalizeSymbol, overlayReady, POLL_MS, pushData, refreshData, RequestGuard, shouldPoll } from './useChartData'

export interface ChartPaneProps {
  symbol: string
  onSymbolChange?: (s: string) => void
  /** Option mode: show this contract's price history (no volume, no TM overlays or scripts) instead of the equity. */
  option?: ChartOption | null
  /** "Back to AAPL": leave option mode. */
  onOptionBack?: () => void
  initialTimeframe?: TimeframeId
}

type Phase = 'idle' | 'loading' | 'ready' | 'error'

/** Intraday history is re-read this often while the window is visible, so bars that opened after the first load appear. */
export const HISTORY_REFRESH_MS = 120_000

/** Chart-head width under which the desk layer pills collapse into a "Layers" popover. */
export const DESK_COMPACT_PX = 700
/** Right gutter in px: KLineChart's default, and the wider one used while fib / ATR labels need room. */
const OFFSET_DEFAULT = 80
const OFFSET_LABELS = 96
let deskSeq = 0

/** The shared Robinhood status says we are NOT connected: chart polls and refetches stay quiet (null = not known yet, carry on). */
const rhDisconnected = () => useRhStore.getState().status?.connected === false

/**
 * One bars load for the equity or, in option mode, the contract: fetch, then store what came back (fire-and-forget,
 * never blocks or breaks the chart) and, when the server returned less history than the span needs, merge older stored candles.
 */
async function loadBars(symbol: string, option: ChartOption | null, tf: Timeframe, now: number): Promise<LoadResult> {
  const fetcher = option ? (_s: string, i: string, st: string) => api.rhOptionHistoricals(option.id, i, st).then((h) => [h]) : (s: string, i: string, st: string) => api.rhHistoricals(s, i, st)
  const source = option ? SRC_OPTION : SRC_EQUITY
  const instrument = option ? option.id : symbol
  const r = await loadCandles(fetcher, option ? option.label : symbol, tf, now)
  if (r.error) return r
  void storeCandlesQuiet(api, source, instrument, tf.id, r.candles)
  return { candles: await backfillFromStore(api, source, instrument, tf, r.candles, now), error: null }
}

export function ChartPane({ symbol: symbolProp, onSymbolChange, option = null, onOptionBack, initialTimeframe = DEFAULT_TIMEFRAME }: ChartPaneProps) {
  const optId = option?.id ?? null
  const boxRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const feedRef = useRef(new ChartFeed())
  const barsRef = useRef<Candle[]>([])
  const loadGuard = useRef(new RequestGuard())
  const attached = useRef(new Map<string, { sig: string; created: boolean }>()) // indicator id -> state at last run

  const [symbol, setSymbol] = useState(() => normalizeSymbol(symbolProp) ?? 'SPY')
  const [draft, setDraft] = useState(symbol)
  const [tfId, setTfId] = useState<TimeframeId>(initialTimeframe)
  const [phase, setPhase] = useState<Phase>('idle')
  /** The symbol the bars on screen belong to (set when a load succeeds). */
  const [loadedSymbol, setLoadedSymbol] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [barCount, setBarCount] = useState(0)
  const [dataVersion, setDataVersion] = useState(0)
  const [pollError, setPollError] = useState('')
  const [scriptTick, setScriptTick] = useState(0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const loadingRef = useRef(false)
  const [volMode, setVolMode] = useState<VolumeMode>(DEFAULT_VOLUME_MODE)
  const volApplied = useRef<VolumeMode | null>(null)
  const [storeStats, setStoreStats] = useState<CandleStats | null>(null)
  const [loadedTf, setLoadedTf] = useState<TimeframeId | null>(null)
  const [liveTick, setLiveTick] = useState(0)
  const [desk, setDesk] = useState<DeskSettings>(DEFAULT_DESK_SETTINGS)
  const [compact, setCompact] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const deskId = useRef(`rebull-tmdesk-${++deskSeq}`)
  const offsetRef = useRef(OFFSET_DEFAULT)
  const statsMemo = useRef(createOverlayMemo())
  const ladderMemo = useRef(createOverlayMemo())
  const [ladderTick, setLadderTick] = useState(0)
  const ticketSymbol = useRhStore((s) => s.chartSymbol)
  const positions = useRhStore((s) => s.positions)
  const atrRes = useMemo(() => resolveAtr(desk.atr, symbol, positions), [desk.atr, symbol, positions])

  const tm = useTmStore((s) => s.settings)
  const tmSettingsLoaded = useTmStore((s) => s.settingsLoaded)
  const tmEpoch = useTmStore((s) => s.epoch)
  const tmEntry = useTmStore((s) => s.bySymbol[symbol])
  const tmApex = tmEntry?.apex.data ?? null
  const tmMove = tmEntry?.move.data ?? null
  const tmErr = tmEntry?.apex.error || tmEntry?.move.error || ''

  const active = useIndicatorStore((s) => s.active)
  const loaded = useIndicatorStore((s) => s.loaded)

  // follow the symbol prop (Watchlist/Positions clicks, restored layouts)
  useEffect(() => {
    const n = normalizeSymbol(symbolProp)
    if (n && n !== symbol) {
      setSymbol(n)
      setDraft(n)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolProp])

  // chart lifecycle
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    registerScriptIndicator(klc)
    registerTmIndicator(klc)
    registerDeskIndicator(klc)
    registerVolumeIndicators(klc)
    const chart = klc.init(el, { styles: chartStyles(), locale: 'en-US', timezone: 'America/New_York' })
    if (!chart) return
    chart.setDataLoader(feedRef.current.loader)
    chartRef.current = chart
    offsetRef.current = OFFSET_DEFAULT
    const ro = new ResizeObserver(() => {
      chart.resize()
      setCompact(el.clientWidth < DESK_COMPACT_PX)
      setLadderTick((t) => t + 1)
    })
    ro.observe(el)
    const myDeskId = deskId.current
    return () => {
      ro.disconnect()
      attached.current.clear()
      volApplied.current = null
      clearTmRegistry()
      detachDesk(null, myDeskId)
      useDeskStatsStore.getState().clear()
      chartRef.current = null
      klc.dispose(el)
    }
  }, [])

  // ladder column: re-place the rows whenever the visible range (zoom, scroll, y-axis rescale) changes
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !desk.ladder) return
    const bump = () => setLadderTick((t) => t + 1)
    chart.subscribeAction('onZoom', bump)
    chart.subscribeAction('onScroll', bump)
    chart.subscribeAction('onVisibleRangeChange', bump)
    bump()
    return () => {
      chart.unsubscribeAction('onZoom', bump)
      chart.unsubscribeAction('onScroll', bump)
      chart.unsubscribeAction('onVisibleRangeChange', bump)
    }
  }, [desk.ladder])

  useEffect(() => {
    if (!useIndicatorStore.getState().loaded) void useIndicatorStore.getState().load()
  }, [])

  // volume mode: remembered through the settings table
  useEffect(() => {
    let stop = false
    api
      .settingGet(VOLUME_SETTING_KEY)
      .then((raw) => {
        if (!stop) setVolMode(parseVolumeMode(raw))
      })
      .catch(() => undefined)
    return () => {
      stop = true
    }
  }, [])
  const chooseVolume = (m: VolumeMode) => {
    setVolMode(m)
    void api.settingSet(VOLUME_SETTING_KEY, m).catch(() => undefined)
  }

  // volume pane under the price pane: none for option charts (their bars have no volume)
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const want: VolumeMode = optId ? 'off' : volMode
    if (volApplied.current === want) return
    if (want === 'off') removeVolume(chart)
    else applyVolume(chart, want)
    volApplied.current = want
  }, [volMode, optId])

  // desk overlay layers: remembered through the settings table (garbage or a future version falls back to the defaults)
  useEffect(() => {
    let stop = false
    api
      .settingGet(DESK_SETTING_KEY)
      .then((raw) => {
        if (!stop) setDesk(parseDeskSettings(raw))
      })
      .catch(() => undefined)
    return () => {
      stop = true
    }
  }, [])
  const chooseDesk = (next: DeskSettings) => {
    setDesk(next)
    void api.settingSet(DESK_SETTING_KEY, serializeDeskSettings(next)).catch(() => undefined)
  }
  const onLayer = (layer: DeskLayer, shift: boolean) => chooseDesk(shift ? soloLayer(desk, layer) : cycleLayer(desk, layer))

  // "N candles stored (X MB)": read on mount, after each load and once a minute
  const refreshStats = useCallback(() => {
    api
      .candlesStats()
      .then(setStoreStats)
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    refreshStats()
    const id = setInterval(refreshStats, 60_000)
    return () => clearInterval(id)
  }, [refreshStats])

  useEffect(() => {
    if (!useTmStore.getState().settingsLoaded) void useTmStore.getState().loadSettings()
  }, [])

  // TraderMatrix overlay data: only fetched while a toggle is on; the store caches (apex 60 s, move 5 min) so this is cheap
  useEffect(() => {
    if (!tmSettingsLoaded || optId) return
    const legs = [...(tm.apex || tm.flip ? (['apex'] as const) : []), ...(tm.move ? (['move'] as const) : [])]
    if (legs.length === 0) return
    void useTmStore.getState().loadSymbol(symbol, legs)
    const id = setInterval(() => {
      if (!document.hidden) void useTmStore.getState().loadSymbol(symbol, legs)
    }, 60_000)
    return () => clearInterval(id)
  }, [symbol, tm.apex, tm.flip, tm.move, tmEpoch, tmSettingsLoaded, optId])

  // TraderMatrix overlay: attached while a toggle is on and its data is present, removed otherwise (chart is unaffected)
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const o = buildOverlayData(tm, tmApex, tmMove)
    // only once the chart is ready for THIS symbol and the TM data is this symbol's (a symbol switch never paints the old levels)
    const ready = overlayReady({ phase, symbol, loadedSymbol, apexSymbol: tmApex?.symbol ?? null, moveSymbol: tmMove?.symbol ?? null })
    if (o && ready && !optId && chart.getDataList().length > 0) attachTm(chart, o)
    else detachTm(chart)
  }, [tm, tmApex, tmMove, dataVersion, phase, symbol, loadedSymbol, optId])

  // desk overlay (SMA, Fib, FVG, ATR): equity charts only (an option's bars carry no volume), once this symbol's bars of this timeframe are on screen
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const ready = !optId && phase === 'ready' && loadedSymbol === symbol && loadedTf === tfId && chart.getDataList().length > 0
    if (ready && anyLayer(desk, atrRes.show)) {
      const want = desk.fib !== 'off' || atrRes.show ? OFFSET_LABELS : OFFSET_DEFAULT
      if (offsetRef.current !== want) {
        chart.setOffsetRightDistance(want)
        offsetRef.current = want
      }
      attachDesk(chart, deskId.current, { settings: desk, tf: tfId, atrOn: atrRes.show, atrSide: atrRes.side })
    } else {
      detachDesk(chart, deskId.current)
      if (offsetRef.current !== OFFSET_DEFAULT) {
        chart.setOffsetRightDistance(OFFSET_DEFAULT)
        offsetRef.current = OFFSET_DEFAULT
      }
    }
  }, [desk, atrRes, tfId, dataVersion, phase, symbol, loadedSymbol, loadedTf, optId])

  // explain chat: which overlays are switched on (enum / boolean values only)
  useEffect(() => {
    useChartContext.getState().setOverlays({ fib: desk.fib, fvg: desk.fvg, ma: ([20, 50, 200] as const).filter((p) => desk.sma[`p${p}` as 'p20' | 'p50' | 'p200']), atr: desk.atr })
  }, [desk])

  // header chips (ATR(len), range pos): from the same bars and the same memoized math, even while every layer is hidden
  useEffect(() => {
    const bars = barsRef.current
    if (optId || phase !== 'ready' || loadedSymbol !== symbol || loadedTf !== tfId || bars.length === 0) {
      useDeskStatsStore.getState().clear()
      useChartContext.getState().setChart(null, null)
      useChartContext.getState().setRecentBars(null)
      return
    }
    const o = statsMemo.current.get(bars, tfId, { lookbackOverride: desk.lookbackOverride, narrow: false, side: 'long', fvg: false })
    // what the explain chat is allowed to know about this chart: numbers from these bars only
    useChartContext.getState().setChart({ symbol, tf: tfId, ...summarizeBars(bars) }, fibDigest(o.fib))
    useChartContext.getState().setRecentBars(bars.slice(-30))
    useDeskStatsStore.getState().set({
      symbol,
      atrLen: o.atrLen,
      atr: Number.isFinite(o.atrValue) ? o.atrValue : null,
      rangePos: Number.isFinite(o.rangePos) ? o.rangePos : null,
      tf: tfId,
    })
  }, [dataVersion, liveTick, phase, symbol, loadedSymbol, loadedTf, tfId, optId, desk.lookbackOverride])

  // data: reload on symbol or timeframe change; a stale response is dropped
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const tf = timeframeById(tfId)
    const ticket = loadGuard.current.next()
    loadingRef.current = true
    chart.setTimezone(timezoneFor(tf))
    setPhase('loading')
    setMessage('')
    setPollError('')
    void loadBars(symbol, option, tf, Date.now()).then((r) => {
      if (!loadGuard.current.isCurrent(ticket) || chartRef.current !== chart) return
      loadingRef.current = false
      barsRef.current = r.candles
      pushData(chart, feedRef.current, option ? option.id : symbol, tf, r.candles, option ? 2 : undefined)
      refreshStats()
      setBarCount(r.candles.length)
      setLoadedSymbol(r.error ? null : option ? option.id : symbol)
      setLoadedTf(r.error ? null : tf.id)
      setPhase(r.error ? 'error' : 'ready')
      setMessage(r.error ?? '')
      setDataVersion((v) => v + 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tfId, optId])

  // intraday: re-read the history every 2 minutes while visible (quotes alone never open a bar)
  useEffect(() => {
    const tf = timeframeById(tfId)
    if (!isIntraday(tf)) return
    let stop = false
    const guard = new RequestGuard()
    const tick = async () => {
      const chart = chartRef.current
      if (stop || !chart || document.hidden || loadingRef.current || barsRef.current.length === 0 || rhDisconnected()) return
      const t = guard.next()
      const r = await loadBars(symbol, option, tf, Date.now())
      if (stop || !guard.isCurrent(t) || loadingRef.current || chartRef.current !== chart || r.error) return
      barsRef.current = r.candles
      refreshData(chart, feedRef.current, r.candles)
      setBarCount(r.candles.length)
      setDataVersion((v) => v + 1)
    }
    const id = setInterval(() => void tick(), HISTORY_REFRESH_MS)
    return () => {
      stop = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tfId, optId])

  // script results can arrive after the data (calc is deferred); refresh error text
  useEffect(() => onScriptResult(() => setScriptTick((t) => t + 1)), [])

  // indicators: attach once there is data, update on input change, detach on removal.
  // A script that failed to attach (compile error, or an error on this symbol's data) is retried on new data.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !loaded) return
    const next: Record<string, string> = {}
    // option charts carry no volume: scripts and overlays that need it are detached (and come back with the equity)
    const wanted = optId ? [] : active
    const keep = new Set(wanted.map((a) => a.id))
    for (const id of [...attached.current.keys()]) {
      if (!keep.has(id)) {
        detachScript(chart, id)
        attached.current.delete(id)
      }
    }
    const hasData = chart.getDataList().length > 0
    for (const a of wanted) {
      const sig = JSON.stringify(a.inputs)
      const have = attached.current.get(a.id)
      let err: string | null = null
      if (!have || !have.created) {
        if (!hasData) continue
        const r = attachScript(chart, a)
        err = r.error
        attached.current.set(a.id, { sig, created: r.error === null })
      } else if (have.sig !== sig) {
        err = updateScript(chart, a).error
        attached.current.set(a.id, { sig, created: true })
      } else {
        err = scriptStatus(a.id).error
      }
      if (err) next[a.id] = err
    }
    setErrors(next)
  }, [active, loaded, dataVersion, scriptTick, optId])

  // live last-bar update: poll quotes every 5 s while visible
  useEffect(() => {
    if (optId) return // no live quote path for a contract: its history refresh above keeps it current
    let stop = false
    const tick = async () => {
      if (!shouldPoll({ hidden: typeof document !== 'undefined' && document.hidden, haveData: barsRef.current.length > 0, symbol })) return
      if (loadingRef.current || rhDisconnected()) return
      const tf = timeframeById(tfId)
      try {
        const q = (await api.rhQuotes([symbol]))[0]
        if (stop || loadingRef.current || chartRef.current === null) return
        const r = nextBars(barsRef.current, q, Date.now(), tf)
        setPollError('')
        if (r.changed) {
          barsRef.current = r.bars
          feedRef.current.pushLast(r.bars[r.bars.length - 1]!)
          setBarCount(r.bars.length)
          setLiveTick((t) => t + 1)
        }
      } catch (e) {
        if (!stop) setPollError(e instanceof Error ? e.message : String(e))
      }
    }
    const id = setInterval(() => void tick(), POLL_MS)
    const onVis = () => {
      if (!document.hidden) void tick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stop = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [symbol, tfId, optId])

  const commitSymbol = useCallback(
    (raw: string) => {
      const n = normalizeSymbol(raw)
      if (!n) {
        setDraft(symbol)
        return
      }
      setDraft(n)
      if (n !== symbol) {
        setSymbol(n)
        onSymbolChange?.(n)
      }
    },
    [symbol, onSymbolChange],
  )

  // every point level the ladder knows (shared by the ladder rows and the right-click level pick)
  const levelsNow = (bars: Candle[]) => {
    const overlay = ladderMemo.current.get(bars, tfId, { lookbackOverride: desk.lookbackOverride, narrow: desk.narrow, side: atrRes.side, fvg: desk.fvg })
    return collectLadderLevels({
      apex: tmApex?.symbol === symbol ? tmApex : null,
      move: tmMove?.symbol === symbol ? tmMove : null,
      tm: { apex: tm.apex, flip: tm.flip, move: tm.move, horizon: tm.horizon },
      desk,
      atrOn: atrRes.show,
      overlay,
    })
  }
  const yOfPrice = (p: number): number => {
    const c = chartRef.current?.convertToPixel({ value: p }, { paneId: 'candle_pane' }) as { y?: number } | undefined
    return typeof c?.y === 'number' ? c.y : NaN
  }
  // right click on the chart: a level line within 6 px, else the candle under the pointer, offers "Ask Arya about this" (never sends)
  const onChartContext = (e: React.MouseEvent<HTMLDivElement>) => {
    const chart = chartRef.current
    const bars = barsRef.current
    if (optId || phase !== 'ready' || !chart || bars.length === 0) return
    e.preventDefault()
    const at = { x: e.clientX, y: e.clientY }
    try {
      const r = e.currentTarget.getBoundingClientRect()
      for (const lv of levelsNow(bars)) {
        const py = yOfPrice(lv.price)
        if (Number.isFinite(py) && Math.abs(py - (e.clientY - r.top)) <= 6) return askAbout({ kind: 'level', price: lv.price, source: lv.source }, at)
      }
      const pt = (chart.convertFromPixel([{ x: e.clientX - r.left }], { paneId: 'candle_pane' }) as { dataIndex?: number; timestamp?: number }[])[0] ?? {}
      const i = typeof pt.dataIndex === 'number' ? pt.dataIndex : -1
      const bar = (typeof pt.timestamp === 'number' ? bars.find((b) => b.timestamp === pt.timestamp) : undefined) ?? bars[i]
      const k = bar ? bars.indexOf(bar) : -1
      if (bar) askAbout({ kind: 'candle', bar: { ts: bar.timestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }, prevClose: k > 0 ? bars[k - 1]!.close : null }, at)
    } catch {
      /* a failed pick must never break the chart */
    }
  }

  // level ladder rows (equity charts only; recomputed on pan/zoom, new bars, TM data and layer changes)
  const ladderRows: LadderRow[] = useMemo(() => {
    const chart = chartRef.current
    const bars = barsRef.current
    if (!desk.ladder || optId || !chart || phase !== 'ready' || loadedSymbol !== symbol || loadedTf !== tfId || bars.length === 0) return []
    try {
      const levels = levelsNow(bars)
      const size = chart.getSize('candle_pane', 'main')
      const h = size?.height ?? boxRef.current?.clientHeight ?? 0
      return buildLadder(levels, bars[bars.length - 1]!.close, h, { yOf: yOfPrice })
    } catch {
      return [] // a bad ladder must never break the chart
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk, tm, tmApex, tmMove, atrRes, dataVersion, liveTick, ladderTick, phase, symbol, loadedSymbol, loadedTf, tfId, optId])
  const onLadderPick = (row: LadderRow) => {
    pickLadderRow(row, { chartSymbol: symbol, ticketSymbol, optionMode: optId !== null })
  }

  const defs: Record<string, InputDef[]> = {}
  for (const a of active) defs[a.id] = scriptStatus(a.id).output?.inputs ?? []

  const status =
    phase === 'loading'
      ? 'loading'
      : phase === 'error'
        ? message
        : phase === 'ready'
          ? option
            ? `${barCount} bars`
            : `${barCount} bars · polled ${POLL_MS / 1000} s${pollError ? ` · ${pollError}` : ''}`
          : ''
  const smaOn = desk.sma.p20 || desk.sma.p50 || desk.sma.p200
  const deskPills = (
    <>
      <button
        className={desk.fib !== 'off' ? 'active' : ''}
        aria-pressed={desk.fib !== 'off'}
        title={`Fibonacci from the higher-timeframe swing. off > key (0.382, 0.5, 0.618) > all (full ladder, extensions, and the "script zone" box). Now: ${desk.fib}`}
        onClick={(e) => onLayer('fib', e.shiftKey)}
      >
        Fib {desk.fib}
      </button>
      <button className={desk.fvg ? 'active' : ''} aria-pressed={desk.fvg} title="Fair-value gaps: nearest 3 above and 3 below the price, unmitigated, at least 0.25 ATR tall" onClick={(e) => onLayer('fvg', e.shiftKey)}>
        FVG
      </button>
      <button className={smaOn ? 'active' : ''} aria-pressed={smaOn} title="Simple moving averages 50 and 200 (click: on/off)" onClick={(e) => onLayer('sma', e.shiftKey)}>
        MA
      </button>
      <button
        className={atrRes.show ? 'active' : ''}
        aria-pressed={atrRes.show}
        title={`ATR stop and 3 targets from the last close. auto: only while you hold ${symbol} (side from the position), on: always, off. Now: ${desk.atr}${atrRes.show ? `, ${atrRes.side}` : ''}`}
        onClick={(e) => onLayer('atr', e.shiftKey)}
      >
        ATR {desk.atr}
      </button>
      <button
        className={desk.ladder ? 'active' : ''}
        aria-pressed={desk.ladder}
        title="Right-gutter ladder of every level (Apex, gamma flip, expected move, Fib, ATR, FVG) without overlaps. Click a level to put it in the ticket limit price (you still review and place)."
        onClick={() => chooseDesk({ ...desk, ladder: !desk.ladder })}
      >
        Ladder
      </button>
    </>
  )

  const errorList = (optId ? [] : active).filter((a: ActiveIndicator) => errors[a.id]).map((a) => `${a.label}: ${errors[a.id]}`)

  return (
    <div className="chart-pane">
      <div className="chart-head">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            commitSymbol(draft)
          }}
        >
          <input
            className="chart-symbol"
            aria-label="Symbol"
            value={draft}
            maxLength={10}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            onBlur={() => commitSymbol(draft)}
          />
        </form>
        {option && (
          <div className="chart-opt">
            <span className="chart-opt-label" title="Option contract price history (OHLC from Robinhood)">
              {option.label}
            </span>
            <button onClick={() => onOptionBack?.()} title={`Back to the ${option.underlying} equity chart`}>
              back to {option.underlying}
            </button>
          </div>
        )}
        <div className="chart-tf" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <button key={t.id} className={t.id === tfId ? 'active' : ''} onClick={() => setTfId(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {!option && (
          <div className="chart-vol" role="group" aria-label="Volume pane">
            {VOLUME_MODES.map((m) => (
              <button key={m.id} className={m.id === volMode ? 'active' : ''} aria-pressed={m.id === volMode} title={m.title} onClick={() => chooseVolume(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        )}
        <IndicatorMenu
          active={active}
          defs={defs}
          errors={errors}
          onAdd={(scriptId) => {
            const b = builtinById(scriptId)
            if (b) useIndicatorStore.getState().add(b.id, b.source, b.label.replace(/ \(.*\)$/, ''))
          }}
          onRemove={(id) => useIndicatorStore.getState().remove(id)}
          onInput={(id, k, v) => useIndicatorStore.getState().setInput(id, k, v)}
        />
        <div className="chart-tm" role="group" aria-label="TraderMatrix overlays (positioning, not targets)" title={tmErr ? tmErrorText(tmErr) : 'TraderMatrix positioning overlays: Apex levels, gamma flip, expected-move bands'}>
          <span className="tm-badge">TM</span>
          {(
            [
              ['apex', 'Apex'],
              ['flip', 'γ flip'],
              ['move', 'Exp. move'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={tm[k] ? 'active' : ''} aria-pressed={tm[k]} onClick={() => useTmStore.getState().setToggle(k, !tm[k])}>
              {label}
            </button>
          ))}
          <select aria-label="Expected move horizon" value={tm.horizon} disabled={!tm.move} onChange={(e) => useTmStore.getState().setHorizon(e.target.value)}>
            {[...new Set([tm.horizon, ...(tmMove && tmMove.horizons.length ? tmMove.horizons.map((h) => h.label) : TM_DEFAULT_HORIZONS)])].map((h) => (
              <option key={h}>{h}</option>
            ))}
          </select>
          {tmErr && (tm.apex || tm.flip || tm.move) && <span className="chart-tm-err">TM unavailable</span>}
        </div>
        {!option && (
          <div className="chart-desk" role="group" aria-label="Desk overlay layers" title="Desk overlay: click cycles a layer, shift-click shows only that layer">
            <span className="tm-badge">Desk</span>
            {compact ? (
              <>
                <button className={layersOpen ? 'active' : ''} aria-expanded={layersOpen} aria-haspopup="true" onClick={() => setLayersOpen((o) => !o)}>
                  Layers
                </button>
                {layersOpen && <div className="chart-desk-pop">{deskPills}</div>}
              </>
            ) : (
              deskPills
            )}
          </div>
        )}
        <span className="chart-store" title="Every candle this chart loads is kept in the local database (no retention limit yet)">
          {storeStatusText(storeStats)}
        </span>
        <span className={`chart-status${phase === 'error' ? ' err' : ''}`} role="status">
          {status}
        </span>
      </div>
      {errorList.length > 0 && (
        <div className="chart-errors" role="alert">
          {errorList.map((m) => (
            <div key={m}>{m}</div>
          ))}
        </div>
      )}
      <div className="chart-body">
        <div ref={boxRef} className={`chart-canvas${desk.ladder && !option ? ' ladder-on' : ''}`} onContextMenu={onChartContext} />
        {desk.ladder && !option && <LadderColumn rows={ladderRows} onPick={onLadderPick} />}
        {phase === 'error' && message && <div className="chart-msg">{message}</div>}
        {option && phase === 'ready' && <div className="chart-note">Option bars carry price only: no volume pane.</div>}
      </div>
    </div>
  )
}
