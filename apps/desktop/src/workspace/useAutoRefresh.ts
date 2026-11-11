import { useEffect, useRef } from 'react'
import { startRefresher } from '../lib/refresher'

/** Runs `fn` every 20 s while `enabled` and the window is visible. */
export function useAutoRefresh(enabled: boolean, fn: () => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!enabled) return
    return startRefresher(() => ref.current())
  }, [enabled])
}
