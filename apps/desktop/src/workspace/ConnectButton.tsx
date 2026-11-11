import { useEffect } from 'react'
import { gateMode, useVaultStore } from '../stores/vault'
import { connectState, useRhStore } from '../stores/rh'
import { disconnectSession } from '../stores/session'
import { useMask } from './useMask'

/** Robinhood connect control. States: Disconnected, Connecting (browser opened), Connected, Error. */
export function ConnectButton() {
  const { status, connecting, connectError, connect, refreshStatus, captureNote, loginLinkNote, loginLinkFallback } = useRhStore()
  const mask = useMask()
  const vault = useVaultStore((s) => s.status)
  const locked = gateMode(vault) !== 'hidden'
  const state = connectState({ status, connecting, connectError })

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus, vault?.unlocked])

  // Credentials may already be stored from a previous session: load the data once we know we are connected.
  const connected = status?.connected ?? false
  const accountsLoaded = useRhStore((s) => s.accounts.length > 0)
  useEffect(() => {
    if (connected && !accountsLoaded) {
      void useRhStore.getState().loadAccounts()
      void useRhStore.getState().loadWatchlists()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  if (state === 'connected') {
    return (
      <>
        <span className="pill ok" title={status?.expires_soon ? 'token refreshes automatically' : 'Robinhood credentials stored'}>
          Robinhood: connected
        </span>
        <button onClick={() => void useRhStore.getState().captureTools()} title="Save Robinhood's tool list (no secrets) to the app data folder">
          Save tool list
        </button>
        {captureNote && <span className="note" title={captureNote}>{captureNote.length > 60 ? captureNote.slice(0, 60) + '...' : captureNote}</span>}
        <button onClick={() => void disconnectSession()} title="Delete the stored Robinhood credentials from this machine">
          Disconnect
        </button>
      </>
    )
  }
  if (state === 'connecting') {
    return (
      <>
        <button disabled title="Finish the login in your browser">
          Connecting... (browser opened)
        </button>
        <button onClick={() => void useRhStore.getState().copyLoginLink()} title="Browser did not open or the wrong one did? Copy the login link and paste it into any browser">
          Copy login link
        </button>
        {loginLinkNote && <span className="note" title={loginLinkNote}>{loginLinkNote}</span>}
        {loginLinkFallback && <input className="link-fallback" readOnly value={loginLinkFallback} onFocus={(e) => e.currentTarget.select()} aria-label="Login link" />}
      </>
    )
  }
  return (
    <>
      <button onClick={() => void connect()} disabled={locked} title={locked ? 'Unlock the vault first' : 'Log in to Robinhood in your browser'}>
        {state === 'error' ? 'Retry Robinhood' : 'Connect Robinhood'}
      </button>
      {state === 'error' && (
        <span className="err" title={mask(connectError)}>
          {mask(connectError).length > 70 ? mask(connectError).slice(0, 70) + '...' : mask(connectError)}
        </span>
      )}
    </>
  )
}
