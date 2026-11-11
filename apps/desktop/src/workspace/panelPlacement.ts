import type { PanelId } from './panelIds'

export type Direction = 'left' | 'right' | 'above' | 'below' | 'within'

export interface Placement {
  /** Panel this one is placed relative to (must be added earlier). null: the first panel. */
  ref: PanelId | null
  direction: Direction
  /** Extra addPanel options (initial sizes, inactive tab). */
  extra: Record<string, unknown>
}

/**
 * The default layout, in creation order: the TraderMatrix desk arrangement (M9). The CHART is the anchor and stays dominant in the
 * centre (dockview ignores initialWidth/initialHeight on the first panel): order ticket on its LEFT rail, TM Insight on its RIGHT rail
 * with the Watchlist BELOW it, options and journal tabbed with the chart, positions and orders in a short group below the chart.
 */
export const DEFAULT_ORDER: readonly PanelId[] = ['chart', 'ticket', 'tm', 'explain', 'watchlist', 'options', 'journal', 'rstats', 'positions', 'orders', 'alerts']

export const PLACEMENT: Record<PanelId, Placement> = {
  chart: { ref: null, direction: 'right', extra: {} },
  ticket: { ref: 'chart', direction: 'left', extra: { initialWidth: 300 } },
  tm: { ref: 'chart', direction: 'right', extra: { initialWidth: 320 } },
  explain: { ref: 'tm', direction: 'within', extra: { inactive: true } },
  watchlist: { ref: 'tm', direction: 'below', extra: { initialHeight: 260 } },
  options: { ref: 'chart', direction: 'within', extra: { inactive: true } },
  journal: { ref: 'chart', direction: 'within', extra: { inactive: true } },
  rstats: { ref: 'journal', direction: 'within', extra: { inactive: true } },
  positions: { ref: 'chart', direction: 'below', extra: { initialHeight: 210 } },
  orders: { ref: 'positions', direction: 'within', extra: { inactive: true } },
  alerts: { ref: 'positions', direction: 'within', extra: { inactive: true } },
}

/** Restore uses the same neighbours as the default layout (a missing watchlist goes below TM Insight; with no TM pane it tabs with any open panel). */
export const RESTORE_OVERRIDE: Partial<Record<PanelId, { ref: PanelId; direction: Direction }>> = {}
