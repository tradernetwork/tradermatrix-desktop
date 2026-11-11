import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, ERROR_TEXT } from '../src/lib/explainPrompt'
import { effectiveUrl, needsKeyAgain, orderProviders, PROVIDERS, providerInfo, validateBaseUrlText, validateSetup, type SetupStatus } from '../src/lib/llmProviders'

const rust = (f: string) => readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'llm', f), 'utf8')
const NONE: SetupStatus | null = null
const saved = (provider: string, base_url: string | null, model: string | null = null): SetupStatus => ({ provider, base_url, model, key_present: true })

describe('provider table', () => {
  it('has unique ids and mirrors the Rust preset table (ids, URLs, key flags)', () => {
    const ids = PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    const lines = rust('provider.rs').split('\n').filter((l) => l.trim().startsWith('Preset { id:'))
    expect(lines).toHaveLength(PROVIDERS.length)
    for (const l of lines) {
      const id = /id: "([^"]*)"/.exec(l)![1]!
      const p = providerInfo(id)!
      expect(p, id).toBeTruthy()
      expect(/base_url: "([^"]*)"/.exec(l)![1], id).toBe(p.baseUrl)
      expect(/needs_key: (true|false)/.exec(l)![1] === 'true', id).toBe(p.needsKey)
      expect(/default_model: "([^"]*)"/.exec(l)![1], id).toBe(p.defaultModel)
      expect(/key_help_url: "([^"]*)"/.exec(l)![1], id).toBe(p.keyHelpUrl)
    }
    expect(PROVIDERS.map((p) => p.id)).toEqual(lines.map((l) => /id: "([^"]*)"/.exec(l)![1]))
  })
  it('only OpenRouter has a concrete price; everything else says it depends (or is free locally)', () => {
    for (const p of PROVIDERS) {
      if (p.id === 'openrouter') expect(p.priceHint).toContain('$')
      else expect(p.priceHint).not.toContain('$')
    }
    expect(providerInfo('openai')!.priceHint).toBe('price depends on your plan')
  })
  it('hosted URLs are https and fixed; local defaults are loopback http', () => {
    for (const p of PROVIDERS.filter((x) => x.http && !x.urlEditable)) expect(p.baseUrl.startsWith('https://')).toBe(true)
    for (const id of ['ollama', 'lmstudio']) expect(validateBaseUrlText(providerInfo(id)!.baseUrl)).toBeNull()
  })
})

describe('card ordering', () => {
  it('detected providers come first, otherwise table order', () => {
    // hermes_cli (M21, experimental) has no card unless it was found AND the switch is on
    const NO_EXP = PROVIDERS.filter((p) => p.id !== 'hermes_cli').map((p) => p.id)
    expect(orderProviders(null).map((c) => c.info.id)).toEqual(NO_EXP)
    expect(orderProviders(null).some((c) => c.found)).toBe(false)
    const o = orderProviders({ claude_cli: true, ollama: true, lmstudio: false })
    expect(o.slice(0, 2).map((c) => [c.info.id, c.found])).toEqual([['ollama', true], ['claude_cli', true]])
    expect(o.slice(2).every((c) => !c.found)).toBe(true)
    expect(o.slice(2).map((c) => c.info.id)).toEqual(['openrouter', 'openai', 'venice', 'anthropic', 'lmstudio', 'custom', 'hermes'])
    expect(orderProviders({ claude_cli: false, ollama: false, lmstudio: false }).map((c) => c.info.id)).toEqual(NO_EXP)
  })
})

