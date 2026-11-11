import type { IDockviewPanelProps } from 'dockview-react'
import { useEffect, useState, type ComponentType } from 'react'
import { ChartPane } from '../chart/ChartPane'
import { useRhStore } from '../stores/rh'
import { ExplainPane } from './ExplainPane'
import { JournalPane } from './JournalPane'
import { OrdersPane } from './OrdersPane'
import { OrderTicketPane } from './OrderTicketPane'
import { ErrorBoundary } from './ErrorBoundary'
import { getActiveDock } from './activeDock'
import { useLayoutStore } from './layoutStore'
import { savedChartSymbol } from './panelParams'
import { PANEL_TITLES, type PanelId } from './panelIds'
import { PositionsPane } from './PositionsPane'
import { TmInsightPane } from './TmInsightPane'
import { WatchlistPane } from './WatchlistPane'

export type { PanelId } from './panelIds'

function placeholder(id: PanelId, milestone: string): ComponentType {
  const title = PANEL_TITLES[id]
  return function Placeholder() {
    return (
      <div className="placeholder">
        <h2>{title}</h2>
        <span>wired in {milestone}</span>
      </div>
    )
  }
}

/** Chart panel: the symbol is kept in the dockview panel params (saved with the layout) and mirrors the shared chartSymbol. */
function ChartPanel(props: IDockviewPanelProps<{ symbol?: string }>) {
  useState(() => {
    // params come from a saved layout: only a valid ticker string is taken
    const saved = savedChartSymbol(props.params)
    if (saved) useRhStore.setState({ chartSymbol: saved })
    return saved
  })
  const symbol = useRhStore((s) => s.chartSymbol)
  const { api } = props
  useEffect(() => {
    api.updateParameters({ symbol })
  }, [api, symbol])
  // the chart symbol takes part in the shared quote list (priority: ticket, positions, chart, watchlist)
  const connected = useRhStore((s) => s.status?.connected === true)
  useEffect(() => {
    if (!connected) return
    useRhStore.getState().watchQuotes('chart', [symbol])
    return () => useRhStore.getState().watchQuotes('chart', [])
  }, [symbol, connected])
  const option = useRhStore((s) => s.chartOption)
  return <ChartPane symbol={symbol} option={option} onOptionBack={() => useRhStore.getState().setChartOption(null)} onSymbolChange={(n) => useRhStore.getState().setChartSymbol(n)} />
}

/** Every dockview panel renders inside its own boundary: one broken pane never takes the workspace down. */
function guarded(id: PanelId, Inner: ComponentType): ComponentType {
  const reset =
    id === 'chart'
      ? {
          label: 'Reset layout',
          run: () => {
            const d = getActiveDock()
            if (d) useLayoutStore.getState().reset(d)
          },
        }
      : undefined
  return function Guarded(props: object) {
    return (
      <ErrorBoundary label={PANEL_TITLES[id]} action={reset}>
        <Inner {...props} />
      </ErrorBoundary>
    )
  }
}

const RAW: Record<PanelId, { title: string; component: ComponentType }> = {
  watchlist: { title: PANEL_TITLES.watchlist, component: WatchlistPane },
  chart: { title: PANEL_TITLES.chart, component: ChartPanel as ComponentType },
  positions: { title: PANEL_TITLES.positions, component: PositionsPane },
  orders: { title: PANEL_TITLES.orders, component: OrdersPane },
  ticket: { title: PANEL_TITLES.ticket, component: OrderTicketPane },
  options: { title: PANEL_TITLES.options, component: placeholder('options', 'M5') },
  journal: { title: PANEL_TITLES.journal, component: JournalPane },
  tm: { title: PANEL_TITLES.tm, component: TmInsightPane },
  explain: { title: PANEL_TITLES.explain, component: ExplainPane },
}

export const PANELS: Record<PanelId, { title: string; component: ComponentType }> = Object.fromEntries(
  (Object.keys(RAW) as PanelId[]).map((id) => [id, { title: RAW[id].title, component: guarded(id, RAW[id].component) }]),
) as Record<PanelId, { title: string; component: ComponentType }>
