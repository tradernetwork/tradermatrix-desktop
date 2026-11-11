import { DockviewReact, type DockviewReadyEvent, type DockviewApi, type IDockviewPanelProps } from 'dockview-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { setActiveDock } from './activeDock'
import { startAlertFeeds } from '../stores/alertFeeds'
import { AlertToast } from './AlertToast'
import { AskAboutMenu } from './AskAboutMenu'
import { AUTOSAVE_NAME } from './defaultLayout'
import { DeskHeader } from './DeskHeader'
import { ErrorBoundary } from './ErrorBoundary'
import { FakeBanner } from './FakeBanner'
import { useAlertsStore } from '../stores/alerts'
import { flushAutosave, useLayoutStore } from './layoutStore'
import { PANELS, type PanelId } from './panels'
import { Toolbar } from './Toolbar'
import { VaultGate } from './VaultGate'

const components = Object.fromEntries(
  (Object.keys(PANELS) as PanelId[]).map((id) => [id, PANELS[id].component as React.FunctionComponent<IDockviewPanelProps>]),
)

export function Workspace() {
  const [dock, setDock] = useState<DockviewApi | null>(null)
  const dispose = useRef<(() => void) | null>(null)
  const { load, autosave, refresh } = useLayoutStore.getState()

  const onReady = useCallback(
    (e: DockviewReadyEvent) => {
      const a = e.api
      setDock(a)
      setActiveDock(a)
      void load(AUTOSAVE_NAME, a).then(() => {
        const sub = a.onDidLayoutChange(() => autosave(JSON.stringify(a.toJSON())))
        dispose.current = () => sub.dispose()
      })
      void refresh().catch(() => undefined)
    },
    [load, autosave, refresh],
  )

  useEffect(() => () => dispose.current?.(), [])
  // stored alerts are local data: load them at start so they are watched even when the Alerts pane is not open
  useEffect(() => {
    void useAlertsStore.getState().load()
    return startAlertFeeds()
  }, [])

  // the autosave is debounced: write a pending one when the window is closing or goes to the background
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushAutosave()
    }
    window.addEventListener('beforeunload', flushAutosave)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', flushAutosave)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [])

  return (
    <div className="app">
      <FakeBanner />
      <ErrorBoundary label="Toolbar">
        <VaultGate />
        <Toolbar dock={dock} />
      </ErrorBoundary>
      <ErrorBoundary label="Desk header">
        <DeskHeader />
      </ErrorBoundary>
      <div className="workspace">
        <DockviewReact className="dockview-theme-dark" components={components} onReady={onReady} />
      </div>
      <AskAboutMenu />
      <AlertToast />
    </div>
  )
}
