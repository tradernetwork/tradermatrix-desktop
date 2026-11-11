/**
 * Session wipe. Disconnect and Lock vault both call this FIRST, so nothing from the old session stays on screen,
 * nothing keeps polling, and a response that lands afterwards is dropped (each store checks an epoch).
 */
import { useAlertsStore } from './alerts'
import { useEarningsStore } from './earnings'
import { useExplainStore } from './explain'
import { useJournalStore } from './journal'
import { useOrdersStore } from './orders'
import { useRhStore } from './rh'
import { useRiskStore } from './risk'
import { useTicketIntentStore } from './ticketIntent'
import { useTmStore } from './tm'

export function wipeSession(): void {
  useRhStore.getState().wipe()
  useOrdersStore.getState().wipe()
  useTmStore.getState().wipe()
  useEarningsStore.getState().wipe()
  // alerts are local data and stay; only toasts and the spam window go
  useAlertsStore.getState().wipe()
  // Explain chat: the transcript can quote positions the user opted in; it goes with the session.
  useExplainStore.getState().wipe()
  // A queued ticket fill carries symbols/sizes from the old session.
  useTicketIntentStore.getState().clear()
  // Journal: P&L, trades and exports are Robinhood data and go. Notes are local SQLite (not session data), so the list is re-read.
  useJournalStore.getState().reset()
  // R tools: the joined stats and the held trade list came from Robinhood and go; stored R and drafts are local data.
  useRiskStore.getState().wipe()
  void useJournalStore.getState().loadNotes()
}

/** Disconnect button: wipe the screen state first, then drop the stored credentials. */
export async function disconnectSession(): Promise<void> {
  wipeSession()
  await useRhStore.getState().disconnect()
}
