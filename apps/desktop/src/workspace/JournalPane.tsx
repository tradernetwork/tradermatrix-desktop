import { useEffect, useMemo } from 'react'
import { PNL_SPANS } from '../lib/api'
import { accountLabel, fmtPrice, fmtQty } from '../lib/format'
import { fmtSignedMoney, notesByTradeKey, pnlTone, SPAN_LABELS, whenShort } from '../lib/journalUi'
import { isEquityTicker } from '../lib/symbols'
import { fillDisabledReason } from '../lib/ticketUi'
import { useJournalStore } from '../stores/journal'
import { askAbout } from '../stores/explainFocus'
import { fillTicket } from '../stores/ticketIntent'
import { connectState, useRhStore } from '../stores/rh'
import { NotesFeed, TradeNotes } from './JournalNotes'
import { PnlSummary } from './PnlSummary'
import { useMask } from './useMask'
import { EmptyState } from './EmptyState'

/** Realized P&L and closed trades from Robinhood, plus your own notes (local SQLite). Click a trade to attach a note. */
export function JournalPane() {
  const { status, connecting, connectError, accounts, account } = useRhStore()
  const { selectAccount } = useRhStore.getState()
  const { span, pnl, trades, tradesCursor, pnlLoading, pnlError, notes, selectedKey, exportNote, exportError } = useJournalStore()
  const { setSpan, loadPnl, loadMoreTrades, loadNotes, selectTrade, exportCsv } = useJournalStore.getState()
  const connected = connectState({ status, connecting, connectError }) === 'connected'
  const mask = useMask()
  const fillReason = fillDisabledReason(connected, accounts, account)

  useEffect(() => {
    void loadNotes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // NOT keyed on span: setSpan() already reads the new span, a second effect-driven load would fetch twice
  useEffect(() => {
    if (connected && account) void loadPnl()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, account])

  const linked = useMemo(() => notesByTradeKey(notes), [notes])

  return (
    <div className="pane journal">
      <div className="pane-head">
        {connected && (
          <select aria-label="Account" value={account ?? ''} onChange={(e) => void selectAccount(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.account_number} value={a.account_number}>
                {accountLabel(a)}
              </option>
            ))}
          </select>
        )}
        <div className="seg" role="group" aria-label="Span">
          {PNL_SPANS.map((s) => (
            <button key={s} className={s === span ? 'on' : ''} aria-pressed={s === span} onClick={() => void setSpan(s)}>
              {SPAN_LABELS[s]}
            </button>
          ))}
        </div>
        <button onClick={() => void loadPnl()} disabled={!connected || pnlLoading}>{pnlLoading ? 'Loading...' : 'Refresh'}</button>
        <button onClick={() => void exportCsv()} disabled={!connected} title="Trades and notes for this span, saved under the app data folder">Export CSV</button>
        {exportError && <span className="err">{mask(exportError)}</span>}
      </div>
      {exportNote && <div className="muted" title={exportNote}>{exportNote}</div>}

      {connected ? (
        <>
          <PnlSummary pnl={pnl} loading={pnlLoading} error={pnlError} />
          {trades.length === 0 && !pnlLoading && !pnlError ? (
            <EmptyState>No closed trades in this window.</EmptyState>
          ) : (
            trades.length > 0 && (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th className="num">Qty</th>
                    <th className="num">Price</th>
                    <th className="num">Realized</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.flatMap((t) => {
                    const ns = linked.get(t.trade_key) ?? []
                    const open = selectedKey === t.trade_key
                    const row = (
                      <tr key={t.trade_key} className={`clickable${open ? ' sel' : ''}`} onClick={() => selectTrade(t.trade_key)} title="Add or view notes for this trade. Right click: ask Arya about the trade (the numbers only, never your notes)." onContextMenu={(e) => { e.preventDefault(); askAbout({ kind: 'trade', trade: { symbol: t.symbol, side: t.side, qty: t.quantity, price: t.price, pnl: t.realized_gain, timestamp: t.timestamp } }, { x: e.clientX, y: e.clientY }) }}>
                        <td>{whenShort(t.timestamp)}</td>
                        <td>
                          {t.symbol && isEquityTicker(t.symbol) ? (
                            <button
                              className="sym-link"
                              title={`Show ${t.symbol} on the chart and set the ticket symbol`}
                              onClick={(e) => {
                                e.stopPropagation()
                                useRhStore.getState().setChartSymbol(t.symbol)
                                if (!fillReason) fillTicket({ kind: 'equity', symbol: t.symbol, source: 'journal-trade' })
                              }}
                            >
                              {t.symbol}
                            </button>
                          ) : (
                            t.symbol || '-'
                          )}
                        </td>
                        <td className={t.side === 'buy' ? 'bull' : t.side === 'sell' ? 'bear' : ''}>{t.side ?? '-'}</td>
                        <td className="num">{fmtQty(t.quantity)}</td>
                        <td className="num">{fmtPrice(t.price)}</td>
                        <td className={`num ${pnlTone(t.realized_gain)}`}>{fmtSignedMoney(t.realized_gain)}</td>
                        <td>{ns.length > 0 ? <span className="tag gold" title={`${ns.length} note${ns.length === 1 ? '' : 's'}`}>{`● ${ns.length}`}</span> : ''}</td>
                      </tr>
                    )
                    return open
                      ? [
                          row,
                          <tr key={`${t.trade_key}-notes`} className="notes-row">
                            <td colSpan={7}>
                              <TradeNotes trade={t} notes={ns} />
                            </td>
                          </tr>,
                        ]
                      : [row]
                  })}
                </tbody>
              </table>
            )
          )}
          {tradesCursor && (
            <div className="pane-head">
              <button onClick={() => void loadMoreTrades()} disabled={pnlLoading}>Load older trades</button>
            </div>
          )}
        </>
      ) : (
        <EmptyState>Connect Robinhood to load realized P&amp;L and trades. Your notes below are local and always available.</EmptyState>
      )}
      <NotesFeed />
    </div>
  )
}
