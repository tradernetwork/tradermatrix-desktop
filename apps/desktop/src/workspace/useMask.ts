import { useCallback } from 'react'
import { maskKnown } from '../lib/orderUi'
import { useRhStore } from '../stores/rh'

/** Returns a function that masks every known full account number in a server message before it is rendered. */
export function useMask(): (text: string) => string {
  const accounts = useRhStore((s) => s.accounts)
  return useCallback((text: string) => maskKnown(text, accounts.map((a) => a.account_number)), [accounts])
}
