import { createPortal } from 'react-dom'
import { classifyTmError, tmErrorText } from '../lib/tmUi'
import type { Direction, SkipNote } from '../lib/watchSync'
import { useWatchSyncStore, type SyncFailure } from '../stores/watchSync'
import { useMask } from './useMask'

export const SYNC_NOTE = 'Adds only. Nothing is removed on either side. TM notes are not touched.'

function Chips({ title, symbols }: { title: string; symbols: string[] }) {
  return (
    <details className="sync-chips">
      <summary>
        {title} <b>{symbols.length}</b>
      </summary>
      {symbols.length === 0 ? (
        <div className="muted">none</div>
      ) : (
        <div className="chips">
          {symbols.map((s) => (
            <span key={s} className="chip">
              {s}
            </span>
          ))}
        </div>
      )}
    </details>
  )
}

function Skips({ title, notes }: { title: string; notes: SkipNote[] }) {
  if (notes.length === 0) return null
  return (
    <div className="sync-skips">
      <div className="muted">{title}</div>
      <ul>
        {notes.map((n) => (
          <li key={n.symbol}>
            <span className="chip">{n.symbol}</span> {n.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

const DIRS: { value: Direction; label: string }[] = [
  { value: 'tm_to_rh', label: 'TM to Robinhood' },
  { value: 'rh_to_tm', label: 'Robinhood to TM' },
  { value: 'both', label: 'Both ways' },
]

export function WatchSyncDialog() {
  const s = useWatchSyncStore()
  const mask = useMask()
  const { select, setDirection, apply, cancel, closeDialog, refresh } = useWatchSyncStore.getState()
  const applying = s.phase === 'applying'
  const loading = s.phase === 'loading'
  const tmDown = s.tmError !== ''
  const tmSource = s.tmSel !== '' && s.tmSel !== 'new' ? s.tmLists.find((l) => String(l.id) === s.tmSel) : undefined
  const rhSource = s.rhSel !== '' && s.rhSel !== 'new' ? s.rhLists.find((l) => l.id === s.rhSel) : undefined
  const plan = s.plan
  const addToRh = plan && s.direction !== 'rh_to_tm' ? plan.onlyTm.length : 0
  const addToTm = plan && s.direction !== 'tm_to_rh' ? plan.onlyRh.length : 0
  const bothNew = s.tmSel === 'new' && s.rhSel === 'new'
  const canApply = !!plan && !applying && !loading && !bothNew && addToRh + addToTm > 0
  const skipNotes: { title: string; notes: SkipNote[] }[] = plan
    ? [
        ...(s.direction !== 'tm_to_rh' ? [{ title: 'Cannot go to TraderMatrix', notes: plan.skippedForTm }] : []),
        ...(s.direction !== 'rh_to_tm' ? [{ title: 'Cannot go to Robinhood', notes: plan.skippedForRh }] : []),
      ]
    : []
  const r = s.result
  const failText = (f: SyncFailure) => mask(f.side === 'tm' ? tmErrorText(f.error) : f.error)

  return createPortal(
    <div className="sync-overlay" onMouseDown={(e) => e.target === e.currentTarget && !applying && closeDialog()}>
      <div className="sync-dialog" role="dialog" aria-modal="true" aria-label="Sync watchlists">
        <div className="sync-head">
          <b>Sync watchlists</b>
          <span className="spacer" />
          <button onClick={() => void refresh()} disabled={applying || loading}>Refresh</button>
          <button onClick={closeDialog} disabled={applying}>Close</button>
        </div>
        <div className="sync-note" data-testid="sync-note">{SYNC_NOTE}</div>

        <div className="sync-grid">
          <label>
            TraderMatrix list
            <select aria-label="TraderMatrix list" value={s.tmSel} disabled={applying || loading || tmDown} onChange={(e) => void select('tm', e.target.value)}>
              <option value="">{tmDown ? 'unavailable' : 'Choose a list'}</option>
              {s.tmLists.map((l) => (
                <option key={l.id} value={String(l.id)}>{`${l.name} (${l.ticker_count})`}</option>
              ))}
              {!tmDown && <option value="new">+ Create new list named like the Robinhood one</option>}
            </select>
          </label>
          <label>
            Robinhood list
            <select aria-label="Robinhood list" value={s.rhSel} disabled={applying || loading || s.rhError !== ''} onChange={(e) => void select('rh', e.target.value)}>
              <option value="">{s.rhError ? 'unavailable' : 'Choose a list'}</option>
              {s.rhLists.map((l) => (
                <option key={l.id} value={l.id}>{`${l.display_name}${l.item_count !== null ? ` (${l.item_count})` : ''}`}</option>
              ))}
              {s.rhError === '' && <option value="new">+ Create new list named like the TM one</option>}
            </select>
          </label>
        </div>
        {tmDown && (
          <div className={`err kind-${classifyTmError(s.tmError)}`} role="alert" data-testid="sync-tm-error">
            {mask(tmErrorText(s.tmError))}
          </div>
        )}
        {s.rhError && <div className="err" role="alert">{mask(s.rhError)}</div>}
        {s.tmSel === 'new' && rhSource && <div className="muted">A TraderMatrix list named "{rhSource.display_name}" is created when you Apply, only if something is added to it.</div>}
        {s.rhSel === 'new' && tmSource && <div className="muted">A Robinhood list named "{tmSource.name}" is created when you Apply, only if something is added to it.</div>}

        <fieldset className="sync-dir" disabled={applying}>
          <legend>Direction</legend>
          {DIRS.map((d) => (
            <label key={d.value}>
              <input type="radio" name="sync-dir" value={d.value} checked={s.direction === d.value} onChange={() => setDirection(d.value)} /> {d.label}
            </label>
          ))}
        </fieldset>

        <div className="sync-diff" data-testid="sync-diff">
          {s.planLoading && <div className="muted">Comparing...</div>}
          {s.planError && <div className="err" role="alert">{mask(s.planError)}</div>}
          {!plan && !s.planLoading && !s.planError && <div className="muted">{tmDown ? 'Pick a Robinhood list to see it; the comparison needs TraderMatrix.' : 'Choose a list on each side to see the difference.'}</div>}
          {plan && (
            <>
              <Chips title="Only on TraderMatrix" symbols={plan.onlyTm} />
              <Chips title="Only on Robinhood" symbols={plan.onlyRh} />
              <Chips title="In both" symbols={plan.both} />
              {skipNotes.some((k) => k.notes.length > 0) && (
                <details className="sync-chips" open>
                  <summary>
                    Cannot cross over <b>{skipNotes.reduce((n, k) => n + k.notes.length, 0)}</b>
                  </summary>
                  {skipNotes.map((k) => (
                    <Skips key={k.title} title={k.title} notes={k.notes} />
                  ))}
                </details>
              )}
            </>
          )}
        </div>

        {applying && (
          <div className="sync-progress" role="status">
            {s.progress ? `Adding to ${s.progress.side === 'tm' ? 'TraderMatrix' : 'Robinhood'}: ${s.progress.done} of ${s.progress.total}` : 'Working...'}
            <button onClick={cancel} disabled={s.cancelRequested}>{s.cancelRequested ? 'Cancelling...' : 'Cancel'}</button>
            {s.progress?.side === 'tm' && <span className="muted">TraderMatrix is paced at 2 per second.</span>}
          </div>
        )}

        <div className="sync-actions">
          <button className="primary" onClick={() => void apply()} disabled={!canApply}>
            {`Apply${plan ? `: ${addToRh} to Robinhood, ${addToTm} to TraderMatrix` : ''}`}
          </button>
        </div>

        {r && (
          <div className="sync-result" data-testid="sync-result" role="status">
            {r.aborted && <div className="err" role="alert">{mask(r.aborted)} Nothing was added.</div>}
            {r.stopped && <div className="err" role="alert">{mask(r.stopped)}</div>}
            {r.cancelled && <div className="muted">Cancelled. {r.notRun} not attempted; run Apply again to continue.</div>}
            {r.created.length > 0 && <div>Created: {r.created.join(', ')}</div>}
            <div>Added to Robinhood: <b>{r.rhAdded.length}</b>{r.rhAdded.length > 0 && <span className="muted"> {r.rhAdded.join(', ')}</span>}</div>
            <div>Added to TraderMatrix: <b>{r.tmAdded.length}</b>{r.tmAdded.length > 0 && <span className="muted"> {r.tmAdded.join(', ')}</span>}</div>
            <div>Already there: <b>{r.already.length}</b>{r.already.length > 0 && <span className="muted"> {r.already.join(', ')}</span>}</div>
            <div>Failed: <b>{r.failed.length}</b></div>
            {r.failed.length > 0 && (
              <ul className="err">
                {r.failed.map((f) => (
                  <li key={`${f.side}:${f.symbol}`}>
                    {f.symbol} ({f.side === 'tm' ? 'TraderMatrix' : 'Robinhood'}): {failText(f)}
                  </li>
                ))}
              </ul>
            )}
            <div>Skipped (cannot cross over): <b>{r.skipped.length}</b></div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
