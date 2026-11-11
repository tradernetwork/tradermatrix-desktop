import { useEffect, useState } from 'react'
import { isPaused, previewChip, quotaChip, throttleChip } from '../lib/tmQuota'
import { useTmStore } from '../stores/tm'

const POLL_MS = 15_000

/**
 * "TM 37/200 today" (amber from 80%, red when the day is used up), a "TM slow until HH:MM:SS" chip while the per-minute wall or a server backoff
 * holds calls back, and a "TM preview" chip on the free tier. Reads the local counter only: refreshing it never calls TraderMatrix.
 */
export function TmQuotaChip() {
  const quota = useTmStore((s) => s.quota)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void useTmStore.getState().refreshQuota()
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      setNow(Date.now())
      void useTmStore.getState().refreshQuota()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [])

  // the moment a pause or a throttle ends, look again (so the panes reload without waiting for the next poll)
  const until = isPaused(quota, now) ? quota?.paused_until_ms ?? null : quota?.throttled_until_ms ?? null
  useEffect(() => {
    if (until === null || until <= Date.now()) return
    const t = setTimeout(() => {
      setNow(Date.now())
      void useTmStore.getState().refreshQuota()
    }, Math.min(until - Date.now() + 500, 2_147_000_000))
    return () => clearTimeout(t)
  }, [until])

  const chips = [quotaChip(quota, now), throttleChip(quota, now), previewChip(quota)].filter((c) => c !== null)
  if (chips.length === 0) return null
  return (
    <span className="tm-quota" data-testid="tm-quota">
      {chips.map((c) => (
        <span key={c.text} className={`pill tm-quota-chip ${c.tone === 'ok' ? 'ok' : c.tone === '' ? '' : c.tone === 'warn' ? 'warn' : 'bad'}`} title={c.title}>
          {c.text}
        </span>
      ))}
    </span>
  )
}
