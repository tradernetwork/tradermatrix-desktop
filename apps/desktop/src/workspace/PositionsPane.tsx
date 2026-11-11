import { useEffect, useMemo } from 'react'
import { accountLabel, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtQty, pnlClass, positionRow } from '../lib/format'
import { chartOptionFromPosition } from '../chart/optionChart'
import { dteOf, fmtStrike, optionLabel, optionPnl, sortOptionPositions } from '../lib/optionPositions'
import { addEquityIntent, closeEquityIntent, closeOptionIntent } from '../lib/ticketIntent'
import { fillDisabledReason } from '../lib/ticketUi'
import { buildStrikeInput, localIsoDate, rowFromPosition, strikeCheck, strikeRows, verdictDot } from '../lib/strikeCheck'
import { earningsStatus, useEarningsStore } from '../stores/earnings'
import { useTmStore } from '../stores/tm'
import { connectState, useRhStore } from '../stores/rh'
import { askAbout } from '../stores/explainFocus'
import { fillTicket } from '../stores/ticketIntent'
import { useAutoRefresh } from './useAutoRefresh'
import { useMask } from './useMask'
import { EmptyState } from './EmptyState'
import { HeatPanel } from './HeatPanel'

/** Short-option underlyings looked up for the strike-check dots (TM + earnings calls are cached; this caps the fan-out). */
const SC_MAX_UNDERLYINGS = 8

