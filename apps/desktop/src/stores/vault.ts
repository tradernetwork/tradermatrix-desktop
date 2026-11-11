import { create } from 'zustand'
import { api, type VaultStatus } from '../lib/api'
import { wipeSession } from './session'

export type GateMode = 'hidden' | 'create' | 'unlock'

/** The gate only appears for the encrypted-vault backend; the OS keyring needs no passphrase. */
export function gateMode(s: VaultStatus | null): GateMode {
  if (!s || s.backend !== 'vault' || s.unlocked) return 'hidden'
  return s.exists ? 'unlock' : 'create'
}

interface VaultState {
  status: VaultStatus | null
  busy: boolean
  error: string
  refresh: () => Promise<void>
  create: (passphrase: string, confirm: string) => Promise<boolean>
  unlock: (passphrase: string) => Promise<boolean>
  lock: () => Promise<void>
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const useVaultStore = create<VaultState>((set, get) => ({
  status: null,
  busy: false,
  error: '',
  refresh: async () => {
    try {
      set({ status: await api.vaultStatus() })
    } catch (e) {
      set({ error: msg(e) })
    }
  },
  create: async (passphrase, confirm) => {
    if (passphrase !== confirm) {
      set({ error: 'passphrases do not match' })
      return false
    }
    set({ busy: true, error: '' })
    try {
      await api.vaultCreate(passphrase)
      await get().refresh()
      set({ busy: false })
      return true
    } catch (e) {
      set({ busy: false, error: msg(e) })
      return false
    }
  },
  unlock: async (passphrase) => {
    set({ busy: true, error: '' })
    try {
      await api.vaultUnlock(passphrase)
      await get().refresh()
      set({ busy: false })
      return true
    } catch (e) {
      set({ busy: false, error: msg(e) })
      return false
    }
  },
  lock: async () => {
    // Locking cuts access to the secrets: nothing derived from them may stay on screen or keep polling.
    wipeSession()
    set({ error: '' })
    try {
      await api.vaultLock()
    } catch (e) {
      set({ error: msg(e) })
    }
    await get().refresh()
  },
}))
