import { useEffect, useRef, useState } from 'react'
import { tmPill, validateTmKey } from '../lib/tmUi'
import { useTmStore } from '../stores/tm'
import { useVaultStore } from '../stores/vault'

/**
 * Toolbar control for the TraderMatrix API key. The key lives only in the password input's DOM value while the user types:
 * it is cleared the moment Save is pressed, handed to the secret store (vault must be unlocked) and never rendered,
 * kept in a store, persisted or logged. Only the presence pill is shown afterwards.
 */
export function TmKeyPanel() {
  const status = useTmStore((s) => s.status)
  const busy = useTmStore((s) => s.keyBusy)
  const vaultUnlocked = useVaultStore((s) => s.status?.unlocked)
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void useTmStore.getState().refreshStatus()
  }, [vaultUnlocked])

  const pill = tmPill(status)

  const save = async () => {
    const el = inputRef.current
    if (!el) return
    const bad = validateTmKey(el.value)
    if (bad) {
      setErr(bad)
      setNote('')
      return
    }
    const value = el.value
    el.value = '' // cleared before anything else happens, success or not
    setErr('')
    const e = await useTmStore.getState().saveKey(value)
    if (e) {
      setErr(e)
      setNote('')
    } else {
      setNote('Key saved (hidden)')
    }
  }

  const remove = async () => {
    const e = await useTmStore.getState().removeKey()
    setErr(e)
    setNote(e ? '' : 'Key removed')
  }

  return (
    <span className="tm-key-wrap">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} title="TraderMatrix API key (stored in the secret vault)">
        TM key
      </button>
      <span className={`pill ${pill.cls}`} title={pill.title}>
        {pill.text}
      </span>
      {open && (
        <form
          className="tm-pop"
          aria-label="TraderMatrix key"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label>
            API key
            <input ref={inputRef} type="password" autoComplete="off" spellCheck={false} placeholder="paste key (hidden)" aria-label="TraderMatrix API key" />
          </label>
          <div className="tm-pop-row">
            <button type="submit" disabled={busy}>
              Save
            </button>
            <button type="button" onClick={() => void remove()} disabled={busy || !status?.key_present}>
              Remove key
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {note && <div className="note">{note}</div>}
          {err && <div className="err" role="alert">{err}</div>}
          <div className="muted small">Read-only analytics. The key is written to the secret vault, then hidden for good; it is never shown again.</div>
        </form>
      )}
    </span>
  )
}
