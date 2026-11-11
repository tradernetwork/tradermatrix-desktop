import { useEffect, useRef, useState } from 'react'
import {
  approvalBanner,
  approvalIdOf,
  echoedSummary,
  hasOrderChecks,
  maskKnown,
  orderCheckMessages,
  placeLabel,
  resultCard,
  withTicketRows,
} from '../lib/orderUi'
import { placeBlockedReason, useOrdersStore } from '../stores/orders'
import { useRhStore } from '../stores/rh'

/** Review panel and result cards. Reads the orders store; the single Place button lives here. */
export function OrderReview() {
  const { phase, ticket, reviewOut, outcome, outcomeAt, error, actionNote, declined } = useOrdersStore()
  const accounts = useRhStore((s) => s.accounts)
  const nums = accounts.map((a) => a.account_number)
  const { place, retrySameRef, reset, declineApproval, dismissUnknown } = useOrdersStore.getState()
  // the unknown card shows its age and counts down to the end of the retry window
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (phase !== 'unknown') return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [phase])
  // The approval banner and the Place button sit at the bottom of the review: bring a fresh review into view.
  const reviewRef = useRef<HTMLDivElement>(null)
  const reviewId = reviewOut?.review_id
  useEffect(() => {
    if (reviewId) reviewRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [reviewId])

  if (phase === 'idle') return error ? <div className="err" role="alert">{maskKnown(error, nums)}</div> : null
  if (phase === 'reviewing') return <div className="muted">Reviewing...</div>

  if ((phase === 'reviewed' || phase === 'placing') && reviewOut) {
    const sum = echoedSummary(reviewOut.echoed, nums)
    const rows = ticket ? withTicketRows(sum.rows, ticket) : sum.rows
    const blockedWhy = placeBlockedReason(ticket)
    const contracts = ticket?.kind === 'option' ? (ticket.legs ?? []) : []
    const checks = hasOrderChecks(reviewOut.order_checks)
    const banner = approvalBanner(reviewOut)
    const placing = phase === 'placing'
    return (
      <div className="review" data-testid="review" ref={reviewRef}>
        <div className="review-head">
          <b>Review</b>
          <span className="muted">
            {reviewOut.kind} on {reviewOut.account_masked}, valid {Math.round(reviewOut.expires_in_secs / 60)} min
          </span>
        </div>
        <table className="kv">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
            {contracts.map((l) => (
              <tr key={`contract-${l.option_id}`}>
                <th>contract</th>
                <td>{l.label ?? 'NOT IN THE LOADED CHAIN'}</td>
              </tr>
            ))}
            {sum.legs.map((l) => (
              <tr key={l}>
                <th>leg</th>
                <td>{l}</td>
              </tr>
            ))}
            {sum.quote && (
              <tr>
                <th>quote</th>
                <td>{sum.quote}</td>
              </tr>
            )}
            {sum.optionQuotes.map((l) => (
              <tr key={l}>
                <th>option quote</th>
                <td>{l}</td>
              </tr>
            ))}
            {sum.fees && (
              <tr>
                <th>fees</th>
                <td>{sum.fees}</td>
              </tr>
            )}
            {sum.collateral && (
              <tr>
                <th>collateral</th>
                <td>{sum.collateral}</td>
              </tr>
            )}
          </tbody>
        </table>
        {sum.disclosure && <div className="muted small">{sum.disclosure}</div>}
        {checks && (
          <div className="alert-box" role="alert" data-testid="order-checks">
            <b>Order checks</b>
            <ul>
              {orderCheckMessages(reviewOut.order_checks).map((m) => (
                <li key={m}>{maskKnown(m, nums)}</li>
              ))}
            </ul>
          </div>
        )}
        <div className={`banner ${banner.tone}`} data-testid="approval-banner">
          {banner.text}
        </div>
        {blockedWhy && <div className="err" role="alert">{blockedWhy}</div>}
        <div className="review-actions">
          <button className={`primary${checks ? ' danger' : ''}`} disabled={placing || !!blockedWhy} onClick={() => void place()}>
            {placeLabel(checks, placing)}
          </button>
          <button disabled={placing} onClick={() => reset()}>
            Discard
          </button>
        </div>
      </div>
    )
  }

  if (outcome) {
    const card = resultCard(outcome, { now, since: outcomeAt })
    const approvalId = approvalIdOf(outcome)
    const account = ticket?.args.account_number
    return (
      <div className={`result ${card.tone}`} data-testid="result">
        <b>{card.title}</b>
        <div>{maskKnown(card.body, nums)}</div>
        {actionNote && <div className="muted small">{maskKnown(actionNote, nums)}</div>}
        {error && <div className="err small" role="alert">{maskKnown(error, nums)}</div>}
        <div className="review-actions">
          {card.actions.includes('decline') && approvalId && account && (
            <button disabled={!!declined[approvalId]} onClick={() => void declineApproval(account, approvalId)}>
              {declined[approvalId] ? 'Withdrawn' : 'Decline / Withdraw'}
            </button>
          )}
          {card.actions.includes('retry') && (
            <button disabled={card.retryDisabled} title={card.retryDisabled ? 'Check Orders, then review again' : undefined} onClick={() => void retrySameRef()}>
              Retry (same ref)
            </button>
          )}
          {card.actions.includes('refresh') && <button onClick={() => void useRhStore.getState().loadOrders()}>Refresh orders</button>}
          <button onClick={() => (phase === 'unknown' ? void dismissUnknown() : reset())}>{phase === 'unknown' ? 'Dismiss' : 'New order'}</button>
        </div>
        {phase === 'awaitingApproval' && <div className="muted small">Approve or decline in the Robinhood app. This order cannot be resubmitted from here.</div>}
      </div>
    )
  }
  return null
}
