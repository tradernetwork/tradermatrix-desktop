import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake } from '../src/lib/api'
import { gateMode, useVaultStore } from '../src/stores/vault'

beforeEach(() => {
  fake.reset()
  useVaultStore.setState({ status: null, busy: false, error: '' })
})

describe('gateMode', () => {
  it('is hidden for the keyring backend, before status loads, and when unlocked', () => {
    expect(gateMode(null)).toBe('hidden')
    expect(gateMode({ exists: false, unlocked: false, backend: 'secret-service' })).toBe('hidden')
    expect(gateMode({ exists: true, unlocked: true, backend: 'vault' })).toBe('hidden')
  })
  it('asks to create when no file, to unlock when one exists', () => {
    expect(gateMode({ exists: false, unlocked: false, backend: 'vault' })).toBe('create')
    expect(gateMode({ exists: true, unlocked: false, backend: 'vault' })).toBe('unlock')
  })
})

describe('vault store against the fake api', () => {
  it('create flow: mismatch rejected, short rejected, then unlocked', async () => {
    const s = useVaultStore.getState()
    await s.refresh()
    expect(gateMode(useVaultStore.getState().status)).toBe('create')
    expect(await s.create('longenough1', 'different1')).toBe(false)
    expect(useVaultStore.getState().error).toMatch(/do not match/)
    expect(await s.create('short', 'short')).toBe(false)
    expect(useVaultStore.getState().error).toMatch(/at least 8/)
    expect(await s.create('longenough1', 'longenough1')).toBe(true)
    expect(useVaultStore.getState().error).toBe('')
    expect(gateMode(useVaultStore.getState().status)).toBe('hidden')
  })
  it('lock then unlock: wrong passphrase keeps the gate up with a message', async () => {
    await api.vaultCreate('longenough1')
    const s = useVaultStore.getState()
    await s.lock()
    expect(gateMode(useVaultStore.getState().status)).toBe('unlock')
    expect(await s.unlock('wrongwrong')).toBe(false)
    expect(useVaultStore.getState().error).toMatch(/wrong vault passphrase/)
    expect(gateMode(useVaultStore.getState().status)).toBe('unlock')
    expect(await s.unlock('longenough1')).toBe(true)
    expect(gateMode(useVaultStore.getState().status)).toBe('hidden')
    expect(useVaultStore.getState().busy).toBe(false)
  })
  it('create refuses when a vault already exists', async () => {
    await api.vaultCreate('longenough1')
    await expect(api.vaultCreate('anotherpass1')).rejects.toThrow(/already exists/)
  })
})
