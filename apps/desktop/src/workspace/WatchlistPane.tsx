import { useEffect, useState } from 'react'
import { isOptionsList } from '../lib/api'
import { fmtNum, fmtPct, fmtPrice, pnlClass } from '../lib/format'
import { fillDisabledReason } from '../lib/ticketUi'
import { fillTicket } from '../stores/ticketIntent'
import { parseWatchSymbols, validateEmoji, validateListName, watchlistWritable } from '../lib/watchRules'
import { connectState, useRhStore } from '../stores/rh'
import { useTmStore } from '../stores/tm'
import { useWatchSyncStore } from '../stores/watchSync'
import { tmPill } from '../lib/tmUi'
import { useMask } from './useMask'
import { WatchSyncDialog } from './WatchSyncDialog'

export function WatchlistPane() {
  const { status, connecting, connectError, accounts, account, watchlists, listId, listSymbols, optionItems, watchError, watchBusy, watchNote, quotes, quoteError, quotesTruncated } = useRhStore()
  const { selectList, loadWatchlists, watchQuotes, setChartSymbol, addSymbols, removeSymbol, createList, renameList } = useRhStore.getState()
  const current = watchlists.find((w) => w.id === listId)
  const isOptions = isOptionsList(current)
  const writable = watchlistWritable(current)
  const [adding, setAdding] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newEmoji, setNewEmoji] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameTo, setRenameTo] = useState('')
  const addCheck = parseWatchSymbols(adding)
  const createCheck = validateListName(newName) || validateEmoji(newEmoji)
  const renameCheck = validateListName(renameTo)
  const state = connectState({ status, connecting, connectError })
  const mask = useMask()
  const fillReason = fillDisabledReason(state === 'connected', accounts, account)
  const tmStatus = useTmStore((x) => x.status)
  const syncOpen = useWatchSyncStore((x) => x.open)
  const pill = tmPill(tmStatus)

  useEffect(() => {
    void useTmStore.getState().refreshStatus()
  }, [])

  const key = listSymbols.join(',')
  useEffect(() => {
    watchQuotes('watchlist', listSymbols)
    return () => watchQuotes('watchlist', [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, watchQuotes])

  if (state !== 'connected') return <div className="pane-empty">Connect Robinhood to see watchlists.</div>

  return (
    <div className="pane">
      {syncOpen && <WatchSyncDialog />}
      <div className="pane-head">
        <select aria-label="Watchlist" value={listId ?? ''} onChange={(e) => void selectList(e.target.value)}>
          {watchlists.map((w) => (
            <option key={w.id} value={w.id}>
              {`${w.display_name}${isOptionsList(w) ? ' (options)' : ''}`}
            </option>
          ))}
        </select>
        <button onClick={() => void loadWatchlists()} disabled={watchBusy}>Refresh</button>
        <button onClick={() => { setCreating(true); setRenaming(false) }} disabled={watchBusy || creating}>New list</button>
        <button onClick={() => void useWatchSyncStore.getState().openDialog()} title="Compare with a TraderMatrix watchlist and add what is missing (adds only)">
          Sync <span className={`sync-badge ${pill.cls}`} title={pill.title}>TM</span>
        </button>
        {writable && (
          <button onClick={() => { setRenaming(true); setCreating(false); setRenameTo(current?.display_name ?? '') }} disabled={watchBusy || renaming}>Rename</button>
        )}
        {quoteError && !isOptions && <span className="err">{mask(quoteError)}</span>}
      </div>
      {creating && (
        <form
          className="pane-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (createCheck) return
            void createList(newName, newEmoji).then((ok) => {
              if (ok) { setCreating(false); setNewName(''); setNewEmoji('') }
            })
          }}
        >
          <input aria-label="New list name" placeholder="List name" value={newName} maxLength={60} autoFocus onChange={(e) => setNewName(e.target.value)} />
          <input aria-label="List emoji" className="emoji" placeholder="Emoji" value={newEmoji} onChange={(e) => setNewEmoji(e.target.value)} />
          <button type="submit" disabled={watchBusy || newName.trim() === '' || !!createCheck}>Create</button>
          <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          {newName.trim() !== '' && createCheck && <span className="err">{createCheck}</span>}
        </form>
      )}
      {renaming && writable && (
        <form
          className="pane-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (renameCheck) return
            void renameList(renameTo).then((ok) => {
              if (ok) setRenaming(false)
            })
          }}
        >
          <input aria-label="New name for this list" value={renameTo} maxLength={60} autoFocus onChange={(e) => setRenameTo(e.target.value)} />
          <button type="submit" disabled={watchBusy || !!renameCheck}>Save</button>
          <button type="button" onClick={() => setRenaming(false)}>Cancel</button>
          {renameCheck && <span className="err">{renameCheck}</span>}
        </form>
      )}
      {writable && !isOptions && (
        <form
          className="pane-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (addCheck.error || addCheck.symbols.length === 0) return
            void addSymbols(adding).then((ok) => {
              if (ok) setAdding('')
            })
          }}
        >
          <input
            aria-label="Add symbols"
            placeholder="Add symbols, then Enter (AAPL, MSFT)"
            value={adding}
            disabled={watchBusy}
            onChange={(e) => setAdding(e.target.value)}
          />
          <button type="submit" disabled={watchBusy || !!addCheck.error || addCheck.symbols.length === 0}>{watchBusy ? 'Saving...' : 'Add'}</button>
          {addCheck.error && <span className="err">{addCheck.error}</span>}
        </form>
      )}
      {watchError && <div className="err" role="alert">{mask(watchError)}</div>}
      {watchNote && !watchError && <div className="muted">{mask(watchNote)}</div>}
      {quotesTruncated && <div className="quotes-note" data-testid="quotes-truncated">Quotes truncated: only the first 200 symbols (ticket, positions, chart, then watchlist) are quoted.</div>}
      {!isOptions && !writable && current && <div className="muted">Read-only: this is a Robinhood list you follow.</div>}
      {isOptions ? (
        <>
          <div className="muted">Options watchlist: contracts only (no live quotes yet)</div>
          {optionItems.length === 0 ? (
            !watchError && <div className="pane-empty">This watchlist has no contracts.</div>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Underlying</th>
                  <th>Expiry</th>
                  <th className="num">Strike</th>
                  <th>Call/Put</th>
                </tr>
              </thead>
              <tbody>
                {optionItems.map((o) => (
                  <tr key={o.id}>
                    <td>{o.name || '-'}</td>
                    <td>{o.chain_symbol || '-'}</td>
                    <td>{o.expiration_date ?? '-'}</td>
                    <td className="num">{fmtNum(o.strike_price)}</td>
                    <td>{o.contract_type ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : listSymbols.length === 0 && !watchError ? (
        <div className="pane-empty">{watchlists.length === 0 ? 'No watchlists.' : 'This watchlist has no stocks.'}</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">Last</th>
              <th className="num">Chg %</th>
              <th />
              {writable && <th />}
            </tr>
          </thead>
          <tbody>
            {listSymbols.map((s) => {
              const q = quotes[s]
              const last = q?.last_trade_price ?? null
              const prev = q?.previous_close ?? null
              const chg = last !== null && prev !== null && prev > 0 ? ((last - prev) / prev) * 100 : null
              return (
                <tr
                  key={s}
                  className="clickable"
                  onClick={() => {
                    setChartSymbol(s)
                    if (!fillReason) fillTicket({ kind: 'equity', symbol: s, source: 'watchlist-row' })
                  }}
                  title="Show on chart and set the ticket symbol"
                >
                  <td>{s}</td>
                  <td className="num">{fmtPrice(last)}</td>
                  <td className={`num ${pnlClass(chg)}`}>{fmtPct(chg)}</td>
                  <td className="row-acts">
                    {(['buy', 'sell'] as const).map((side) => (
                      <button
                        key={side}
                        className="qb"
                        aria-label={`${side === 'buy' ? 'Buy' : 'Sell'} ${s}`}
                        disabled={!!fillReason}
                        title={fillReason ?? `Fill the ticket with ${side} ${s} (you still review and place)`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setChartSymbol(s)
                          fillTicket({ kind: 'equity', symbol: s, side, source: 'watchlist-quick' })
                        }}
                      >
                        {side === 'buy' ? 'B' : 'S'}
                      </button>
                    ))}
                  </td>
                  {writable && (
                    <td className="num">
                      <button
                        className="row-x"
                        aria-label={`Remove ${s}`}
                        title={`Remove ${s} from this list`}
                        disabled={watchBusy}
                        onClick={(e) => {
                          e.stopPropagation()
                          void removeSymbol(s)
                        }}
                      >
                        {'\u00d7'}
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
