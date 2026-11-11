import { useEffect } from 'react'
import { getActiveDock } from './activeDock'
import { confirmAskAbout, dismissAskAbout, useFocusStore } from '../stores/explainFocus'

/**
 * The one-item "Ask Arya about this" menu (M16 B4), opened by a right click on a candle, level, ladder row, position, strike-check row or
 * journal trade. EXPLAIN ONLY: choosing the item prefills the Explain pane's question box and attaches the numbers for that item to the
 * NEXT question. It never sends. Closes on Escape, a click elsewhere, scrolling or a window blur.
 */
export function AskAboutMenu() {
  const menu = useFocusStore((s) => s.menu)
  useEffect(() => {
    if (!menu) return
    const close = () => dismissAskAbout()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.ask-menu')) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menu])
  if (!menu) return null
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - 220))
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - 60))
  return (
    <div className="ask-menu" role="menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      <button
        type="button"
        role="menuitem"
        autoFocus
        title="Fills the question box with a question about this and adds its numbers. Nothing is sent until you press Ask."
        onClick={() => {
          confirmAskAbout()
          try {
            getActiveDock()?.getPanel('explain')?.api.setActive()
          } catch {
            /* no dock (dev page) or the panel is closed */
          }
        }}
      >
        Ask Arya about this: {menu.focus.label}
      </button>
    </div>
  )
}
