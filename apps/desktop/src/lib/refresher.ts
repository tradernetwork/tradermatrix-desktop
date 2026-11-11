/** Auto-refresh for the Orders and Positions panes: every 20 s while the window is visible, and once when it becomes visible again. */
export const REFRESH_MS = 20_000

export interface RefreshOptions {
  ms?: number
  isHidden?: () => boolean
}

/** Starts the timer; returns the stop function. `fn` is not called immediately (the pane loads on its own). */
export function startRefresher(fn: () => void, opts: RefreshOptions = {}): () => void {
  const hidden = opts.isHidden ?? (() => typeof document !== 'undefined' && document.hidden)
  const id = setInterval(() => {
    if (!hidden()) fn()
  }, opts.ms ?? REFRESH_MS)
  const onVis = () => {
    if (!hidden()) fn()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
  return () => {
    clearInterval(id)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
  }
}
