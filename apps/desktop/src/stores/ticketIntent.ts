/**
 * "Fill the order ticket from here" (M10). A fill ONLY sets ticket fields: nothing in this module reviews, places or
 * (except through the existing, tested cancel flow in `cancelAndEdit`) cancels an order. A fill discards any open review
 * through the same edit path as a manual edit (`ticketEdited`), so a fresh review is always required before Place.
 *
 * The latest intent waits in the store until the ticket consumes it (once, within INTENT_TTL_MS): the ticket pane may
 * not be mounted when a fill happens (inactive tab), and a stale intent must never apply minutes later.
 */
import { create } from 'zustand'
import { getActiveDock } from '../workspace/activeDock'
import { isEquityTicker } from '../lib/symbols'
import { intentFromOrder, type TicketIntent } from '../lib/ticketIntent'
import type { RhOrder } from '../lib/api'
import { useOrdersStore } from './orders'

export const INTENT_TTL_MS = 30_000
/** Never equals a real ticket key, so `ticketEdited` always treats it as an edit. */
const FILL_KEY = '__ticket-fill__'

interface IntentState {
  pending: TicketIntent | null
  at: number
  /** Bumped on every fill, so a subscriber re-runs even for an identical intent. */
  seq: number
  put: (i: TicketIntent) => void
  /** Returns the pending intent once (and clears it); null when none or older than the TTL. */
  take: (now?: number) => TicketIntent | null
  clear: () => void
}

export const useTicketIntentStore = create<IntentState>((set, get) => ({
  pending: null,
  at: 0,
  seq: 0,
  put: (i) => set((s) => ({ pending: i, at: Date.now(), seq: s.seq + 1 })),
  take: (now = Date.now()) => {
    const { pending, at } = get()
    if (!pending) return null
    set({ pending: null })
    return now - at <= INTENT_TTL_MS ? pending : null
  },
  clear: () => set({ pending: null }),
}))

const symbolOk = (i: TicketIntent): boolean => isEquityTicker(i.kind === 'equity' ? i.symbol : i.underlying)

/** Brings the ticket panel to the front when it is open in the dock (no-op otherwise or in a page without a dock). */
function showTicketPanel(): void {
  try {
    getActiveDock()?.getPanel('ticket')?.api.setActive()
  } catch {
    // focusing is a convenience only
  }
}

/** Queue a fill. false = refused (bad symbol). Discards any open review and a finished result card; never places anything. */
export function fillTicket(intent: TicketIntent): boolean {
  if (!symbolOk(intent)) return false
  const orders = useOrdersStore.getState()
  orders.clearFinished()
  orders.ticketEdited(FILL_KEY)
  useTicketIntentStore.getState().put(intent)
  showTicketPanel()
  return true
}

/**
 * Cancel an open order, then (only if the cancel was accepted) fill the ticket from it. The cancel goes through the
 * existing `cancelOrder` flow; a failed cancel fills nothing. Orders that cannot be rebuilt on the ticket (multi-leg,
 * unknown side) are not cancelled at all. true = cancelled and filled.
 */
export async function cancelAndEdit(o: RhOrder): Promise<boolean> {
  const intent = intentFromOrder(o)
  if (!intent) {
    useOrdersStore.setState({ actionNote: 'This order cannot be edited on the ticket (multi-leg or unsupported). Use Cancel.' })
    return false
  }
  const cancelled = await useOrdersStore.getState().cancelOrder(o)
  if (!cancelled) return false
  return fillTicket(intent)
}
