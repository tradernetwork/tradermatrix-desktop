import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake, fakeLlm } from '../src/lib/api'
import { CLI_FAKE_REGISTRY, cliCards, cliTerms, fakeCliDetect, foundLine, orderProviders, PROVIDERS, providerInfo, type CliDetect } from '../src/lib/llmProviders'
import { useExplainStore } from '../src/stores/explain'

const rust = (f: string) => readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'llm', f), 'utf8')
const src = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8')
const ALL = ['claude', 'codex', 'gemini', 'agy', 'opencode', 'hermes', 'openclaw']
const st = () => useExplainStore.getState()

beforeEach(() => {
  fake.reset()
  fakeLlm.reset()
  useExplainStore.getState().reset()
})

describe('fake registry mirrors the Rust registry', () => {
  it('has the same 25 ids in the same order, the same binaries, and the same reason and terms text', () => {
    const r = rust('cli_registry.rs')
    const ids = [...r.matchAll(/^\s+id: "([^"]+)",/gm)].map((m) => m[1]!).concat([...r.matchAll(/^\s+e\("([^"]+)",/gm)].map((m) => m[1]!))
    expect(CLI_FAKE_REGISTRY.map((e) => e.id).sort()).toEqual(ids.sort())
    expect(CLI_FAKE_REGISTRY).toHaveLength(25)
    expect(CLI_FAKE_REGISTRY.map((e) => e.id).slice(0, 7)).toEqual(ALL)
    const noSwitch = /const NO_SWITCH: &str = "([^"]+)"/.exec(r)![1]!
    const note = /const NOTE: &str = "([^"]+)"/.exec(r)![1]!
    for (const e of CLI_FAKE_REGISTRY) {
      for (const b of e.binaries) expect(r, `${e.id} ${b}`).toContain(`"${b}"`)
      if (e.support !== 'usable') expect(r.includes(`"${e.reason}"`) || e.reason === noSwitch, e.id).toBe(true)
      expect(r.includes(`"${e.terms}"`) || e.terms === note, `${e.id} terms`).toBe(true)
    }
    expect(CLI_FAKE_REGISTRY.filter((e) => e.support === 'usable').map((e) => e.id)).toEqual(['claude'])
    expect(CLI_FAKE_REGISTRY.filter((e) => e.support === 'experimental').map((e) => e.id)).toEqual(['hermes'])
  })
  it('the provider table gained exactly hermes_cli and mirrors its Rust preset', () => {
    expect(PROVIDERS.map((p) => p.id)).toContain('hermes_cli')
    expect(providerInfo('hermes_cli')).toMatchObject({ http: false, takesKey: false, needsKey: false, baseUrl: '', defaultModel: '' })
  })
})

describe('cards for found CLIs', () => {
  const found = (ids: string[], pub = false): CliDetect => fakeCliDetect(ids, pub)
  it('Review Focus 1: codex and every other detect-only CLI shows "Found, not supported: <reason>" and has no provider card', () => {
    const cards = cliCards(found(ALL), false)
    expect(cards.map((c) => c.id)).toEqual(['codex', 'gemini', 'agy', 'opencode', 'hermes', 'openclaw'])
    const codex = cards.find((c) => c.id === 'codex')!
    expect(codex.state).toBe('unsupported')
    expect(foundLine(codex)).toBe(`Found, not supported: ${codex.reason}`)
    expect(codex.reason.length).toBeGreaterThan(15)
    expect(cards.filter((c) => c.state === 'unsupported').every((c) => !!c.terms)).toBe(true)
    // none of them can become a provider card
    for (const id of ['codex', 'gemini', 'agy', 'opencode', 'openclaw']) expect(providerInfo(id)).toBeNull()
    const o = orderProviders({ claude_cli: false, ollama: false, lmstudio: false }, found(ALL), true).map((c) => c.info.id)
    expect(o.filter((i) => ['codex', 'gemini', 'agy', 'opencode', 'openclaw'].includes(i))).toEqual([])
  })
  it('hermes is "Found, experimental (off)" until the switch is on, then it becomes a usable provider card', () => {
    const off = cliCards(found(['hermes']), false)
    expect(off).toHaveLength(1)
    expect(foundLine(off[0]!)).toBe('Found, experimental (off)')
    expect(orderProviders(null, found(['hermes']), false).some((c) => c.info.id === 'hermes_cli')).toBe(false)
    expect(cliCards(found(['hermes']), true)).toEqual([])
    const on = orderProviders({ claude_cli: false, ollama: false, lmstudio: false }, found(['hermes']), true)
    expect(on[0]!.info.id).toBe('hermes_cli')
    expect(on[0]!.found).toBe(true)
    // switch on but hermes is not installed: no card at all
    expect(orderProviders(null, found(['claude']), true).some((c) => c.info.id === 'hermes_cli')).toBe(false)
  })
  it('claude stays the usable provider card, with its vendor terms line', () => {
    const d = found(['claude'])
    expect(cliCards(d, false)).toEqual([])
    const o = orderProviders({ claude_cli: true, ollama: false, lmstudio: false }, d, false)
    expect(o[0]!.info.id).toBe('claude_cli')
    expect(cliTerms('claude_cli', d)).toContain("Anthropic's terms")
    expect(cliTerms('openrouter', d)).toBe('')
  })
  it('Task 8: in a public build every CLI card is hidden, whatever the switch says', () => {
    const d = found(ALL, true)
    expect(cliCards(d, true)).toEqual([])
    const ids = orderProviders({ claude_cli: true, ollama: false, lmstudio: false }, d, true).map((c) => c.info.id)
    expect(ids).not.toContain('claude_cli')
    expect(ids).not.toContain('hermes_cli')
    expect(ids).toContain('openrouter')
  })
})