export function PositionsPane() {
  const { status, connecting, connectError, accounts, account, portfolio, positions, positionsError, positionsLoading, quotes, optionPositions, optionPositionsError } =
    useRhStore()
  const { selectAccount, loadPositions, watchQuotes, setChartSymbol, setChartOption } = useRhStore.getState()
  const state = connectState({ status, connecting, connectError })
  const mask = useMask()
  useAutoRefresh(state === 'connected' && !!account, () => void loadPositions())

  const options = useMemo(() => sortOptionPositions(optionPositions), [optionPositions])
  // Short option positions get an informational strike-check dot: their underlyings are quoted too (spot) and looked up in TM / earnings (read-only, cached)
  const shortUnders = useMemo(() => [...new Set(options.filter((o) => o.side === 'short').map((o) => o.chain_symbol))].slice(0, SC_MAX_UNDERLYINGS), [options])
  const symbols = useMemo(() => [...new Set([...positions.map((p) => p.symbol), ...shortUnders])], [positions, shortUnders])
  const key = symbols.join(',')
  const underKey = shortUnders.join(',')
  const tmBy = useTmStore((s) => s.bySymbol)
  const tmEpoch = useTmStore((s) => s.epoch)
  const earnBy = useEarningsStore((s) => s.bySymbol)
  useEffect(() => {
    if (state !== 'connected') return
    for (const u of shortUnders) {
      void useTmStore.getState().loadSymbol(u, ['apex', 'move', 'iv'], false, 'background')
      void useEarningsStore.getState().load(u)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underKey, tmEpoch, state])
  useEffect(() => {
    watchQuotes('positions', symbols)
    return () => watchQuotes('positions', [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, watchQuotes])

  if (state !== 'connected') {
    return <EmptyState>Connect Robinhood to see positions.</EmptyState>
  }

  const rows = positions.map((p) => ({ p, r: positionRow(p, quotes[p.symbol]?.last_trade_price ?? null) }))
  const selected = accounts.find((a) => a.account_number === account)
  // A fill only sets ticket fields, but the ticket must be usable (connected, agentic account selected).
  const fillReason = fillDisabledReason(true, accounts, account)
  const now = new Date()
  const today = localIsoDate(now)
  const checkFor = (o: (typeof options)[number]) => {
    if (o.side !== 'short') return null
    const e = tmBy[o.chain_symbol]
    const earn = earnBy[o.chain_symbol]
    const input = buildStrikeInput({
      side: 'sell', row: rowFromPosition(o), spot: quotes[o.chain_symbol]?.last_trade_price ?? null,
      tm: { apex: e?.apex.data ?? null, move: e?.move.data ?? null, iv: e?.iv.data ?? null },
      earnings: earn?.data ?? null, earningsStatus: earningsStatus(earn), today,
    })
    if (!input) return null
    const result = strikeCheck(input)
    return { result, rows: strikeRows(result, input) }
  }

  return (
    <div className="pane">
      <div className="pane-head">
        <select aria-label="Account" value={account ?? ''} onChange={(e) => void selectAccount(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.account_number} value={a.account_number}>
              {accountLabel(a)}
            </option>
          ))}
        </select>
        {selected?.agentic_allowed && <span className="tag gold">agentic</span>}
        <button onClick={() => void loadPositions()} disabled={positionsLoading}>
          {positionsLoading ? 'Loading...' : 'Refresh'}
        </button>
        {positionsError && <span className="err">{mask(positionsError)}</span>}
      </div>
      {portfolio && (
        <div className="summary">
          <span>Total <b>{fmtMoney(portfolio.total_value)}</b></span>
          <span>Equity <b>{fmtMoney(portfolio.equity_value)}</b></span>
          <span>Options <b>{fmtMoney(portfolio.options_value)}</b></span>
          <span>Cash <b>{fmtMoney(portfolio.cash)}</b></span>
          <span>Buying power <b>{fmtMoney(portfolio.buying_power)}</b></span>
        </div>
      )}
      {rows.length === 0 && !positionsLoading && !positionsError ? (
        <EmptyState>No open positions in this account.</EmptyState>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">Qty</th>
              <th className="num">Avg cost</th>
              <th className="num">Last</th>
              <th className="num">Value</th>
              <th className="num">P&amp;L $</th>
              <th className="num">P&amp;L %</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, r }) => {
              const q = quotes[p.symbol]
              const close = closeEquityIntent(p, q)
              return (
                <tr
                  key={r.symbol}
                  className="clickable"
                  onClick={() => {
                    setChartSymbol(r.symbol)
                    if (!fillReason) fillTicket({ kind: 'equity', symbol: r.symbol, source: 'positions-row' })
                  }}
                  title="Show on chart and set the ticket symbol. Right click: ask Arya about it."
                  onContextMenu={(e) => {
                    e.preventDefault()
                    askAbout({ kind: 'position', position: { kind: 'equity', symbol: r.symbol, qty: r.qty, avg: r.avg, last: r.last } }, { x: e.clientX, y: e.clientY })
                  }}
                >
                  <td>{r.symbol}</td>
                  <td className="num">{fmtQty(r.qty)}</td>
                  <td className="num">{fmtPrice(r.avg)}</td>
                  <td className="num">{fmtPrice(r.last)}</td>
                  <td className="num">{fmtMoney(r.value)}</td>
                  <td className={`num ${pnlClass(r.pnl)}`}>{fmtMoney(r.pnl)}</td>
                  <td className={`num ${pnlClass(r.pnlPct)}`}>{fmtPct(r.pnlPct)}</td>
                  <td className="row-acts">
                    <button
                      disabled={!!fillReason || !close}
                      title={fillReason ?? 'Fill the ticket to close this position with a limit at the touch (you still review and place)'}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (close) fillTicket(close)
                      }}
                    >
                      Close
                    </button>
                    <button
                      disabled={!!fillReason || !closeEquityIntent(p, q, { market: true })}
                      title={fillReason ?? 'Fill the ticket to close this position at market (you still review and place)'}
                      onClick={(e) => {
                        e.stopPropagation()
                        const i = closeEquityIntent(p, q, { market: true })
                        if (i) fillTicket(i)
                      }}
                    >
                      Mkt
                    </button>
                    <button
                      disabled={!!fillReason}
                      title={fillReason ?? 'Fill the ticket to add to this position (you still review and place)'}
                      onClick={(e) => {
                        e.stopPropagation()
                        fillTicket(addEquityIntent(p, q))
                      }}
                    >
                      Add
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {(options.length > 0 || optionPositionsError) && (
        <>
          <div className="section-title" data-testid="options-section">
            Options
            {optionPositionsError && <span className="err">{mask(optionPositionsError)}</span>}
          </div>
          {options.length > 0 && (
            <table className="grid">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Side</th>
                  <th className="num">Qty</th>
                  <th className="num">Avg</th>
                  <th className="num">Mark</th>
                  <th className="num">P&amp;L $</th>
                  <th className="num">P&amp;L %</th>
                  <th className="num">Delta</th>
                  <th className="num">DTE</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {options.map((o) => {
                  const v = optionPnl(o)
                  const close = closeOptionIntent(o)
                  const dte = dteOf(o.expiration_date, now)
                  const sc = checkFor(o)
                  const dot = verdictDot(sc?.result ?? null)
                  return (
                    <tr
                      key={o.option_id}
                      className="clickable"
                      onClick={() => {
                        const c = chartOptionFromPosition(o)
                        if (c) setChartOption(c)
                      }}
                      title={`${o.chain_symbol} ${o.expiration_date ?? '?'} strike ${fmtStrike(o.strike_price)}: click to chart this contract. Right click: ask Arya about it.`}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        askAbout({ kind: 'position', position: { kind: 'option', symbol: o.chain_symbol, right: o.option_type, strike: o.strike_price, dte, qty: o.side === 'short' ? -Math.abs(o.quantity) : Math.abs(o.quantity), avg: v.avgPerShare, delta: o.delta, mid: o.mark, iv: o.iv } }, { x: e.clientX, y: e.clientY })
                      }}
                    >
                      <td>
                        {optionLabel(o)}
                        {sc && dot && (
                          <span className={dot.cls} data-testid="strike-dot" role="img" aria-label={dot.text} title={`${dot.text}\n${sc.rows.map((r) => `${r.label}: ${r.value}`).join('\n')}`} />
                        )}
                      </td>
                      <td className={o.side === 'short' ? 'bear' : 'bull'}>{o.side}</td>
                      <td className="num">{fmtQty(o.quantity)}</td>
                      <td className="num">{fmtPrice(v.avgPerShare)}</td>
                      <td className="num">{fmtPrice(o.mark)}</td>
                      <td className={`num ${pnlClass(v.pnl)}`}>{fmtMoney(v.pnl)}</td>
                      <td className={`num ${pnlClass(v.pnlPct)}`}>{fmtPct(v.pnlPct)}</td>
                      <td className="num">{fmtNum(o.delta)}</td>
                      <td className="num">{dte === null ? '-' : dte}</td>
                      <td className="row-acts">
                        <button
                          disabled={!!fillReason || !close}
                          title={fillReason ?? (close ? 'Fill the option ticket to close this position (you still review and place)' : 'This position cannot be closed from here')}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (close) fillTicket(close)
                          }}
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </>
      )}
      <HeatPanel />
    </div>
  )
}
