import { bottomCollapsed, toggleBottomPanel, toggleChartFocus } from './defaultLayout'
import type { DockviewApi } from 'dockview-react'
import { useEffect, useRef, useState } from 'react'
import { api, type BackendStatus } from '../lib/api'
import { planToolbar, resolveDensity } from '../lib/layoutBudget'
import { useUiStore } from '../stores/ui'
import { useVaultStore } from '../stores/vault'
import { secretsPill } from '../lib/format'
import { AboutDialog } from './AboutDialog'
import { BrandMark } from './BrandMark'
import { ConnectButton } from './ConnectButton'
import { PanelsMenu } from './PanelsMenu'
import { useMask } from './useMask'
import { TmKeyPanel } from './TmKeyPanel'
import { useElWidth } from './useElWidth'
import { useLayoutStore } from './layoutStore'

/** Closes a popover on an outside click. */
function useOutside(open: boolean, close: () => void) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [open, close])
  return box
}

/**
 * M22: one row, never overlapping. What stays and what collapses is `planToolbar(width)`: the Robinhood scope note and the wordmark text go
 * first, the TM pills become dots, then the least important buttons move into the "..." menu. Layout management lives in one "Layouts" menu.
 */
export function Toolbar({ dock }: { dock: DockviewApi | null }) {
  const { layouts, active, saveAs, load, remove, reset } = useLayoutStore()
  const [selected, setSelected] = useState('')
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')
  const [status, setStatus] = useState<BackendStatus | null>(null)
  const [layoutsOpen, setLayoutsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [, bump] = useState(0)
  const vault = useVaultStore((s) => s.status)
  const lockVault = useVaultStore((s) => s.lock)
  const vaultUnlocked = vault?.unlocked ?? false
  const savedDensity = useUiStore((s) => s.density)
  const root = useRef<HTMLDivElement>(null)
  const width = useElWidth(root)
  const plan = planToolbar(width > 0 ? width : Number.POSITIVE_INFINITY)
  const layoutsBox = useOutside(layoutsOpen, () => setLayoutsOpen(false))
  const moreBox = useOutside(moreOpen, () => setMoreOpen(false))

  useEffect(() => {
    api.secretBackendStatus().then(setStatus).catch((e) => setStatus({ available: false, backend: 'unknown', detail: String(e) }))
  }, [vaultUnlocked])
  useEffect(() => {
    void useUiStore.getState().load()
  }, [])

  const run = (p: Promise<unknown>) => {
    setErr('')
    p.catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }

  const mask = useMask()
  const target = selected || active
  const pill = secretsPill(status, vault)
  const density = resolveDensity(savedDensity, width > 0 ? width : typeof window === 'undefined' ? 1536 : window.innerWidth)
  const flipDensity = () => void useUiStore.getState().setDensity(density === 'compact' ? 'comfortable' : 'compact')
  const collapsed = dock ? bottomCollapsed(dock) : false
  const flipBottom = () => {
    if (dock) toggleBottomPanel(dock)
    bump((n) => n + 1)
  }
  const inMenu = (id: (typeof plan.overflow)[number]) => plan.overflow.includes(id)

  const secretsPillEl = (
    <span className={`pill ${pill.cls}`} title={pill.title}>
      <span className="pill-text">{pill.text}</span>
    </span>
  )
  const lockBtn =
    vault?.backend === 'vault' && vault.unlocked ? (
      <button onClick={() => void lockVault()} title="Lock the secret vault">
        Lock vault
      </button>
    ) : null
  const densityBtn = (
    <button onClick={flipDensity} title="Compact packs more chart into the window; Comfortable gives the rows more air. Saved as ui.density" aria-pressed={density === 'compact'}>
      {density === 'compact' ? 'Compact' : 'Comfortable'}
    </button>
  )
  const bottomBtn = (
    <button disabled={!dock} onClick={flipBottom} title="Collapse or expand the Positions / Orders / Alerts group (one click)" aria-pressed={collapsed}>
      {collapsed ? 'Show bottom' : 'Hide bottom'}
    </button>
  )

  return (
    <div className={`toolbar${plan.tmDots ? ' pills-dots' : ''}`} ref={root} data-testid="toolbar">
      <BrandMark text={plan.brandText} />
      <div className="layouts-wrap" ref={layoutsBox}>
        <button aria-expanded={layoutsOpen} onClick={() => setLayoutsOpen((o) => !o)} title="Save, load, delete or reset layouts">
          Layouts ▾
        </button>
        {layoutsOpen && (
          <div className="layouts-pop" role="menu" aria-label="Layouts">
            <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Layouts">
              <option value="">{layouts.length ? 'Choose a layout...' : 'No saved layouts'}</option>
              {layouts.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
            <div className="layouts-row">
              <button disabled={!dock || !target} onClick={() => dock && run(load(target, dock).then(() => setLayoutsOpen(false)))}>
                Load
              </button>
              <button disabled={!target} onClick={() => run(remove(target).then(() => setSelected('')))}>
                Delete
              </button>
              <button disabled={!dock} onClick={() => dock && (reset(dock), setLayoutsOpen(false))}>
                Reset layout
              </button>
            </div>
            {naming ? (
              <div className="layouts-row">
                <input
                  autoFocus
                  value={draft}
                  maxLength={64}
                  placeholder="Layout name"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setNaming(false)
                    if (e.key === 'Enter' && dock) {
                      run(saveAs(draft, JSON.stringify(dock.toJSON())).then(() => setNaming(false)))
                    }
                  }}
                />
                <button onClick={() => setNaming(false)}>Cancel</button>
              </div>
            ) : (
              <button disabled={!dock} onClick={() => (setDraft(''), setNaming(true))}>
                Save as...
              </button>
            )}
          </div>
        )}
      </div>
      <button disabled={!dock} onClick={() => dock && toggleChartFocus(dock)} title="Maximize the chart (click again to restore the layout)">
        Focus chart
      </button>
      <PanelsMenu dock={dock} />
      {!inMenu('bottom') && bottomBtn}
      {!inMenu('density') && densityBtn}
      {err && <span className="err toolbar-err" title={mask(err)}>{mask(err)}</span>}
      <span className="spacer" />
      {!inMenu('lock') && lockBtn}
      <TmKeyPanel />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} showButton={!inMenu('about')} />
      <ConnectButton showScope={plan.scope} />
      {!inMenu('secrets') && secretsPillEl}
      {plan.overflow.length > 0 && (
        <div className="more-wrap" ref={moreBox}>
          <button aria-expanded={moreOpen} aria-label="More toolbar items" title="More" onClick={() => setMoreOpen((o) => !o)}>
            ...
          </button>
          {moreOpen && (
            <div className="more-pop" role="menu" aria-label="More">
              {inMenu('secrets') && secretsPillEl}
              {inMenu('about') && (
                <button onClick={() => (setAboutOpen(true), setMoreOpen(false))} title="About TraderMatrix Desktop">
                  About
                </button>
              )}
              {inMenu('density') && densityBtn}
              {inMenu('lock') && lockBtn}
              {inMenu('bottom') && bottomBtn}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
