import { useEffect } from 'react'
import { useAlertsStore, type ToastItem } from '../stores/alerts'

export const TOAST_MS = 8000

function Toast({ t }: { t: ToastItem }) {
  useEffect(() => {
    const id = setTimeout(() => useAlertsStore.getState().dismissToast(t.id), TOAST_MS)
    return () => clearTimeout(id)
  }, [t.id, t.at])
  return (
    <div className={`alert-toast ${t.kind}`} role="status">
      <span className="alert-toast-text">{t.text}</span>
      <button className="alert-toast-x" aria-label="Dismiss" onClick={() => useAlertsStore.getState().dismissToast(t.id)}>
        x
      </button>
    </div>
  )
}

/** In-app alert toasts (the primary delivery). Inform only: a toast never carries an action other than dismiss. */
export function AlertToast() {
  const toasts = useAlertsStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="alert-toasts" aria-live="polite" data-testid="alert-toasts">
      {toasts.map((t) => (
        <Toast key={t.id} t={t} />
      ))}
    </div>
  )
}
