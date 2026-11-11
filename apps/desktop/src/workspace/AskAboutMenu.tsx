import { useEffect } from 'react'
import { getActiveDock } from './activeDock'
import { useAlertMenu } from '../stores/alertMenu'
import { confirmAskAbout, dismissAskAbout, useFocusStore } from '../stores/explainFocus'

/**
 * The one-item "Ask Arya about this" menu (M16 B4), opened by a right click on a candle, level, ladder row, position, strike-check row or
 * journal trade. EXPLAIN ONLY: choosing the item prefills the Explain pane's question box and attaches the numbers for that item to the
 * NEXT question. It never sends. Closes on Escape, a click elsewhere, scrolling or a window blur.
 */
export function AskAboutMenu() {
  const menu = useFocusStore((s) => s.menu)
  const alertMenu = useAlertMenu((s) => s.menu)
  const open = menu ?? alertMenu
  useEffect(() => {
    if (!open) return
    const close = () => {
      dismissAskAbout()
      useAlertMenu.getState().setMenu(null)
    }
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
  }, [open])
  if (!open) return null
  const left = Math.max(4, Math.min(open.x, window.innerWidth - 240))
  const top = Math.max(4, Math.min(open.y, window.innerHeight - 40 - 30 * ((alertMenu?.items.length ?? 0) + (menu ? 1 : 0))))
  return (
    <div className="ask-menu" role="menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {alertMenu?.items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          title={it.title}
          onClick={() => {
            useAlertMenu.getState().setMenu(null)
            dismissAskAbout()
            it.run()
          }}
        >
          {it.label}
        </button>
      ))}
      {menu && (
      <button
        type="button"
        role="menuitem"
        autoFocus={!alertMenu}
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
      )}
    </div>
  )
}
