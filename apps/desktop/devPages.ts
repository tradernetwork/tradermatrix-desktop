/**
 * Rollup entries. The app entry is always built. The dev pages (fake backend, no Tauri) are built ONLY when
 * REBULL_DEV_PAGES=1, so a production/Tauri bundle never carries them.
 */
export function rollupInputs(env: Record<string, string | undefined>): Record<string, string> {
  const input: Record<string, string> = { main: 'index.html' }
  if (env.REBULL_DEV_PAGES === '1') {
    input.chartDev = 'chart-dev.html'
    input.ticketDev = 'ticket-dev.html'
    input.journalDev = 'journal-dev.html'
    input.tmDev = 'tm-dev.html'
    input.syncDev = 'sync-dev.html'
    input.chatDev = 'chat-dev.html'
  }
  return input
}
