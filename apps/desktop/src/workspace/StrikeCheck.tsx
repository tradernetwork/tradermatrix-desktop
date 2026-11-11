import { useEffect, useMemo } from 'react'
import type { RhOptionRow } from '../lib/api'
import { buildStrikeInput, localIsoDate, strikeCheck, strikeRows, VERDICT_TEXT } from '../lib/strikeCheck'
import { tmErrorText } from '../lib/tmUi'
import { earningsStatus, useEarningsStore } from '../stores/earnings'
import { useChartContext } from '../stores/chartContext'
import { askAbout } from '../stores/explainFocus'
import { useTmStore } from '../stores/tm'

export interface StrikeCheckPanelProps {
  symbol: string
  row: Pick<RhOptionRow, 'instrument' | 'quote'> | undefined
  side: 'sell' | 'buy'
  spot: number | null
  /** Daily ATR of the underlying when the chart is on the daily timeframe. */
  atr?: number | null
}

/**
 * Strike check panel (M13). INFORMATIONAL ONLY: it never blocks, disables or alters Review / Place, and nothing on it is a
 * button that sends an order. Unknown inputs print "-"; nothing here implies safety when data is missing.
 */
export function StrikeCheckPanel({ symbol, row, side, spot, atr = null }: StrikeCheckPanelProps) {
  const entry = useTmStore((s) => s.bySymbol[symbol])
  const earn = useEarningsStore((s) => s.bySymbol[symbol])
  const tmEpoch = useTmStore((s) => s.epoch)
  useEffect(() => {
    if (!symbol) return
    useTmStore.getState().scheduleSymbol('strike', symbol, ['apex', 'move', 'iv'])
    void useEarningsStore.getState().load(symbol)
  }, [symbol, tmEpoch])

  const today = localIsoDate()
  const input = useMemo(
    () =>
      row
        ? buildStrikeInput({
            side, row, spot, tm: { apex: entry?.apex.data ?? null, move: entry?.move.data ?? null, iv: entry?.iv.data ?? null },
            earnings: earn?.data ?? null, earningsStatus: earningsStatus(earn), atr, today,
          })
        : null,
    [row, side, spot, entry, earn, atr, today],
  )
  const result = useMemo(() => (input ? strikeCheck(input) : null), [input])
  // explain chat: share the numbers on this panel (never labels or text from the server); removed when the panel goes away
  useEffect(() => {
    if (!input || !result) {
      useChartContext.getState().setStrike(null)
      return
    }
    useChartContext.getState().setStrike({
      right: input.right, strike: input.strike, dte: input.dte, emUnits: result.emUnits, wall: result.wallBetween, earningsInside: result.eventInside, verdict: result.verdict ?? null,
    })
    return () => useChartContext.getState().setStrike(null)
  }, [input, result])
  const tmError = entry?.apex.error || entry?.move.error || ''

  return (
    <div className="strike-check" data-testid="strike-check">
      <div className="sc-head">
        <span className="sc-title">Strike check (info only, does not affect orders)</span>
        {result?.verdict && (
          <span className={`sc-pill sc-${result.verdict}`} data-testid="strike-verdict" title={VERDICT_TEXT[result.verdict]}>
            {result.verdict}
          </span>
        )}
      </div>
      {!input || !result ? (
        <div className="muted small">Pick a contract to see how far it sits from the walls, the expected move and earnings.</div>
      ) : (
        <>
          {!result.graded && <div className="muted small">Long leg: distances only, no protection verdict.</div>}
          <dl className="sc-rows">
            {strikeRows(result, input).map((r) => (
              <div
                key={r.label}
                className="sc-row"
                title="Right click: ask Arya about this strike check"
                onContextMenu={(e) => {
                  e.preventDefault()
                  const q = row?.quote
                  const mid = q && typeof q.bid === 'number' && typeof q.ask === 'number' ? (q.bid + q.ask) / 2 : (q?.mark ?? null)
                  askAbout({ kind: 'strike', right: input.right, strike: input.strike, dte: input.dte, delta: input.delta ?? null, mid, iv: q?.implied_volatility ?? null }, { x: e.clientX, y: e.clientY })
                }}
              >
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          {result.verdict !== undefined && <div className="muted small">{`${result.verdict}: ${VERDICT_TEXT[result.verdict]}. Walls are positioning maps, not targets.`}</div>}
          {tmError && <div className="muted small" data-testid="strike-tm-error">{tmErrorText(tmError)}</div>}
          {earn?.error && <div className="muted small">Earnings date unavailable.</div>}
        </>
      )}
    </div>
  )
}