describe('fake backend mirrors the Rust gates', () => {
  it('refuses unsupported providers and the experimental card without the switch', async () => {
    for (const p of ['codex', 'gemini', 'opencode_cli']) expect(() => fakeLlm.set(p, null, null, null, null)).toThrow('bad_request')
    expect(() => fakeLlm.set('hermes_cli', null, null, null, null)).toThrow('bad_request')
    fake.settingSet('llm.experimentalCli', 'true')
    expect(fakeLlm.set('hermes_cli', null, null, null, null).provider).toBe('hermes_cli')
    expect(() => fakeLlm.set('hermes_cli', 'https://x.example.com', null, null, null)).toThrow('bad_request')
    expect(() => fakeLlm.set('hermes_cli', null, 'sk-test-KEY', null, null)).toThrow('bad_request')
  })
  it('api calls use exactly the four new commands, and no command takes or returns a key', () => {
    const a = src('lib/api.ts')
    for (const c of ['llm_cli_detect', 'llm_cli_check_version', 'llm_openrouter_login_start', 'llm_openrouter_login_status']) expect(a).toContain(`'${c}'`)
    expect(a).toContain("export const WEBVIEW_SLOTS = ['tm_api_key'] as const")
  })
})

describe('store: detection and version check', () => {
  it('runCliDetect fills the list; Check version is explicit and per CLI', async () => {
    fakeLlm.cliFound = ['codex', 'claude']
    await st().runCliDetect()
    expect(st().cliDetect!.found.map((f) => f.id)).toEqual(['claude', 'codex'])
    expect(fakeLlm.versionCalls).toEqual([])
    await st().checkVersion('codex')
    expect(fakeLlm.versionCalls).toEqual(['codex'])
    expect(st().versions.codex).toMatch(/^fake /)
    await st().checkVersion('gemini')
    expect(st().versions.gemini).toBe('Could not read a version.')
  })
  it('the experimental switch is stored as the llm.experimentalCli setting and wiped with reset', async () => {
    expect(st().experimental).toBe(false)
    await st().setExperimental(true)
    expect(fake.settingGet('llm.experimentalCli')).toBe('true')
    expect(st().experimental).toBe(true)
    st().reset()
    expect(st().experimental).toBe(false)
    await st().loadExperimental()
    expect(st().experimental).toBe(true)
    await st().setExperimental(false)
    expect(fake.settingGet('llm.experimentalCli')).toBe('false')
  })
})

describe('store: Sign in with OpenRouter', () => {
  it('pending, then done: the sealed key lands in the config and the webview never sees it', async () => {
    fakeLlm.orLogin = 'done'
    expect(st().orLogin.phase).toBe('idle')
    const p = st().startOrLogin(5)
    await new Promise((r) => setTimeout(r, 1))
    expect(st().orLogin.phase).toBe('pending')
    expect(st().orLogin.url).toMatch(/^https:\/\/openrouter\.ai\/auth\?/)
    await p
    expect(st().orLogin.phase).toBe('done')
    expect(st().config).toMatchObject({ provider: 'openrouter', key_present: true })
    const all = JSON.stringify({ ...st(), turns: undefined })
    expect(all).not.toMatch(/sk-or-/)
  })
  it('failed and expired are plain phases with plain words; a stuck login can be stopped waiting for', async () => {
    fakeLlm.orLogin = 'failed'
    await st().startOrLogin(5)
    expect(st().orLogin.phase).toBe('failed')
    expect(st().config?.key_present).toBeFalsy()
    fakeLlm.orLogin = 'expired'
    await st().startOrLogin(5)
    expect(st().orLogin.phase).toBe('expired')
    fakeLlm.orLogin = 'pending'
    const p = st().startOrLogin(5)
    await new Promise((r) => setTimeout(r, 30))
    expect(st().orLogin.phase).toBe('pending')
    st().stopOrLogin()
    await p
    expect(st().orLogin.phase).toBe('idle')
  })
  it('a second click while pending starts nothing new', async () => {
    fakeLlm.orLogin = 'pending'
    const p = st().startOrLogin(5)
    await new Promise((r) => setTimeout(r, 10))
    const n = fakeLlm.loginStarts
    await st().startOrLogin(5)
    expect(fakeLlm.loginStarts).toBe(n)
    st().stopOrLogin()
    await p
  })
  it('api.ts has no key anywhere in the login calls', async () => {
    const s = await api.llmOpenrouterLoginStart()
    expect(Object.keys(s).sort()).toEqual(['pending_id', 'url'])
    expect(['pending', 'done', 'expired', 'failed']).toContain(await api.llmOpenrouterLoginStatus(s.pending_id))
  })
})
