import { useEffect } from 'react'
import { approvalSummary, maskKnown } from '../lib/orderUi'
import { useOrdersStore } from '../stores/orders'
import { useRhStore } from '../stores/rh'

/** Pending trade approvals for the selected account, with Decline. Approving happens only in the Robinhood app. */
export function ApprovalsPanel() {
  const account = useRhStore((s) => s.account)
  const accounts = useRhStore((s) => s.accounts)
  const { approvals, approvalsError, approvalsAccount, actionNote, declined } = useOrdersStore()
  const { refreshApprovals, declineApproval } = useOrdersStore.getState()
  const agentic = !!accounts.find((a) => a.account_number === account)?.agentic_allowed
  const nums = accounts.map((a) => a.account_number)

  useEffect(() => {
    if (account && agentic) void refreshApprovals(account)
  }, [account, agentic, refreshApprovals])

  if (!account || !agentic) return null
  const mine = approvalsAccount === account ? approvals : []
  return (
    <div className="approvals" data-testid="approvals">
      <div className="pane-head">
        <b>Pending approvals</b>
        <button onClick={() => void refreshApprovals(account)}>Refresh</button>
        {approvalsError && <span className="err">{maskKnown(approvalsError, nums)}</span>}
      </div>
      {mine.length === 0 && !approvalsError ? (
        <div className="muted small pad">None pending. Approve or decline in the Robinhood app.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Order</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mine.map((a) => (
              <tr key={a.approval_id}>
                <td>{approvalSummary(a, nums)}</td>
                <td>{a.expires_at ? new Date(a.expires_at).toLocaleTimeString('en-US', { timeStyle: 'short' }) : '-'}</td>
                <td>
                  <button disabled={!!declined[a.approval_id]} onClick={() => void declineApproval(account, a.approval_id)}>
                    Decline
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {actionNote && <div className="muted small pad">{maskKnown(actionNote, nums)}</div>}
    </div>
  )
}