describe('error text', () => {
  it('has a sentence for every code, including all nine backend codes (budget since M16 B2), and no jargon codes leak into it', () => {
    const backend = [...rust('client.rs').matchAll(/LlmError::\w+ => "([a-z_]+)"/g)].map((m) => m[1]!)
    expect(backend).toEqual(['no_key', 'bad_key', 'unreachable', 'rate_limited', 'timeout', 'bad_reply', 'bad_request', 'not_installed', 'budget'])
    for (const c of [...backend, 'too_long', 'limit']) {
      expect(ERROR_CODES as readonly string[]).toContain(c)
      expect(ERROR_TEXT[c as keyof typeof ERROR_TEXT].length).toBeGreaterThan(15)
      expect(ERROR_TEXT[c as keyof typeof ERROR_TEXT]).not.toMatch(/[a-z]+_[a-z]+/)
    }
    expect(ERROR_TEXT.bad_key).toMatch(/key was rejected/i)
    expect(ERROR_TEXT.unreachable).toMatch(/can't reach/i)
    expect(ERROR_TEXT.not_installed).toMatch(/isn't installed/i)
    expect(ERROR_TEXT.bad_request).toMatch(/Advanced > Compatibility mode/)
  })
})

describe('address validation (mirrors url_guard.rs)', () => {
  it('https anywhere, http only to parsed loopback hosts', () => {
    for (const ok of ['https://openrouter.ai/api/v1', 'https://203.0.113.5:8443/v1', 'http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:8080/v1', 'http://127.0.0.2/v1', 'http://LOCALHOST:1234/v1']) {
      expect(validateBaseUrlText(ok), ok).toBeNull()
    }
    for (const bad of ['http://example.com/v1', 'http://192.168.1.5:11434/v1', 'http://127.0.0.1.evil.com/v1', 'http://localhost.evil.com/v1', 'http://0.0.0.0:11434/v1', 'http://localhost@evil.com/v1']) {
      expect(validateBaseUrlText(bad), bad).not.toBeNull()
    }
  })
  it('userinfo, query, fragment, other schemes and junk are refused with a sentence', () => {
    for (const bad of ['https://u@openrouter.ai/v1', 'https://u:p@openrouter.ai/v1', 'https://openrouter.ai/v1?x=1', 'https://openrouter.ai/v1#f', 'ftp://127.0.0.1/v1', 'file:///etc/passwd', 'javascript:alert(1)', 'openrouter.ai/v1', '', '   ', `https://example.com/${'a'.repeat(300)}`]) {
      const m = validateBaseUrlText(bad)
      expect(m, bad).toBeTruthy()
      expect(m!.length).toBeGreaterThan(15)
    }
  })
})

describe('form validation in plain words', () => {
  const or = providerInfo('openrouter')!
  const oa = providerInfo('openai')!
  const ol = providerInfo('ollama')!
  const lm = providerInfo('lmstudio')!
  const cu = providerInfo('custom')!
  const cli = providerInfo('claude_cli')!
  const f = (o: Partial<{ key: string; baseUrl: string; model: string }> = {}) => ({ key: '', baseUrl: '', model: '', ...o })

  it('hosted providers need a key of the right shape', () => {
    expect(validateSetup(or, f(), NONE)).toMatch(/Paste your OpenRouter key/)
    expect(validateSetup(or, f({ key: 'sk-test-KEY' }), NONE)).toMatch(/sk-or-/)
    expect(validateSetup(or, f({ key: 'sk-or-v1-abc' }), NONE)).toBeNull()
    expect(validateSetup(oa, f({ key: 'sk-test-KEY' }), NONE)).toBeNull()
    expect(validateSetup(oa, f({ key: 'a b' }), NONE)).toMatch(/spaces/)
    // already saved for the same provider: nothing to type
    expect(validateSetup(or, f(), saved('openrouter', 'https://openrouter.ai/api/v1'))).toBeNull()
  })
  it('keyless providers need nothing; the CLI needs nothing', () => {
    expect(validateSetup(ol, f(), NONE)).toBeNull()
    expect(validateSetup(cli, f(), NONE)).toBeNull()
  })
  it('local presets must stay on this computer; custom takes https or loopback http and needs an address', () => {
    expect(validateSetup(ol, f({ baseUrl: 'https://example.com/v1' }), NONE)).toMatch(/own computer/)
    expect(validateSetup(ol, f({ baseUrl: 'http://localhost:9999/v1' }), NONE)).toBeNull()
    expect(validateSetup(cu, f(), NONE)).toMatch(/address/i)
    expect(validateSetup(cu, f({ baseUrl: 'http://example.com/v1', model: 'm' }), NONE)).toMatch(/Plain http/)
    expect(validateSetup(cu, f({ baseUrl: 'https://example.com/v1', model: 'm' }), NONE)).toBeNull()
  })
  it('a model name is required where there is no default, and checked everywhere', () => {
    expect(validateSetup(lm, f(), NONE)).toMatch(/model name/)
    expect(validateSetup(lm, f({ model: 'qwen2.5-7b-instruct' }), NONE)).toBeNull()
    expect(validateSetup(cu, f({ baseUrl: 'https://example.com/v1' }), NONE)).toMatch(/model name/)
    expect(validateSetup(or, f({ key: 'sk-or-v1-abc', model: 'bad model;rm' }), NONE)).toMatch(/Model names/)
  })
  it('changing the address (or provider) with a key saved asks for the key again', () => {
    const st = saved('custom', 'https://a.example.com/v1', 'm')
    expect(needsKeyAgain(cu, f({ baseUrl: 'https://evil.example.com/v1' }), st)).toBe(true)
    expect(validateSetup(cu, f({ baseUrl: 'https://evil.example.com/v1' }), st)).toMatch(/paste the key again/i)
    expect(validateSetup(cu, f({ baseUrl: 'https://evil.example.com/v1', key: 'sk-test-KEY' }), st)).toBeNull()
    expect(needsKeyAgain(cu, f({ baseUrl: 'https://a.example.com/v1/' }), st)).toBe(false)
    expect(needsKeyAgain(cu, f(), st)).toBe(false)
    expect(needsKeyAgain(oa, f(), st)).toBe(true) // switching provider with a key on file
    expect(validateSetup(oa, f(), st)).toMatch(/paste the key again/i)
    expect(needsKeyAgain(ol, f(), st)).toBe(false) // keyless: nothing to carry over
    expect(needsKeyAgain(oa, f(), { provider: null, base_url: null, model: null, key_present: false })).toBe(false)
  })
  it('effectiveUrl follows what Rust will resolve', () => {
    expect(effectiveUrl(or, f({ baseUrl: 'https://evil/v1' }), NONE)).toBe('https://openrouter.ai/api/v1')
    expect(effectiveUrl(ol, f(), NONE)).toBe('http://127.0.0.1:11434/v1')
    expect(effectiveUrl(ol, f({ baseUrl: 'http://127.0.0.1:9999/v1/' }), NONE)).toBe('http://127.0.0.1:9999/v1')
    expect(effectiveUrl(cu, f(), saved('custom', 'https://a.example.com/v1'))).toBe('https://a.example.com/v1')
    expect(effectiveUrl(cli, f(), NONE)).toBe('')
  })
})
