import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { fake, fakeLlm } from '../src/lib/api'
import { RH_SCOPE_NOTE } from '../src/lib/brand'
import { CLAUDE_CLI_TERMS, cliCards, cliTerms, fakeCliDetect, keyHelpText, keyShapeError, orderProviders, providerInfo, validateSetup, type CliDetect } from '../src/lib/llmProviders'
import { ADVANCED_CLI_KEY, useExplainStore } from '../src/stores/explain'
import { ExplainSetup } from '../src/workspace/ExplainSetup'

const src = (...p: string[]) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf8')
const rust = (f: string) => readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'llm', f), 'utf8')
const st = () => useExplainStore.getState()
const NONE = { provider: null, base_url: null, model: null, key_present: false }
const ANTH_KEY = 'sk-ant-TESTKEY'
const TERMS = "Uses your installed Claude (your own login). Usage counts against your own Claude plan and is subject to Anthropic's terms."

beforeEach(() => {
  fake.reset()
  fakeLlm.reset()
  st().reset()
})

describe('Anthropic provider card (data, mirrors the Rust preset)', () => {
  it('has the documented facts: fixed https host, key help as plain text, a docs model, no invented price', () => {
    const a = providerInfo('anthropic')!
    expect(a).toMatchObject({ id: 'anthropic', label: 'Anthropic', http: true, needsKey: true, takesKey: true, urlEditable: false, baseUrl: 'https://api.anthropic.com', keyHelpUrl: 'https://console.anthropic.com', defaultModel: 'claude-haiku-5-5', priceHint: 'price depends on your plan' })
    expect(a.blurb).toBe('Use your own Anthropic API key.')
    expect(a.models).toContain('claude-haiku-5-5')
    expect(a.models.length).toBeGreaterThanOrEqual(2)
    expect(a.priceHint).not.toContain('$')
    expect(keyHelpText(a.keyHelpUrl)).toBe('console.anthropic.com')
    const r = rust('provider.rs')
    const line = r.split('\n').find((l) => l.includes('id: "anthropic"'))!
    expect(line).toContain('Profile::Anthropic')
    expect(line).toContain(`blurb: "${a.blurb}"`)
  })
  it('sits in the same table position as in Rust (after Venice, before the local cards)', () => {
    const ids = [...rust('provider.rs').matchAll(/Preset \{ id: "([^"]+)"/g)].map((m) => m[1]!)
    expect(ids).toContain('anthropic')
    const web = orderProviders(null).map((c) => c.info.id)
    expect(web.indexOf('anthropic')).toBe(web.indexOf('venice') + 1)
  })
  it('key shape: sk-ant- prefix (the generic rules still apply)', () => {
    const a = providerInfo('anthropic')!
    expect(keyShapeError(a, '')).toMatch(/Paste your Anthropic key/)
    expect(keyShapeError(a, 'sk-test-KEY')).toMatch(/sk-ant-/)
    expect(keyShapeError(a, 'sk-or-TESTKEY')).toMatch(/sk-ant-/)
    expect(keyShapeError(a, 'sk-ant-')).toMatch(/sk-ant-/)
    expect(keyShapeError(a, 'sk-ant- x')).toMatch(/spaces/)
    expect(keyShapeError(a, ANTH_KEY)).toBeNull()
    expect(validateSetup(a, { key: ANTH_KEY, baseUrl: '', model: '' }, NONE)).toBeNull()
    expect(validateSetup(a, { key: '', baseUrl: '', model: '' }, NONE)).toMatch(/Paste your Anthropic key/)
    expect(validateSetup(a, { key: ANTH_KEY, baseUrl: '', model: 'bad model!' }, NONE)).toMatch(/Model names/)
  })
})

describe('Anthropic through the fake backend (same rules as config.rs)', () => {
  it('saves with an sk-ant- key, refuses another shape, another base URL and a key-less swap', () => {
    expect(() => fakeLlm.set('anthropic', null, 'sk-test-KEY', null, null)).toThrow('bad_request')
    expect(() => fakeLlm.set('anthropic', 'https://evil.example.com', ANTH_KEY, null, null)).toThrow('bad_request')
    expect(() => fakeLlm.set('anthropic', 'http://api.anthropic.com', ANTH_KEY, null, null)).toThrow('bad_request')
    expect(fakeLlm.status().provider).toBeNull()
    const s = fakeLlm.set('anthropic', 'https://api.anthropic.com/', ANTH_KEY, null, null)
    expect(s).toMatchObject({ provider: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-haiku-5-5', key_present: true })
    expect(JSON.stringify(s)).not.toContain('sk-ant')
    for (const [p, url] of [['custom', 'https://evil.example.com/v1'], ['openai', null], ['openrouter', null]] as const) expect(() => fakeLlm.set(p, url, null, null, null), p).toThrow('bad_request')
    expect(fakeLlm.status().provider).toBe('anthropic')
  })
  it('the key never appears in the store after a save', async () => {
    const e = await st().saveConfig({ provider: 'anthropic', baseUrl: null, apiKey: ANTH_KEY, model: null, compat: false, lanHttp: null })
    expect(e).toBe('')
    expect(JSON.stringify({ ...st(), turns: undefined })).not.toContain('sk-ant')
    expect(st().config).toMatchObject({ provider: 'anthropic', key_present: true })
  })
})

describe('Review Focus 3: public-build gating in the cards', () => {
  const d = (ids: string[], pub: boolean): CliDetect => fakeCliDetect(ids, pub)
  const NO_DETECT = { claude_cli: true, ollama: false, lmstudio: false }
  const ids = (cli: CliDetect, exp: boolean, adv: boolean) => orderProviders(NO_DETECT, cli, exp, adv).map((c) => c.info.id)
  it('public build + Advanced off: neither CLI card nor any found-CLI note exists', () => {
    const cli = d(['claude', 'hermes', 'codex'], true)
    expect(ids(cli, true, false)).not.toContain('claude_cli')
    expect(ids(cli, true, false)).not.toContain('hermes_cli')
    expect(cliCards(cli, true, false)).toEqual([])
    expect(ids(cli, true, false)).toContain('anthropic')
  })
  it('public build + Advanced on: the Claude card appears; hermes still needs found + the experimental switch', () => {
    const cli = d(['claude', 'hermes', 'codex'], true)
    expect(ids(cli, false, true)).toContain('claude_cli')
    expect(ids(cli, false, true)).not.toContain('hermes_cli')
    expect(ids(cli, true, true)).toContain('hermes_cli')
    expect(cliCards(cli, false, true).map((c) => c.id)).toEqual(['codex', 'hermes'])
  })
  it('personal build (feature off): exactly as before, the Advanced switch changes nothing', () => {
    const cli = d(['claude', 'hermes', 'codex'], false)
    for (const adv of [false, true]) {
      expect(ids(cli, false, adv)).toContain('claude_cli')
      expect(ids(cli, false, adv)).not.toContain('hermes_cli')
      expect(ids(cli, true, adv)).toContain('hermes_cli')
      expect(cliCards(cli, false, adv).map((c) => c.id)).toEqual(['codex', 'hermes'])
    }
  })
  it('the CLI card wording is exact, never says Claude Code, and the terms line survives a CLI that was not found', () => {
    expect(CLAUDE_CLI_TERMS).toBe(TERMS)
    expect(cliTerms('claude_cli', d(['claude'], true))).toBe(TERMS)
    expect(cliTerms('claude_cli', d([], true))).toBe(TERMS)
    expect(cliTerms('claude_cli', null)).toBe(TERMS)
    expect(cliTerms('openrouter', d(['claude'], true))).toBe('')
    expect(rust('cli_registry.rs')).toContain(TERMS)
    for (const f of ['lib/llmProviders.ts', 'workspace/ExplainSetup.tsx', 'stores/explain.ts']) expect(src(f), f).not.toMatch(/Claude Code/)
  })
  it('the fake backend refuses the CLI saves exactly like Rust', () => {
    fakeLlm.publicBuild = true
    expect(() => fakeLlm.set('claude_cli', null, null, null, null)).toThrow('bad_request')
    fake.settingSet('llm.experimentalCli', 'true')
    expect(() => fakeLlm.set('hermes_cli', null, null, null, null)).toThrow('bad_request')
    fake.settingSet(ADVANCED_CLI_KEY, 'true')
    expect(fakeLlm.set('claude_cli', null, null, null, null).provider).toBe('claude_cli')
    expect(fakeLlm.set('hermes_cli', null, null, null, null).provider).toBe('hermes_cli')
    fake.settingSet(ADVANCED_CLI_KEY, 'false')
    expect(() => fakeLlm.set('claude_cli', null, null, null, null)).toThrow('bad_request')
    // personal build: claude works with Advanced off
    fakeLlm.publicBuild = false
    expect(fakeLlm.set('claude_cli', null, null, null, null).provider).toBe('claude_cli')
  })
})

describe('store: the llm.advancedCli setting', () => {
  it('is stored as JSON under llm.advancedCli, defaults off, loads, and is wiped from memory by reset', async () => {
    expect(ADVANCED_CLI_KEY).toBe('llm.advancedCli')
    expect(st().advancedCli).toBe(false)
    await st().setAdvancedCli(true)
    expect(fake.settingGet('llm.advancedCli')).toBe('true')
    expect(st().advancedCli).toBe(true)
    st().reset()
    expect(st().advancedCli).toBe(false)
    await st().loadAdvancedCli()
    expect(st().advancedCli).toBe(true)
    await st().setAdvancedCli(false)
    expect(fake.settingGet('llm.advancedCli')).toBe('false')
  })
})

describe('ExplainSetup rendering', () => {
  // react-dom/server reads zustand's INITIAL state object, so the tests seed that object in place and restore it afterwards
  const render = (seed: Record<string, unknown>) => {
    const init = useExplainStore.getInitialState() as unknown as Record<string, unknown>
    const backup = { ...init }
    Object.assign(init, seed)
    try {
      return renderToStaticMarkup(createElement(ExplainSetup))
    } finally {
      Object.assign(init, backup)
    }
  }
  const cfg = (provider: string | null) => ({ provider, base_url: null, model: null, compat: false, key_present: false, lan_http: false })
  const claudeDetect = { claude_cli: true, ollama: false, lmstudio: false }
  it('the Anthropic card says what it is, shows the price line and the key help as plain text', () => {
    const html = render({ config: cfg('anthropic'), cliDetect: fakeCliDetect([], true), detect: null })
    expect(html).toContain('Use your own Anthropic API key.')
    expect(html).toContain('price depends on your plan')
    expect(html).toContain('Get a key at <code>console.anthropic.com</code>')
    expect(html).toContain('Anthropic API key')
    expect(html).not.toMatch(/<a[\s>]/)
    expect(html).not.toContain('sk-ant')
    expect(html).not.toMatch(/Claude Code/)
  })
  it('public build + Advanced off: the card list has no CLI card and the toggle is offered, unchecked', () => {
    const html = render({ config: cfg('anthropic'), cliDetect: fakeCliDetect(['claude', 'codex'], true), detect: claudeDetect, advancedCli: false })
    expect(html).not.toContain('Claude (installed on this computer)')
    expect(html).not.toContain('Also found on this computer')
    expect(html).toContain('Show installed-CLI options')
    expect(html).not.toContain(TERMS.replace("'", '&#x27;'))
  })
  it('public build + Advanced on: the Claude card shows with the exact terms line', () => {
    const html = render({ config: cfg('claude_cli'), cliDetect: fakeCliDetect(['claude'], true), detect: claudeDetect, advancedCli: true })
    expect(html).toContain('Claude (installed on this computer)')
    expect(html).toContain('Show installed-CLI options')
    expect(html).toContain(TERMS.replace("'", '&#x27;'))
  })
  it('personal build: no Advanced toggle for the CLI cards, the Claude card as today', () => {
    const html = render({ config: cfg('claude_cli'), cliDetect: fakeCliDetect(['claude'], false), detect: claudeDetect, advancedCli: false })
    expect(html).toContain('Claude (installed on this computer)')
    expect(html).not.toContain('Show installed-CLI options')
  })
})

describe('explain-only: the new provider surface touches no order tooling', () => {
  it('the Rust Anthropic module and the chat files stay clear of order words and Claude credentials', () => {
    const a = rust('anthropic.rs')
    for (const bad of ['rh::', 'McpClient', 'place_', 'review_', 'cancel_', 'decline_', 'TmState', '.credentials', 'CLAUDE_CODE_OAUTH_TOKEN', 'setup-token', 'Bearer']) expect(a, bad).not.toContain(bad)
    for (const f of ['lib/llmProviders.ts', 'workspace/ExplainSetup.tsx', 'stores/explain.ts', 'workspace/chatDev.tsx']) {
      const s = src(f)
      for (const bad of ['.credentials', 'CLAUDE_CODE_OAUTH_TOKEN', 'setup-token', 'Sign in with Claude']) expect(s, `${f} ${bad}`).not.toContain(bad)
    }
  })
  it('no new Tauri command: api.ts calls the same llm_config_set and the webview slots stay tm_api_key only', () => {
    const a = src('lib/api.ts')
    expect(a).toContain("'llm_config_set'")
    expect(a).toContain("export const WEBVIEW_SLOTS = ['tm_api_key'] as const")
    expect(a).not.toMatch(/'llm_anthropic|'anthropic_/)
  })
})

describe('Task 6: Robinhood scope note', () => {
  it('is one exact line, shown on the Connect Robinhood screen and in About', () => {
    expect(RH_SCOPE_NOTE).toBe('Robinhood read access reaches all your accounts; trading is limited to the dedicated agentic account.')
    expect(RH_SCOPE_NOTE).not.toMatch(/[–—]/)
    expect(src('workspace/ConnectButton.tsx')).toContain('RH_SCOPE_NOTE')
    expect(src('workspace/AboutDialog.tsx')).toContain('RH_SCOPE_NOTE')
  })
})
