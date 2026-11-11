import { toggleChartFocus } from './defaultLayout'
import type { DockviewApi } from 'dockview-react'
import { useEffect, useState } from 'react'
import { api, type BackendStatus } from '../lib/api'
import { useVaultStore } from '../stores/vault'
import { secretsPill } from '../lib/format'
import { AboutDialog } from './AboutDialog'
import { BrandMark } from './BrandMark'
import { ConnectButton } from './ConnectButton'
import { PanelsMenu } from './PanelsMenu'
import { useMask } from './useMask'
import { TmKeyPanel } from './TmKeyPanel'
import { useLayoutStore } from './layoutStore'

export function Toolbar({ dock }: { dock: DockviewApi | null }) {
  const { layouts, active, saveAs, load, remove, reset } = useLayoutStore()
  const [selected, setSelected] = useState('')
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')
  const [status, setStatus] = useState<BackendStatus | null>(null)
  const vault = useVaultStore((s) => s.status)
  const lockVault = useVaultStore((s) => s.lock)
  const vaultUnlocked = vault?.unlocked ?? false

  useEffect(() => {
    api.secretBackendStatus().then(setStatus).catch((e) => setStatus({ available: false, backend: 'unknown', detail: String(e) }))
  }, [vaultUnlocked])

  const run = (p: Promise<unknown>) => {
    setErr('')
    p.catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }

  const mask = useMask()
  const target = selected || active
  const pill = secretsPill(status, vault)

  return (
    <div className="toolbar">
      <BrandMark />
      <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Layouts">
        <option value="">{layouts.length ? 'Layouts...' : 'No saved layouts'}</option>
        {layouts.map((l) => (
          <option key={l.name} value={l.name}>
            {l.name}
          </option>
        ))}
      </select>
      <button disabled={!dock || !target} onClick={() => dock && run(load(target, dock))}>
        Load
      </button>
      {naming ? (
        <>
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
        </>
      ) : (
        <button disabled={!dock} onClick={() => (setDraft(''), setNaming(true))}>
          Save as...
        </button>
      )}
      <button disabled={!target} onClick={() => run(remove(target).then(() => setSelected('')))}>
        Delete
      </button>
      <button disabled={!dock} onClick={() => dock && reset(dock)}>
        Reset layout
      </button>
      <button disabled={!dock} onClick={() => dock && toggleChartFocus(dock)} title="Maximize the chart (click again to restore the layout)">
        Focus chart
      </button>
      <PanelsMenu dock={dock} />
      {err && <span className="err">{mask(err)}</span>}
      <span className="spacer" />
      {vault?.backend === 'vault' && vault.unlocked && (
        <button onClick={() => void lockVault()} title="Lock the secret vault">
          Lock vault
        </button>
      )}
      <TmKeyPanel />
      <AboutDialog />
      <ConnectButton />
      <span className={`pill ${pill.cls}`} title={pill.title}>
        {pill.text}
      </span>
    </div>
  )
}
