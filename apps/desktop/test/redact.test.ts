import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake, fakeExplain, fakeLlm, fakeThreads } from '../src/lib/api'
import { ERROR_CODES, ERROR_TEXT } from '../src/lib/explainPrompt'
import { redactSecrets, looksLikeSecret } from '../src/lib/redact'
import { useChartContext } from '../src/stores/chartContext'
import { useExplainStore } from '../src/stores/explain'
import { useRhStore } from '../src/stores/rh'

// The same vectors as src-tauri/src/redact.rs (M16 B7): the webview refuses to send a pasted key, Rust redacts what is stored.
const R = '[redacted]'
const SK = 'sk-proj-abcdefghijklmnop1234'
const OR = 'sk-or-v1-0123456789abcdef0123456789abcdef'
const HEX = '0123456789abcdef0123456789abcdef'
const B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5'

describe('redactSecrets (mirror of redact.rs)', () => {
  it('sk- and sk-or- keys', () => {
    expect(redactSecrets(`my key is ${SK} ok`)).toBe(`my key is ${R} ok`)
    expect(redactSecrets(OR)).toBe(R)
    expect(redactSecrets(`(${OR})`)).toBe(`(${R})`)
    expect(redactSecrets(`a ${SK}\n${OR} b`)).toBe(`a ${R}\n${R} b`)
    expect(redactSecrets('sk-0123456789abcdef')).toBe(R)
    expect(redactSecrets('sk-0123456789abcde')).toBe('sk-0123456789abcde')
  })
  it('Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghij0123456789xyz')).toBe(`Authorization: ${R}`)
    expect(redactSecrets('bearer ABCDEFGHIJ.0123456789-xyz_==')).toBe(R)
    expect(redactSecrets('Bearer short')).toBe('Bearer short')
    expect(redactSecrets('a Bearer of bad news and a very long sentence follows')).toBe('a Bearer of bad news and a very long sentence follows')
  })
  it('td_live_ keys', () => {
    expect(redactSecrets('td_live_AbCd1234')).toBe(R)
    expect(redactSecrets('use td_live_AbCd1234efgh please')).toBe(`use ${R} please`)
    expect(redactSecrets('td_live_short')).toBe('td_live_short')
  })
  it('long runs after key / token / secret', () => {
    expect(redactSecrets(`api key: ${HEX}`)).toBe(`api key: ${R}`)
    expect(redactSecrets(`token=${B64}`)).toBe(`token=${R}`)
    expect(redactSecrets(`the secret is "${HEX}".`)).toBe(`the secret is "${R}".`)
    expect(redactSecrets(`API_KEY=${HEX}`)).toBe(`API_KEY=${R}`)
    expect(redactSecrets(`Secret ${B64}`)).toBe(`Secret ${R}`)
    const short = '0123456789abcdef0123456789abcde'
    expect(redactSecrets(`key ${short}`)).toBe(`key ${short}`)
  })
  it('ordinary text is untouched, a 40-char git sha in prose is allowed', () => {
    for (const s of [
      'The last price is 187.32 and the high is 189.10.',
      'What is IV rank 72 telling me at the 95 strike?',
      'risk-reward-ratio-calculation-example-with-long-words',
      'ask-me-anything-about-the-chart-and-its-levels',
      'task-list-of-things-that-are-long-enough-to-matter',
      'sk-',
      'sk-abc',
      'the key level is 187.32',
      'token 12345',
      'keyboard 0123456789abcdef0123456789abcdef0123',
      '',
    ])
      expect(redactSecrets(s), s).toBe(s)
    const sha = '3f2a9c1b7d4e5f60718293a4b5c6d7e8f9012345'
    expect(sha).toHaveLength(40)
    expect(redactSecrets(`The fix landed in commit ${sha} last week.`)).toBe(`The fix landed in commit ${sha} last week.`)
  })
  it('idempotent, unicode safe and linear', () => {
    const all = `a ${SK} b Bearer abcdefghij0123456789xyz c td_live_AbCd1234 d token=${'0123456789abcdef'.repeat(2)}`
    const once = redactSecrets(all)
    expect(once).not.toMatch(/sk-|td_live|abcdefghij0123456789xyz/)
    expect(redactSecrets(once)).toBe(once)
    expect(redactSecrets('café \u{1f4c8} price 187.32 — 中文')).toBe('café \u{1f4c8} price 187.32 — 中文')
    const big = 'ab12 '.repeat(200_000)
    expect(redactSecrets(big)).toBe(big)
    expect(looksLikeSecret(`is ${OR} my key`)).toBe(true)
    expect(looksLikeSecret('what is the IV rank at 187.32?')).toBe(false)
  })
})

describe('the store refuses to send a pasted key', () => {
  beforeEach(async () => {
    fake.reset()
    useExplainStore.getState().reset()
    useChartContext.setState({ chart: null, overlays: null, fib: null, strike: null })
    useRhStore.getState().wipe()
    fakeLlm.set('openrouter', null, 'sk-or-TESTKEY', null, null)
    await useExplainStore.getState().loadConfig()
  })
  it('nothing is sent, nothing is saved, the message is plain', async () => {
    expect(ERROR_CODES as readonly string[]).toContain('key_like')
    expect(ERROR_TEXT.key_like).toBe('That looks like an API key. I did not send it.')
    for (const q of [`is ${OR} my key?`, `Bearer abcdefghij0123456789xyz`, `td_live_AbCd1234 works?`, `token=${HEX}`]) {
      const ok = await useExplainStore.getState().ask(q)
      expect(ok, q).toBe(false)
      expect(useExplainStore.getState().error, q).toBe('key_like')
      expect(useExplainStore.getState().turns).toHaveLength(0)
    }
    expect(fakeExplain.calls).toHaveLength(0)
    expect((await api.explainThreadList(null)).length).toBe(0)
    expect(fakeThreads).toBeTruthy()
    // a normal question still goes (and clears the error)
    expect(await useExplainStore.getState().ask('What is IV rank at 187.32?')).toBe(true)
    expect(useExplainStore.getState().error).toBe('')
    expect(fakeExplain.calls).toHaveLength(1)
  })
})
