import { create } from 'zustand'
import { api, type EquityOrderArgs, type OptionOrderArgs, type PlaceOutcome, type ReviewOut, type RhApproval, type RhOrder } from '../lib/api'
import { isCancelable, retryExpired } from '../lib/orderUi'
import { useRhStore } from './rh'

/** One resolved option leg: `label` is `AAPL 2026-11-20 150 call` from the loaded chain rows, null when the contract is not in them. */
export interface TicketLeg {
  option_id: string
  label: string | null
}
export type Ticket = { kind: 'equity'; args: EquityOrderArgs } | { kind: 'option'; args: OptionOrderArgs; legs?: TicketLeg[] }
export type OrderPhase = 'idle' | 'reviewing' | 'reviewed' | 'placing' | 'placed' | 'awaitingApproval' | 'rejected' | 'unknown'

/** Stable identity of a ticket: the UI recomputes it on every edit; a different key discards a review. */
export function ticketKey(t: Ticket): string {
  return JSON.stringify(t)
}

/** Why a reviewed ticket must not be placed (null = fine). An option leg whose contract is not in the loaded chain blocks Place. Lenient when the ticket carries no leg info. */
export function placeBlockedReason(t: Ticket | null): string | null {
  if (t?.kind === 'option' && t.legs?.some((l) => l.label === null)) {
    return 'A contract in this order is not in the loaded chain. Reload the chain, pick the contract again and review.'
  }
  return null
}

/** Only a fresh review can be placed; every other phase (placing, finished, unknown) cannot. */
export const placeAllowed = (p: OrderPhase): boolean => p === 'reviewed'
/** Only an Unknown outcome can be re-sent, and only with the same review (same ref id server-side). */
export const retryAllowed = (p: OrderPhase): boolean => p === 'unknown'

interface OrdersState {
  phase: OrderPhase
  ticket: Ticket | null
  reviewKey: string | null
  reviewOut: ReviewOut | null
  outcome: PlaceOutcome | null
  /** Epoch ms when the current unknown outcome first arrived (for the age display). */
  outcomeAt: number | null
  error: string
  /** Last result of a cancel / decline / refresh action, shown near the buttons. */
  actionNote: string

  approvals: RhApproval[]
  approvalsError: string
  approvalsAccount: string | null
  /** account -> human_must_approve_trades (null: unknown / failed read) */
  approvalSetting: Record<string, boolean | null>
  settingError: string
  cancelling: Record<string, true>
  declined: Record<string, true>


