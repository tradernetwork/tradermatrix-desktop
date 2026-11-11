import { useEffect, useState } from 'react'
import { isSnoozed } from '../alerts/active'
import type { Alert, AlertEvent, SnoozeChoice } from '../alerts/types'
import { fmtPrice } from '../lib/format'
import { refText } from '../alerts/levelRefs'
import { useAlertsStore } from '../stores/alerts'
import { useRhStore } from '../stores/rh'
import { optionLabel } from '../lib/optionPositions'
import { EmptyState } from './EmptyState'

const ET: Intl.DateTimeFormatOptions = { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
/** UTC milliseconds shown in Eastern time. */
export function etText(ms: number): string {
  return `${new Date(ms).toLocaleString('en-US', ET)} ET`
}

function cfgOf<T>(a: Alert): Partial<T> {
  try {
    return a.ref_param ? (JSON.parse(a.ref_param) as T) : {}
  } catch {
    return {}
  }
}

function describe(a: Alert): string {
  if (a.kind === 'iv') return `IV rank ${a.dir === 'down' ? 'falls through' : a.dir === 'up' ? 'rises through' : 'crosses'} ${a.price}`
  if (a.kind === 'pnl') {
    const c = cfgOf<{ thr: number; opt: boolean }>(a)
    return `P&L reaches ${c.thr ?? '?'} dollars${c.opt ? ' (option P&L units unverified)' : ''}`
  }
  if (a.kind === 'verdict') return `strike check becomes ${cfgOf<{ to: string }>(a).to ?? 'exposed'}`
  if (a.kind === 'earnings') return 'earnings fall inside the short expiry'
  if (a.kind === 'order') return 'an order fills, is rejected or needs approval'
  const way = a.dir === 'up' ? 'rises through' : a.dir === 'down' ? 'falls through' : 'crosses'
  const ref = a.ref_kind === 'price' ? '' : ` (${refText(a)})`
  return `${way} ${fmtPrice(a.price)}${ref}`
}

function status(a: Alert, now: number, session: boolean): string {
  if (!a.enabled) return a.last_fired_at ? 'fired' : 'off'
  if (isSnoozed(a, now, session ? new Set([a.id]) : undefined)) return session ? 'snoozed (session)' : `snoozed until ${etText(a.snooze_until ?? 0)}`
  if (!a.armed) return 'fired, waiting to re-arm'
  return 'armed'
}

function Row({ a, session }: { a: Alert; session: boolean }) {
  const st = useAlertsStore.getState()
  const snoozed = isSnoozed(a, Date.now(), session ? new Set([a.id]) : undefined)
  return (
    <tr>
      <td>
        <input type="checkbox" aria-label={`Enable alert on ${a.symbol}`} checked={a.enabled} onChange={(e) => void st.setEnabled(a.id, e.target.checked)} />
      </td>
      <td>{a.symbol}</td>
      <td>{describe(a)}</td>
      <td className="muted">{status(a, Date.now(), session)}</td>
      <td>
        <select
          aria-label={`Snooze alert on ${a.symbol}`}
          value=""
          onChange={(e) => {
            const v = e.target.value as SnoozeChoice
            if (v) void st.snooze(a.id, v)
          }}
        >
          <option value="">{snoozed ? 'Snoozed' : 'Snooze'}</option>
          <option value="15m">15 minutes</option>
          <option value="1h">1 hour</option>
          <option value="session">This session</option>
          {snoozed && <option value="off">Wake now</option>}
        </select>
      </td>
      <td>
        <button aria-label={`Delete alert on ${a.symbol}`} onClick={() => void st.remove(a.id)}>
          Delete
        </button>
      </td>
    </tr>
  )
}

function EventRow({ e, fresh }: { e: AlertEvent; fresh: boolean }) {
  return (
    <tr>
      <td className="muted">{etText(e.fired_at)}</td>
      <td>
        {e.label}
        {fresh && <span className="tag gold alert-new"> new</span>}
      </td>
      <td className="num">{fmtPrice(e.trigger_px)}</td>
    </tr>
  )
}


const FIELD = { width: 90 } as const

/** Non-price alerts (IV rank, P&L, strike-check verdict, earnings, order state). Price alerts are set on the chart. */
function NewAlertForm() {
  const options = useRhStore((s) => s.optionPositions)
  const equities = useRhStore((s) => s.positions)
  const [kind, setKind] = useState<'iv' | 'pnl' | 'verdict' | 'earnings' | 'order'>('iv')
  const [symbol, setSymbol] = useState('')
  const [level, setLevel] = useState('60')
  const [dir, setDir] = useState<'up' | 'down'>('up')
  const [pos, setPos] = useState('')
  const [target, setTarget] = useState('exposed')
  const shorts = options.filter((o) => o.side === 'short')
  const create = () => {
    const st = useAlertsStore.getState()
    const base = { mode: 'cross', repeat: 'once', dir: 'either' } as const
    if (kind === 'iv') {
      const v = Number(level)
      if (symbol && v > 0) void st.create({ ...base, symbol: symbol.toUpperCase(), kind: 'iv', ref_kind: 'iv', price: v, dir, repeat: 'rearm', cooldown_s: 3600 })
    } else if (kind === 'order') {
      if (symbol) void st.create({ ...base, symbol: symbol.toUpperCase(), kind: 'order', ref_kind: 'order', price: 1 })
    } else if (kind === 'pnl') {
      const thr = Number(level)
      const o = options.find((x) => x.option_id === pos)
      const e = equities.find((x) => x.symbol === pos)
      if (!Number.isFinite(thr) || thr === 0 || !(o || e)) return
      void st.create({ ...base, symbol: o ? o.chain_symbol : pos, kind: 'pnl', ref_kind: 'pnl', ref_param: JSON.stringify({ pos, thr, opt: !!o }), price: Math.abs(thr), dir: thr < 0 ? 'down' : 'up' })
    } else {
      const o = shorts.find((x) => x.option_id === pos)
      if (!o) return
      if (kind === 'verdict') void st.create({ ...base, symbol: o.chain_symbol, kind: 'verdict', ref_kind: 'verdict', ref_param: JSON.stringify({ opt: pos, to: target }), price: o.strike_price ?? 1 })
      else void st.create({ ...base, symbol: o.chain_symbol, kind: 'earnings', ref_kind: 'verdict', ref_param: JSON.stringify({ opt: pos }), price: o.strike_price ?? 1 })
    }
  }
  return (
    <details className="alert-new-form">
      <summary>New alert (IV rank, P&L, strike check, earnings, order)</summary>
      <div className="alert-form-row">
        <select aria-label="Alert type" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="iv">IV rank</option>
          <option value="pnl">P&amp;L</option>
          <option value="verdict">Strike-check verdict</option>
          <option value="earnings">Earnings inside expiry</option>
          <option value="order">Order state</option>
        </select>
        {(kind === 'iv' || kind === 'order') && <input aria-label="Symbol" placeholder="Symbol" style={FIELD} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />}
        {(kind === 'pnl' || kind === 'verdict' || kind === 'earnings') && (
          <select aria-label="Position" value={pos} onChange={(e) => setPos(e.target.value)}>
            <option value="">Position</option>
            {(kind === 'pnl' ? options : shorts).map((o) => (
              <option key={o.option_id} value={o.option_id}>
                {optionLabel(o)}
              </option>
            ))}
            {kind === 'pnl' && equities.map((e) => <option key={e.symbol} value={e.symbol}>{e.symbol} (shares)</option>)}
          </select>
        )}
        {(kind === 'iv' || kind === 'pnl') && <input aria-label={kind === 'iv' ? 'IV rank level' : 'P&L threshold in dollars'} style={FIELD} value={level} onChange={(e) => setLevel(e.target.value)} />}
        {kind === 'iv' && (
          <select aria-label="Direction" value={dir} onChange={(e) => setDir(e.target.value as 'up' | 'down')}>
            <option value="up">rises through</option>
            <option value="down">falls through</option>
          </select>
        )}
        {kind === 'verdict' && (
          <select aria-label="Verdict" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="exposed">becomes exposed</option>
            <option value="event">becomes event</option>
            <option value="protected">becomes protected</option>
          </select>
        )}
        <button onClick={create}>Add</button>
      </div>
      {kind === 'pnl' && <div className="muted">Option P&amp;L units are unverified until a live capture confirms the average price. Use a negative number for a loss.</div>}
    </details>
  )
}

function AlertPrefs() {
  const prefs = useAlertsStore((s) => s.prefs)
  const unavailable = useAlertsStore((s) => s.osUnavailable)
  return (
    <div className="alert-prefs">
      <label>
        <input type="checkbox" checked={prefs.sound} onChange={(e) => void useAlertsStore.getState().setPref('sound', e.target.checked)} /> Sound
      </label>
      <label>
        <input type="checkbox" checked={prefs.os} onChange={(e) => void useAlertsStore.getState().setPref('os', e.target.checked)} /> OS notification
      </label>
      {unavailable && <span className="muted">OS notifications unavailable on this system (toast and sound still work)</span>}
    </div>
  )
}

/** Alerts: the list (toggle, snooze, delete) and the History tab (events, unseen badge, "while you were away"). Inform only. */
export function AlertsPane() {
  const { alerts, events, unseen, sessionSnoozed, error } = useAlertsStore()
  const [tab, setTab] = useState<'alerts' | 'history'>('alerts')
  const [fresh, setFresh] = useState<Set<number>>(new Set())

  useEffect(() => {
    void useAlertsStore.getState().load()
    void useAlertsStore.getState().loadPrefs()
  }, [])

  const open = (t: 'alerts' | 'history') => {
    setTab(t)
    if (t === 'history') {
      // show what was new, then mark it seen so the badge clears
      const ids = useAlertsStore.getState().events.filter((e) => !e.seen).map((e) => e.id)
      setFresh(new Set(ids))
      if (ids.length) void useAlertsStore.getState().ack(ids)
    }
  }

  const away = events.filter((e) => e.missed)
  const normal = events.filter((e) => !e.missed)
  return (
    <div className="pane alerts-pane">
      <div className="pane-head" role="tablist">
        <button role="tab" aria-selected={tab === 'alerts'} className={tab === 'alerts' ? 'active' : ''} onClick={() => open('alerts')}>
          Alerts ({alerts.length})
        </button>
        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => open('history')}>
          History
          {unseen > 0 && (
            <span className="alert-badge" aria-label={`${unseen} unseen`}>
              {unseen}
            </span>
          )}
        </button>
        {error && <span className="err">{error}</span>}
      </div>
      {tab === 'alerts' && (
        <>
          <AlertPrefs />
          <NewAlertForm />
        </>
      )}
      {tab === 'alerts' ? (
        alerts.length === 0 ? (
          <EmptyState>No alerts yet. Right-click the chart (or press Alt+A over it) to set a price alert.</EmptyState>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th />
                <th>Symbol</th>
                <th>When</th>
                <th>Status</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <Row key={a.id} a={a} session={sessionSnoozed.includes(a.id)} />
              ))}
            </tbody>
          </table>
        )
      ) : events.length === 0 ? (
        <EmptyState>Nothing has fired yet.</EmptyState>
      ) : (
        <>
          {away.length > 0 && (
            <>
              <div className="alerts-section">While you were away</div>
              <table className="grid">
                <tbody>
                  {away.map((e) => (
                    <EventRow key={e.id} e={e} fresh={fresh.has(e.id)} />
                  ))}
                </tbody>
              </table>
            </>
          )}
          {normal.length > 0 && (
            <>
              {away.length > 0 && <div className="alerts-section">Fired</div>}
              <table className="grid">
                <tbody>
                  {normal.map((e) => (
                    <EventRow key={e.id} e={e} fresh={fresh.has(e.id)} />
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  )
}
