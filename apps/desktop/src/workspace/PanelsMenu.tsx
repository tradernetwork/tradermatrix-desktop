import type { DockviewApi } from 'dockview-react'
import { useEffect, useRef, useState } from 'react'
import { PANEL_IDS, PANEL_TITLES } from './panelIds'
import { addPanelById } from './restoreLayout'

/** Re-opens a closed panel (or focuses an open one). The open set is read when the menu opens. */
export function PanelsMenu({ dock }: { dock: DockviewApi | null }) {
  const [open, setOpen] = useState(false)
  const [, bump] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [open])

  const openIds = dock ? dock.panels.map((p) => p.id) : []
  return (
    <div className="panels-wrap" ref={box}>
      <button disabled={!dock} aria-expanded={open} onClick={() => setOpen(!open)}>
        Panels
      </button>
      {open && dock && (
        <div className="panels-menu" role="menu" aria-label="Panels">
          {PANEL_IDS.map((id) => {
            const isOpen = openIds.includes(id)
            return (
              <div className="row" key={id}>
                <span className={isOpen ? '' : 'muted'}>{PANEL_TITLES[id]}</span>
                <button
                  onClick={() => {
                    if (isOpen) dock.getPanel(id)?.api.setActive()
                    else addPanelById(dock, id, true)
                    bump((n) => n + 1)
                  }}
                >
                  {isOpen ? 'Show' : 'Open'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
