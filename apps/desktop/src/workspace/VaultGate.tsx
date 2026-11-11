import { useEffect, useState } from 'react'
import bg from '../assets/brand/bg-gold-arcs.webp'
import lockup from '../assets/brand/lockup-on-dark-800.png'
import { NOT_AFFILIATED } from '../lib/brand'
import { useBackgrounds } from '../stores/ui'
import { gateMode, useVaultStore } from '../stores/vault'

/** Blocking modal: create a passphrase when no vault exists, unlock otherwise. Passphrases live only in component state. */
export function VaultGate() {
  const { status, busy, error, refresh, create, unlock } = useVaultStore()
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const art = useBackgrounds()

  useEffect(() => {
    void refresh()
  }, [refresh])

  const mode = gateMode(status)
  if (mode === 'hidden') return null

  const submit = async () => {
    const ok = mode === 'create' ? await create(pass, confirm) : await unlock(pass)
    if (ok) {
      setPass('')
      setConfirm('')
    }
  }

  return (
    <div
      className={`vault-gate${art ? ' with-art' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Secret vault"
      style={art ? { backgroundImage: `linear-gradient(90deg, rgba(7,14,31,0.94) 0%, rgba(7,14,31,0.72) 55%, rgba(7,14,31,0.55) 100%), url(${bg})` } : undefined}
    >
      <form
        className="vault-card"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <img className="vault-lockup" src={lockup} alt="TraderMatrix Desktop" />
        <h2>{mode === 'create' ? 'Create vault passphrase' : 'Unlock vault'}</h2>
        <p>
          {mode === 'create'
            ? 'No OS keyring was found. Broker tokens are kept in an encrypted file. Minimum 8 characters. There is no recovery if you lose it.'
            : 'Enter the vault passphrase to load saved credentials.'}
        </p>
        <input
          autoFocus
          type="password"
          autoComplete="off"
          value={pass}
          placeholder="Passphrase"
          onChange={(e) => setPass(e.target.value)}
        />
        {mode === 'create' && (
          <input
            type="password"
            autoComplete="off"
            value={confirm}
            placeholder="Confirm passphrase"
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
        {error && <div className="err">{error}</div>}
        <button type="submit" disabled={busy || !pass}>
          {busy ? 'Working...' : mode === 'create' ? 'Create vault' : 'Unlock'}
        </button>
      </form>
      <div className="vault-footer small muted">{NOT_AFFILIATED}</div>
    </div>
  )
}
