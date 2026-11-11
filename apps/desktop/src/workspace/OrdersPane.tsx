import { fmtMoney, fmtPrice, fmtQty } from '../lib/format'
import { intentFromOrder } from '../lib/ticketIntent'
import { fillDisabledReason } from '../lib/ticketUi'
import { cancelAndEdit } from '../stores/ticketIntent'
import { isCancelable, maskKnown, orderStopText, orderTypeLabel } from '../lib/orderUi'
import { useOrdersStore } from '../stores/orders'
import { connectState, useRhStore } from '../stores/rh'
import { ApprovalsPanel } from './ApprovalsPanel'
import { useAutoRefresh } from './useAutoRefresh'
import { useMask } from './useMask'
import { EmptyState } from './EmptyState'

export const ORDER_STATE_FILTERS = ['', 'filled', 'queued', 'confirmed', 'partially_filled', 'cancelled', 'rejected', 'failed'] as const

function when(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
}

/** Lists orders. Open orders can be cancelled (cancel is asynchronous, so orders are re-read afterwards); pending approvals are listed below. */
export function OrdersPane() {
  const { status, connecting, connectError, orders, orderState, ordersError, account, accounts } = useRhStore()
  const { cancelling, actionNote } = useOrdersStore()
  const { cancelOrder } = useOrdersStore.getState()
  const { setOrderState, loadOrders } = useRhStore.getState()
  const state = connectState({ status, connecting, connectError })
  const mask = useMask()
  const fillReason = fillDisabledReason(state === 'connected', accounts, account)
  // new orders and fills show up without a click
  useAutoRefresh(state === 'connected' && !!account, () => void loadOrders())

  if (state !== 'connected') return <EmptyState>Connect Robinhood to see orders.</EmptyState>

  return (
    <div className="pane">
      <div className="pane-head">
        <select aria-label="Order state" value={orderState} onChange={(e) => void setOrderState(e.target.value)}>
          {ORDER_STATE_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'All states' : s}
            </option>
          ))}
        </select>
        <button onClick={() => void loadOrders()} disabled={!account}>
          Refresh
        </button>
        {ordersError && <span className="err">{mask(ordersError)}</span>}
        {actionNote && <span className="muted">{maskKnown(actionNote, accounts.map((a) => a.account_number))}</span>}
      </div>
      {orders.length === 0 && !ordersError ? (
        <EmptyState>No orders{orderState ? ` in state ${orderState}` : ''}.</EmptyState>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>Order</th>
              <th className="num">Qty</th>
              <th className="num">Price</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={`${o.asset}-${o.id}`} title={o.reject_reason ?? ''}>
                <td>{when(o.created_at)}</td>
                <td>{o.asset}</td>
                <td>{o.symbol ?? '-'}</td>
                <td className={o.side === 'buy' || o.side === 'debit' ? 'bull' : o.side === 'sell' || o.side === 'credit' ? 'bear' : ''}>
                  {o.side ?? '-'}
                </td>
                <td>
                  {orderTypeLabel(o)}
                  {orderStopText(o) && <div className="order-stop">{orderStopText(o)}</div>}
                </td>
                <td className="num">{o.quantity !== null ? fmtQty(o.quantity) : o.dollar_based_amount !== null ? fmtMoney(o.dollar_based_amount) : '-'}</td>
                <td className="num">{fmtPrice(o.average_price ?? o.price)}</td>
                <td>{o.state ?? '-'}</td>
                <td>
                  {isCancelable(o) && (
                    <>
                      <button disabled={!!cancelling[o.id]} onClick={() => void cancelOrder(o)}>
                        {cancelling[o.id] ? 'Cancelling...' : 'Cancel'}
                      </button>{' '}
                      <button
                        disabled={!!cancelling[o.id] || !!fillReason || !intentFromOrder(o)}
                        title={
                          fillReason ??
                          (intentFromOrder(o)
                            ? 'Cancel this order, then fill the ticket with its details (you still review and place the new one)'
                            : 'Multi-leg and unsupported orders cannot be edited here')
                        }
                        onClick={() => void cancelAndEdit(o)}
                      >
                        Cancel &amp; edit
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ApprovalsPanel />
    </div>
  )
}
