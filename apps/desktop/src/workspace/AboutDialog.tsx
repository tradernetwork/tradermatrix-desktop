import { useEffect, useState } from 'react'
import lockup from '../assets/brand/lockup-on-dark-800.png'
import { APP_VERSION, NOT_AFFILIATED, PRODUCT_NAME } from '../lib/brand'
import { useUiStore } from '../stores/ui'

/** About: name, version, license pointers, the not-affiliated line, and the background-art switch. Opens from the toolbar. */
export function AboutDialog() {
  const [open, setOpen] = useState(false)
  const backgrounds = useUiStore((s) => s.backgrounds)
  useEffect(() => {
    if (!open) return
    void useUiStore.getState().load()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={`About ${PRODUCT_NAME}`}>
        About
      </button>
      {open && (
        <div className="about-backdrop" onClick={() => setOpen(false)}>
          <div className="about-card" role="dialog" aria-modal="true" aria-label={`About ${PRODUCT_NAME}`} onClick={(e) => e.stopPropagation()}>
            <img className="about-lockup" src={lockup} alt="TraderMatrix" />
            <h2>
              {PRODUCT_NAME} <span className="muted small">v{APP_VERSION}</span>
            </h2>
            <p>{NOT_AFFILIATED}</p>
            <p className="small">
              Code: MIT (LICENSE). TraderMatrix name, marks and artwork under apps/desktop/src/assets/brand/ are (c) TraderMatrix, all rights reserved, and are not
              covered by the MIT license (LICENSE-BRAND.txt, NOTICE). Third-party software and fonts: THIRD_PARTY_LICENSES.md and NOTICE in the source repository.
            </p>
            <p className="small muted">Not financial advice. This software can send real orders to a real brokerage account when you tell it to.</p>
            <label className="small">
              <input type="checkbox" checked={backgrounds} onChange={(e) => void useUiStore.getState().setBackgrounds(e.target.checked)} /> Show background art on the unlock
              screen and empty panes
            </label>
            <button type="button" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}
