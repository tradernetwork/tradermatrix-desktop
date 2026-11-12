import { useEffect, useRef, useState } from 'react'
import { tmPill, validateTmKey } from '../lib/tmUi'
import { parseBudgetInput } from '../lib/tmQuota'
import { TmQuotaChip } from './TmQuotaChip'
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
  const quota = useTmStore((s) => s.quota)
  const [perMin, setPerMin] = useState('')
  const [perDay, setPerDay] = useState('')
  const [budgetMsg, setBudgetMsg] = useState<{ ok: boolean; text: string } | null>(null)
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

  // the budget fields start from what the core is using each time the popover opens
  useEffect(() => {
    if (!open) return
    void useTmStore.getState().refreshQuota()
    setBudgetMsg(null)
  }, [open])
  const perMinNow = quota?.per_min
  const perDayNow = quota?.per_day
  useEffect(() => {
    if (!open) return
    if (perMinNow !== undefined) setPerMin(String(perMinNow))
    if (perDayNow !== undefined) setPerDay(String(perDayNow))
  }, [open, perMinNow, perDayNow])

  const saveBudgets = async () => {
    const p = parseBudgetInput(perMin, perDay)
    if (!p.ok) {
      setBudgetMsg({ ok: false, text: p.error })
      return
    }
    const e = await useTmStore.getState().saveBudgets(p.perMin, p.perDay)
    setBudgetMsg(e ? { ok: false, text: e } : { ok: true, text: `Saved: ${p.perMin} per minute, ${p.perDay} per day.` })
  }

  // Enter in a budget field saves the budgets, never the key form
  const budgetEnter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void saveBudgets()
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
        <span className="pill-text">{pill.text}</span>
      </span>
      <TmQuotaChip />
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
          <div className="tm-budgets" aria-label="TraderMatrix call budgets">
            <b>Call budgets</b>
            <div className="tm-pop-row">
              <label>
                Per minute (1 to 12)
                <input value={perMin} inputMode="numeric" aria-label="TM calls per minute" onChange={(e) => setPerMin(e.target.value)} onKeyDown={(e) => budgetEnter(e)} />
              </label>
              <label>
                Per day
                <input value={perDay} inputMode="numeric" aria-label="TM calls per day" onChange={(e) => setPerDay(e.target.value)} onKeyDown={(e) => budgetEnter(e)} />
              </label>
            </div>
            <div className="tm-pop-row">
              <button type="button" onClick={() => void saveBudgets()}>
                Save budgets
              </button>
            </div>
            {budgetMsg && (
              <div className={budgetMsg.ok ? 'note' : 'err'} role={budgetMsg.ok ? 'status' : 'alert'}>
                {budgetMsg.text}
              </div>
            )}
            <div className="muted small">
              TraderMatrix allows 12 calls a minute on every plan and 200 a day on Premium (25 on the free preview). This app runs under the same limits and learns TM's own
              messages ("Daily limit reached", "Slow down"). Cached reads cost nothing. The day rolls over at 00:00 UTC (not yet verified against TM).
            </div>
          </div>
        </form>
      )}
    </span>
  )
}
