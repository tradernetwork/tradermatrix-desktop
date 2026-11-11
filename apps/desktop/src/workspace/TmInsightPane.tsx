import { useEffect } from 'react'
import { degradedText, isPaused, pausedMessage } from '../lib/tmQuota'
import { fmtNum } from '../lib/format'
import {
  fmtBand,
  fmtGexM,
  fmtHeld,
  fmtIvPct,
  fmtIvRank,
  fmtMovePct,
  gexTone,
  pctBar,
  snapshotCards,
  tmErrorText,
} from '../lib/tmUi'
import { fmtLevel } from '../chart/tmOverlay'
import { ALL_LEGS, useTmStore, type Leg } from '../stores/tm'
import { useRhStore } from '../stores/rh'
import { fillTicket } from '../stores/ticketIntent'
import { fillDisabledReason } from '../lib/ticketUi'

const Badge = () => (
  <span className="tm-badge" title="Source: TraderMatrix">
    TM
  </span>
)

function LegState({ leg, what }: { leg: Leg<unknown> | undefined; what: string }) {
  if (leg?.error) return <div className="tm-err" role="alert">{tmErrorText(leg.error)}</div>
  if (!leg || leg.loading) return <div className="muted pad">Loading {what}...</div>
  return null
}

/** TM Insight pane: read-only TraderMatrix analytics for the chart symbol. Positioning data, not forecasts. */
export function TmInsightPane() {
  const symbol = useRhStore((s) => s.chartSymbol).toUpperCase()
  const status = useTmStore((s) => s.status)
  const epoch = useTmStore((s) => s.epoch)
  const entry = useTmStore((s) => s.bySymbol[symbol])
  const keyPresent = status?.key_present
  const quota = useTmStore((s) => s.quota)
  const paused = isPaused(quota, Date.now())
  const accounts = useRhStore((s) => s.accounts)
  const account = useRhStore((s) => s.account)
  const fillReason = fillDisabledReason(useRhStore((s) => s.status?.connected === true), accounts, account)

  useEffect(() => {
    useTmStore.getState().scheduleSymbol('insight', symbol)
  }, [symbol, epoch, keyPresent])

  const blocked = status && !status.key_present
  const loading = entry ? ALL_LEGS.some((l) => entry[l].loading) : false
  const snap = entry?.snapshot.data ?? null
  const apex = entry?.apex.data ?? null
  const move = entry?.move.data ?? null
  const iv = entry?.iv.data ?? null
  const url = apex?.open_url ?? snap?.open_url ?? move?.open_url ?? iv?.open_url ?? null
  const spot = apex?.spot ?? move?.spot ?? null

  return (
    <div className="pane tm-insight">
      <div className="pane-head">
        <button
          className="sym-link"
          title={fillReason ?? `Set the order ticket symbol to ${symbol}`}
          disabled={!!fillReason}
          onClick={() => {
            useRhStore.getState().setChartSymbol(symbol)
            fillTicket({ kind: 'equity', symbol, source: 'tm-insight' })
          }}
        >
          <b>{symbol}</b>
        </button>
        <Badge />
        <span className="muted">positioning data, not forecasts</span>
        <button onClick={() => void useTmStore.getState().loadSymbol(symbol, ALL_LEGS, true)} disabled={!!blocked || loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {paused && quota && (
        <div className="tm-degraded" role="status" data-testid="tm-paused">
          {degradedText(pausedMessage(quota))}. Data already on screen stays; nothing new is requested until then.
        </div>
      )}
      {quota?.preview && (
        <div className="tm-degraded" role="status" data-testid="tm-preview">
          preview: upgrade for full lists
        </div>
      )}
      {blocked ? (
        <div className="tm-err" role="alert">
          {tmErrorText(status.last_error ?? 'TraderMatrix key not set')}
        </div>
      ) : (
        <>
          <section>
            <h3>
              Snapshot <Badge />
            </h3>
            {snap ? (
              <div className="tm-cards">
                {snapshotCards(snap).map((c) => (
                  <div className="tm-card" key={c.key}>
                    <div className="tm-card-title">{c.title}</div>
                    <div className="tm-card-head">{c.headline}</div>
                    {c.bar !== undefined && (
                      <div className="tm-bar" role="img" aria-label={`${c.title} ${c.headline}`}>
                        <i style={{ width: `${c.bar}%` }} />
                      </div>
                    )}
                    {c.sub.map((t) => (
                      <div className="muted small" key={t}>
                        {t}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <LegState leg={entry?.snapshot} what="snapshot" />
            )}
            {snap && snap.missing.length > 0 && <div className="muted small">TraderMatrix lists as missing: {snap.missing.join(', ')}</div>}
          </section>

          <section>
            <h3>
              IV rank <Badge />
            </h3>
            {iv ? (
              <div className="tm-iv">
                <div className="tm-card-head">{iv.iv_rank !== null ? fmtIvRank(iv.iv_rank) : `not available${iv.reason ? ` (${iv.reason.replace(/_/g, ' ')})` : ''}`}</div>
                {iv.iv_rank !== null && (
                  <div className="tm-bar" role="img" aria-label={`IV rank ${fmtIvRank(iv.iv_rank)}`}>
                    <i style={{ width: `${pctBar(iv.iv_rank, 100)}%` }} />
                  </div>
                )}
                <div className="muted small">
                  {[iv.zone ? `zone ${iv.zone.replace(/_/g, ' ')}` : '', iv.source ? `source ${iv.source}` : '', iv.as_of ? `as of ${iv.as_of}` : ''].filter(Boolean).join(' · ')}
                </div>
                {iv.recent_change && (
                  <div className="muted small">
                    Last {iv.recent_change.sessions ?? '?'} sessions: {iv.recent_change.direction ?? '-'}
                    {iv.recent_change.points_change !== null ? ` ${fmtNum(iv.recent_change.points_change, 1)} pts` : ''}
                    {iv.recent_change.from_iv !== null && iv.recent_change.to_iv !== null ? ` (IV ${fmtIvPct(iv.recent_change.from_iv)} to ${fmtIvPct(iv.recent_change.to_iv)})` : ''}
                  </div>
                )}
              </div>
            ) : (
              <LegState leg={entry?.iv} what="IV rank" />
            )}
          </section>

          <section>
            <h3>
              Expected move <Badge />
            </h3>
            {move ? (
              move.horizons.length === 0 ? (
                <div className="pane-empty">No horizons returned.</div>
              ) : (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Horizon</th>
                      <th className="num">1σ move</th>
                      <th className="num">68% band</th>
                      <th className="num">95% band</th>
                      <th className="num">Held 68%</th>
                      <th className="num">Held 95%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {move.horizons.map((h) => (
                      <tr key={h.label}>
                        <td>{h.label}</td>
                        <td className="num">{fmtMovePct(h.expected_move_pct)}</td>
                        <td className="num">{fmtBand(h.band68)}</td>
                        <td className="num">{fmtBand(h.band95)}</td>
                        <td className="num">{fmtHeld(h.held68_pct)}</td>
                        <td className="num">{fmtHeld(h.held95_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : (
              <LegState leg={entry?.move} what="expected move" />
            )}
          </section>

          <section>
            <h3>
              Apex levels <Badge />
            </h3>
            {apex ? (
              apex.levels.length === 0 ? (
                <div className="pane-empty">No Apex levels returned.</div>
              ) : (
                <>
                  <div className="muted small">
                    Positioning map: where options open interest and dealer hedging concentrate. Not price targets.
                    {apex.gamma_flip !== null ? ` Gamma flip ${fmtNum(apex.gamma_flip)}.` : ''}
                    {apex.net_gex !== null ? ` Net GEX ${fmtGexM(apex.net_gex)}.` : ''}
                  </div>
                  <table className="grid">
                    <thead>
                      <tr>
                        <th className="num">Strike</th>
                        <th className="num">Score</th>
                        <th className="num">Net GEX</th>
                        <th className="num">OI</th>
                        <th>Side</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...apex.levels]
                        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
                        .map((l, i) => {
                          const above = typeof spot === 'number' && typeof l.strike === 'number' ? l.strike > spot : l.is_above_spot
                          return (
                            <tr key={`${l.strike}-${i}`}>
                              <td className="num">{typeof l.strike === 'number' ? fmtLevel(l.strike) : '-'}</td>
                              <td className="num">{typeof l.score === 'number' ? fmtLevel(l.score) : '-'}</td>
                              <td className={`num ${gexTone(l.net_gex)}`}>{fmtGexM(l.net_gex)}</td>
                              <td className="num">{typeof l.total_oi === 'number' ? l.total_oi.toLocaleString('en-US') : '-'}</td>
                              <td className={above === null ? '' : above ? 'bear' : 'bull'}>{above === null ? '-' : above ? 'above spot' : 'below spot'}</td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </>
              )
            ) : (
              <LegState leg={entry?.apex} what="Apex levels" />
            )}
          </section>

          {url && (
            <div className="tm-open muted small">
              Open in TraderMatrix: <code className="tm-url">{url}</code>
            </div>
          )}
        </>
      )}
    </div>
  )
}