  /** idle/reviewed/finished -> reviewing -> reviewed. Refused while Unknown (a new review would mint a new ref id). */
  review: (t: Ticket) => Promise<void>
  /** reviewed -> placing -> placed | awaitingApproval | rejected | unknown. Single flight. */
  place: () => Promise<void>
  /** unknown -> placing: re-sends the SAME review (same ref id server-side), only on an explicit user click. */
  retrySameRef: () => Promise<void>
  reset: () => void
  /** Unknown outcome -> idle, but only after the orders for the ticket's account were read again (so you have looked). true = dismissed. */
  dismissUnknown: () => Promise<boolean>
  /** Session wipe: back to the initial state; anything still in flight is dropped when it lands. */
  wipe: () => void
  /** Drops a finished (placed / rejected) result card; keeps approvals, unconfirmed orders, reviews and in-flight placements. */
  clearFinished: () => void
  /** Call on every ticket edit with the new key: a review of a different ticket is discarded. */
  ticketEdited: (key: string) => void
  /** true only when Robinhood accepted the cancel request. */
  cancelOrder: (o: RhOrder) => Promise<boolean>
  declineApproval: (account: string, approvalId: string) => Promise<void>
  refreshApprovals: (account: string) => Promise<void>
  loadApprovalSetting: (account: string) => Promise<void>
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const CLEAR = {
  ticket: null as Ticket | null,
  reviewKey: null as string | null,
  reviewOut: null as ReviewOut | null,
  outcome: null as PlaceOutcome | null,
  outcomeAt: null as number | null,
  error: '',
  actionNote: '',
}

let seq = 0
/** Bumped by wipe(): a place/refresh that started before it must not write state afterwards. */
let wipeEpoch = 0

export const useOrdersStore = create<OrdersState>((set, get) => {
  const send = async (reviewId: string, retrying: boolean) => {
    const myEpoch = wipeEpoch
    set({ phase: 'placing', error: '', actionNote: '' })
    let out: PlaceOutcome
    try {
      out = await api.rhPlaceOrder(reviewId)
    } catch (e) {
      if (myEpoch !== wipeEpoch) return
      if (retrying) {
        // A failed RETRY says nothing about the first send: the order may well exist. Stay unknown, never "rejected".
        set({ phase: 'unknown', actionNote: `Retry failed: ${msg(e)}` })
        return
      }
      // An error (not an outcome) on a first send means nothing was sent: unknown/expired review, not connected, validation.
      set({ phase: 'rejected', outcome: { kind: 'rejected', message: msg(e) } })
      return
    }
    if (myEpoch !== wipeEpoch) return
    const phase: OrderPhase =
      out.kind === 'placed' ? 'placed' : out.kind === 'awaiting_approval' ? 'awaitingApproval' : out.kind === 'rejected' ? 'rejected' : 'unknown'
    set({ phase, outcome: out, outcomeAt: phase === 'unknown' ? (retrying ? (get().outcomeAt ?? Date.now()) : Date.now()) : null })
    const account = get().ticket?.args.account_number
    const rh = useRhStore.getState()
    if (out.kind === 'placed' || out.kind === 'awaiting_approval') {
      void rh.loadPositions()
      await rh.loadOrders()
    }
    if (out.kind === 'awaiting_approval' && account) await get().refreshApprovals(account)
  }

  return {
    phase: 'idle',
    ...CLEAR,
    approvals: [],
    approvalsError: '',
    approvalsAccount: null,
    approvalSetting: {},
    settingError: '',
    cancelling: {},
    declined: {},

    review: async (t) => {
      const phase = get().phase
      if (phase === 'awaitingApproval' && ticketKey(t) === get().reviewKey) {
        set({ error: 'This order is waiting for your approval in the Robinhood app. Approve or decline it there first (it is not placed yet).' })
        return
      }
      if (phase === 'unknown') {
        set({ error: 'The last order is unconfirmed. Check Orders, then retry it or dismiss it before reviewing a new one.' })
        return
      }
      if (phase === 'reviewing' || phase === 'placing') return
      const my = ++seq
      set({ phase: 'reviewing', ...CLEAR, ticket: t, reviewKey: ticketKey(t) })
      try {
        const out = t.kind === 'equity' ? await api.rhReviewEquityOrder(t.args) : await api.rhReviewOptionOrder(t.args)
        if (my !== seq) return
        set({ phase: 'reviewed', reviewOut: out })
      } catch (e) {
        if (my !== seq) return
        set({ phase: 'idle', ...CLEAR, error: msg(e) })
      }
    },

    place: async () => {
      const s = get()
      if (!placeAllowed(s.phase) || !s.reviewOut) return
      const blocked = placeBlockedReason(s.ticket)
      if (blocked) {
        set({ error: blocked })
        return
      }
      await send(s.reviewOut.review_id, false)
    },

    retrySameRef: async () => {
      const s = get()
      if (!retryAllowed(s.phase) || !s.reviewOut) return
      if (retryExpired(s.outcome, Date.now())) {
        set({ actionNote: 'The retry window has passed. Check Orders, then review again.' })
        return
      }
      await send(s.reviewOut.review_id, true)
    },

    dismissUnknown: async () => {
      if (get().phase !== 'unknown') {
        get().reset()
        return true
      }
      const account = get().ticket?.args.account_number
      const rh = useRhStore.getState()
      if (account && rh.account !== account) await rh.selectAccount(account)
      const ok = account ? await useRhStore.getState().loadOrders(account) : false
      if (!ok) {
        set({ actionNote: 'Could not reload your orders, so the unconfirmed order was not dismissed. Check the connection and try again.' })
        return false
      }
      get().reset()
      return true
    },

    wipe: () => {
      seq++
      wipeEpoch++
      set({
        phase: 'idle', ...CLEAR, approvals: [], approvalsError: '', approvalsAccount: null, approvalSetting: {}, settingError: '', cancelling: {}, declined: {},
      })
    },

    clearFinished: () => {
      const p = get().phase
      if (p === 'placed' || p === 'rejected') get().reset()
    },

    reset: () => {
      if (get().phase === 'placing') return
      seq++
      set({ phase: 'idle', ...CLEAR })
    },

    ticketEdited: (key) => {
      const s = get()
      if (key === s.reviewKey) return
      if (s.phase === 'reviewed') set({ phase: 'idle', ...CLEAR })
      else if (s.phase === 'reviewing') {
        seq++
        set({ phase: 'idle', ...CLEAR })
      }
    },

    cancelOrder: async (o) => {
      if (!isCancelable(o) || get().cancelling[o.id]) return false
      const account = useRhStore.getState().account
      if (!account) return false
      let accepted = false
      set((s) => ({ cancelling: { ...s.cancelling, [o.id]: true }, actionNote: '' }))
      try {
        const ok = o.asset === 'option' ? await api.rhCancelOptionOrder(account, o.id) : await api.rhCancelEquityOrder(account, o.id)
        accepted = ok === true
        set({ actionNote: ok ? 'Cancel requested.' : 'Robinhood did not accept the cancel.' })
        void useRhStore.getState().loadPositions()
      } catch (e) {
        set({ actionNote: `Cancel failed: ${msg(e)}` })
      } finally {
        set((s) => {
          const { [o.id]: _gone, ...rest } = s.cancelling
          void _gone
          return { cancelling: rest }
        })
        // cancel returns only {accepted} and is asynchronous: the new state comes from re-reading orders.
        await useRhStore.getState().loadOrders()
      }
      return accepted
    },

    declineApproval: async (account, approvalId) => {
      const myEpoch = wipeEpoch
      try {
        await api.rhDeclineTradeApproval(account, approvalId)
        set((s) => ({ declined: { ...s.declined, [approvalId]: true }, actionNote: 'Approval withdrawn.' }))
      } catch (e) {
        set({ actionNote: `Decline failed: ${msg(e)}` })
      }
      if (myEpoch !== wipeEpoch) return
      await get().refreshApprovals(account)
      void useRhStore.getState().loadOrders()
    },

    refreshApprovals: async (account) => {
      const myEpoch = wipeEpoch
      try {
        const r = await api.rhTradeApprovals(account, 'pending')
        if (myEpoch === wipeEpoch) set({ approvals: r.approvals, approvalsAccount: account, approvalsError: '' })
      } catch (e) {
        if (myEpoch === wipeEpoch) set({ approvalsError: msg(e) })
      }
    },

    loadApprovalSetting: async (account) => {
      const myEpoch = wipeEpoch
      try {
        const r = await api.rhTradeApprovalSetting(account)
        if (myEpoch !== wipeEpoch) return
        set((s) => ({ approvalSetting: { ...s.approvalSetting, [account]: r.setting.human_must_approve_trades }, settingError: '' }))
      } catch (e) {
        if (myEpoch === wipeEpoch) set((s) => ({ approvalSetting: { ...s.approvalSetting, [account]: null }, settingError: msg(e) }))
      }
    },
  }
})
