export type PanelId = 'watchlist' | 'chart' | 'positions' | 'orders' | 'ticket' | 'options' | 'journal' | 'tm' | 'explain' | 'alerts' | 'rstats'
export const PANEL_IDS: readonly PanelId[] = ['watchlist', 'chart', 'positions', 'orders', 'ticket', 'options', 'journal', 'tm', 'explain', 'alerts', 'rstats']
export const PANEL_TITLES: Record<PanelId, string> = {
  watchlist: 'Watchlist',
  chart: 'Chart',
  positions: 'Positions',
  orders: 'Orders',
  ticket: 'Order Ticket',
  options: 'Options',
  journal: 'Journal',
  tm: 'TM Insight',
  explain: 'Explain',
  alerts: 'Alerts',
  rstats: 'R Stats',
}
