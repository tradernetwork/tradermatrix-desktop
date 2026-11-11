import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake, fakeExplain, fakeLlm } from '../src/lib/api'
import { HERMES_POSITIONS_WARNING, HERMES_SETUP_STEPS, HERMES_WARNING, needsKeyAgain, positionsWarning, providerInfo, validateHermesUrlText, validateSetup } from '../src/lib/llmProviders'
import { useChartContext } from '../src/stores/chartContext'
import { useExplainStore } from '../src/stores/explain'
import { useRhStore } from '../src/stores/rh'

const h = providerInfo('hermes')!
const f = (o: Partial<{ key: string; baseUrl: string; model: string; lanHttp: boolean }> = {}) => ({ key: '', baseUrl: '', model: '', ...o })

describe('hermes preset (mirrors provider.rs)', () => {
  it('is editable, takes an optional key, and has no prefilled address, model or key help link', () => {
    expect(h).toBeTruthy()
    expect([h.needsKey, h.takesKey, h.urlEditable, h.http, h.baseUrl, h.defaultModel, h.keyHelpUrl]).toEqual([false, true, true, true, '', '', ''])
    expect(h.priceHint).not.toContain('$')
  })
})

describe('hermes address rules (same matrix as url_guard.rs)', () => {
  const ok = (s: string, lan: boolean) => validateHermesUrlText(s, lan) === null
  it('https to any host; loopback http without a toggle', () => {
    for (const s of ['https://hermes.example.com', 'https://hermes.tailnet.ts.net/v1', 'https://203.0.113.5:8443', 'https://192.168.1.5', 'https://8.8.8.8/v1', 'http://127.0.0.1:8642', 'http://localhost:8642/v1', 'http://[::1]:8642']) {
      expect(ok(s, false) && ok(s, true), s).toBe(true)
    }
  })
  it('private LAN http only behind the toggle and only for IP addresses in RFC1918 or 100.64/10', () => {
    for (const s of ['http://192.168.1.5', 'http://192.168.1.5:8642/v1', 'http://10.0.0.5:8642', 'http://172.16.0.1', 'http://172.31.255.255', 'http://100.64.0.1', 'http://100.100.1.1:8642', 'http://100.127.255.255']) {
      expect(ok(s, false), `${s} without`).toBe(false)
      expect(ok(s, true), `${s} with`).toBe(true)
    }
    for (const s of [
      'http://8.8.8.8',
      'http://172.15.255.255',
      'http://172.32.0.1',
      'http://100.63.255.255',
      'http://100.128.0.1',
      'http://169.254.1.1',
      'http://0.0.0.0:8642',
      'http://134744072',
      'http://[fd00::1]:8642',
      'http://[::ffff:192.168.1.5]',
      'http://hermes.lan:8642',
      'http://hermes.example.com',
      'http://192.168.1.5.evil.com',
      'http://192.168.1.5.nip.io',
      'http://localhost.evil.com',
      'http://127.0.0.1.evil.com',
      'http://evil.com/192.168.1.5',
      'http://192.168.1.5@evil.com',
      'http://user:pw@192.168.1.5',
      'ftp://192.168.1.5',
      '192.168.1.5',
      '',
    ]) {
      expect(ok(s, true), `${s} with the toggle`).toBe(false)
      expect(ok(s, false), `${s} without`).toBe(false)
    }
    for (const s of ['https://u@host', 'https://host?x=1', 'https://host#f']) expect(ok(s, true), s).toBe(false)
    expect(validateHermesUrlText('http://192.168.1.5', false)).toMatch(/LAN/i)
  })
})

describe('hermes setup form', () => {
  it('nothing is assumed: an address is required, the key is optional', () => {
    expect(validateSetup(h, f({ model: 'tm-explain' }), null)).toMatch(/address/i)
    expect(validateSetup(h, f({ baseUrl: 'https://hermes.example.com', model: 'tm-explain' }), null)).toBeNull()
    expect(validateSetup(h, f({ baseUrl: 'https://hermes.example.com' }), null)).toMatch(/model name/i)
    expect(validateSetup(h, f({ baseUrl: 'https://hermes.example.com', model: 'tm-explain', key: 'sk-test-KEY' }), null)).toBeNull()
    expect(validateSetup(h, f({ baseUrl: 'http://192.168.1.5:8642', model: 'tm-explain' }), null)).toMatch(/LAN/i)
    expect(validateSetup(h, f({ baseUrl: 'http://192.168.1.5:8642', model: 'tm-explain', lanHttp: true }), null)).toBeNull()
    expect(validateSetup(h, f({ baseUrl: 'http://8.8.8.8', model: 'tm-explain', lanHttp: true }), null)).toBeTruthy()
  })
  it('the seal: a saved key follows only the address it was entered for (the /v1 suffix does not count as a change)', () => {
    const st = { provider: 'hermes', base_url: 'https://hermes.example.com/v1', model: 'tm-explain', key_present: true, lan_http: false }
    expect(needsKeyAgain(h, f({ baseUrl: 'https://hermes.example.com' }), st)).toBe(false)
    expect(needsKeyAgain(h, f({ baseUrl: 'https://hermes.example.com/v1/' }), st)).toBe(false)
    expect(needsKeyAgain(h, f(), st)).toBe(false)
    expect(needsKeyAgain(h, f({ baseUrl: 'https://evil.example.com' }), st)).toBe(true)
    expect(needsKeyAgain(h, f({ baseUrl: 'http://192.168.1.5:8642', lanHttp: true }), st)).toBe(true)
  })
})

describe('hermes copy', () => {
  it('the setup card names the tool-less profile steps and says the app cannot verify the Hermes side', () => {
    const steps = HERMES_SETUP_STEPS.join('\n')
    expect(steps).toMatch(/dedicated profile/i)
    expect(steps).toMatch(/terminal, browser, file and MCP toolsets? (all )?disabled/i)
    expect(steps).toMatch(/own API key/i)
    expect(steps).toMatch(/API_SERVER_KEY/)
    expect(steps).toMatch(/HTTPS/)
    expect(steps).toMatch(/tailscale serve/)
    expect(HERMES_WARNING).toMatch(/cannot verify or enforce what the Hermes side does/)
    expect(HERMES_WARNING).toMatch(/tool-less/i)
  })
  it('the positions toggle gets an extra warning only for Hermes', () => {
    expect(positionsWarning('hermes')).toBe(HERMES_POSITIONS_WARNING)
    expect(HERMES_POSITIONS_WARNING).toMatch(/positions/i)
    expect(HERMES_POSITIONS_WARNING).toMatch(/Hermes host/)
    for (const id of ['openrouter', 'openai', 'venice', 'ollama', 'lmstudio', 'custom', 'claude_cli', null, undefined]) expect(positionsWarning(id)).toBeNull()
  })
  it('the setup card source renders both texts and the loopback suggestion is a chip, not a prefill', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'workspace', 'ExplainSetup.tsx'), 'utf8')
    expect(src).toContain('HERMES_SETUP_STEPS')
    expect(src).toContain('HERMES_WARNING')
    expect(src).toContain('I accept plain LAN http')
    expect(src).toContain("'http://127.0.0.1:8642'")
    const pane = readFileSync(join(__dirname, '..', 'src', 'workspace', 'ExplainPane.tsx'), 'utf8')
    expect(pane).toContain('positionsWarning')
  })
})

describe('hermes through the fake backend (same rules as config.rs)', () => {
  beforeEach(async () => {
    fake.reset()
    useExplainStore.getState().reset()
    useChartContext.setState({ chart: null, overlays: null, fib: null, strike: null })
    useRhStore.getState().wipe()
  })
  const set = (url: string | null, key: string | null, lan: boolean | null, model: string | null = 'tm-explain') => api.llmConfigSet('hermes', url, key, model, null, lan)

  it('LAN http needs the toggle, public IPs and hostnames never pass, the toggle is reported', async () => {
    await expect(set(null, null, null)).rejects.toThrow('bad_request')
    await expect(set('http://192.168.1.5:8642', 'sk-test-KEY', null)).rejects.toThrow('bad_request')
    const st = await set('http://192.168.1.5:8642', 'sk-test-KEY', true)
    expect([st.provider, st.base_url, st.lan_http, st.key_present]).toEqual(['hermes', 'http://192.168.1.5:8642/v1', true, true])
    await expect(set('http://8.8.8.8', 'sk-test-KEY', true)).rejects.toThrow('bad_request')
    await expect(set('http://hermes.lan', 'sk-test-KEY', true)).rejects.toThrow('bad_request')
    // a new address does not inherit the acceptance; other settings keep it
    await expect(set('http://192.168.1.9:8642', 'sk-test-KEY', null)).rejects.toThrow('bad_request')
    expect((await set(null, null, null, 'other')).lan_http).toBe(true)
    await expect(set(null, null, false)).rejects.toThrow('bad_request')
    expect((await set('https://hermes.example.com', 'sk-test-KEY', false)).lan_http).toBe(false)
  })
  it('the toggle exists for Hermes only; a saved key cannot be re-pointed', async () => {
    await expect(api.llmConfigSet('custom', 'https://a.example.com/v1', null, null, null, true)).rejects.toThrow('bad_request')
    await set('https://a.example.com', 'sk-test-KEY', null)
    await expect(set('https://evil.example.com', null, null)).rejects.toThrow('bad_request')
  })
  it('the store passes the toggle and the Test button does not count as an ask', async () => {
    expect(await useExplainStore.getState().saveConfig({ provider: 'hermes', baseUrl: 'http://100.100.1.1:8642', apiKey: 'sk-test-KEY', model: 'tm-explain', compat: null, lanHttp: true })).toBe('')
    expect(useExplainStore.getState().config?.lan_http).toBe(true)
    await useExplainStore.getState().runTest()
    expect(useExplainStore.getState().testResult).toEqual({ ok: true })
    expect(fakeExplain.calls).toHaveLength(0)
    expect(fakeLlm.setCalls.at(-1)?.hasKey).toBe(true)
  })
})
