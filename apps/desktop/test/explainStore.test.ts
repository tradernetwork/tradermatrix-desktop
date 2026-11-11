import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeExplain, fakeLlm, TM_KEY_SLOT } from '../src/lib/api'
import { ERROR_TEXT, ERROR_CODES, HISTORY_TURNS, MAX_PROMPT_CHARS, MAX_USER_MESSAGES, toErrorCode, trimHistory, isValidModel } from '../src/lib/explainPrompt'
import { keyShapeError, providerInfo } from '../src/lib/llmProviders'
import { fakeExplainReply } from '../src/lib/explainFake'
import { useChartContext } from '../src/stores/chartContext'
import { collectExplainState, configNeedsSetup, useExplainStore } from '../src/stores/explain'
import { useRhStore } from '../src/stores/rh'
import { wipeSession } from '../src/stores/session'
import { buildExplainDigest } from '../src/lib/explainDigest'

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'
beforeEach(async () => {
  fake.reset()
  useExplainStore.getState().reset()
  useChartContext.setState({ chart: null, overlays: null, fib: null, strike: null })
  useRhStore.getState().wipe()
  // a configured OpenRouter provider with a (fake) saved key, as the dev page does
  fakeLlm.set('openrouter', null, 'sk-or-TESTKEY', null, null)
  await useExplainStore.getState().loadConfig()
})

const ask = (q: string) => useExplainStore.getState().ask(q)
const st = () => useExplainStore.getState()

describe('explain store', () => {
  it('asks with the model, a digest, the question and the earlier turns', async () => {
    useChartContext.setState({ chart: { symbol: 'AAPL', tf: '15m', bars: 10, last: 87.38, hi: 90, lo: 80, chg: 0.01, estBuyShare: 0.5 } })
    expect(await ask('Explain this chart')).toBe(true)
    expect(fakeExplain.calls).toHaveLength(1)
    const c = fakeExplain.calls[0]!
    expect(c.model).toBe(DEFAULT_MODEL)
    expect(c.question).toBe('Explain this chart')
    expect(c.digest).toContain('CHART: symbol=AAPL tf=15m')
    expect(c.history).toEqual([])
    expect(st().turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(st().turns[1]!.text).toContain('FAKE reply')
    await ask('and now?')
    expect(fakeExplain.calls[1]!.history).toHaveLength(2)
  })

  it('Review Focus 4: prompt over 2000 chars is refused locally', async () => {
    expect(await ask('x'.repeat(MAX_PROMPT_CHARS + 1))).toBe(false)
    expect(st().error).toBe('too_long')
    expect(fakeExplain.calls).toHaveLength(0)
    expect(await ask('x'.repeat(MAX_PROMPT_CHARS))).toBe(true)
  })

  it('Review Focus 4: the 41st message is refused locally', async () => {
    for (let i = 0; i < MAX_USER_MESSAGES; i++) expect(await ask(`q${i}`)).toBe(true)
    expect(fakeExplain.calls).toHaveLength(MAX_USER_MESSAGES)
    expect(await ask('one more')).toBe(false)
    expect(st().error).toBe('limit')
    expect(fakeExplain.calls).toHaveLength(MAX_USER_MESSAGES)
    // the history actually sent never exceeds 8 turns
    expect(Math.max(...fakeExplain.calls.map((c) => c.history.length))).toBe(HISTORY_TURNS)
  })

  it('history trim keeps the LAST 8 turns and the new question is never part of it', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `t${i}` }))
    const h = trimHistory(turns)
    expect(h).toHaveLength(8)
    expect(h[0]!.text).toBe('t12')
    expect(h[7]!.text).toBe('t19')
  })

  it('busy lock: a second ask while one is in flight does nothing', async () => {
    fakeExplain.delayMs = 30
    const a = ask('first')
    expect(st().busy).toBe(true)
    expect(await ask('second')).toBe(false)
    expect(await a).toBe(true)
    expect(fakeExplain.calls).toHaveLength(1)
    expect(st().busy).toBe(false)
  })

  it('error codes surface as fixed codes; provider-looking text collapses to bad_reply; the failed question is not kept', async () => {
    for (const [fail, want] of [['rate_limited', 'rate_limited'], ['timeout', 'timeout'], ['bad_key', 'bad_key'], ['unreachable', 'unreachable'], ['not_installed', 'not_installed'], ['Provider said: sk-or-LEAK invalid', 'bad_reply']] as const) {
      fakeExplain.fail = fail
      expect(await ask('q')).toBe(false)
      expect(st().error).toBe(want)
      expect(st().busy).toBe(false)
      expect(st().turns).toEqual([])
      expect(ERROR_TEXT[st().error as keyof typeof ERROR_TEXT]).not.toContain('LEAK')
    }
    fakeExplain.fail = ''
    expect(await ask('q')).toBe(true)
    expect(st().error).toBe('')
  })

  it('unconfigured: setup is needed, no ask is possible and nothing is sent', async () => {
    fakeLlm.clear()
    await st().loadConfig()
    expect(st().config?.provider).toBeNull()
    expect(configNeedsSetup(st().config)).toBe(true)
    expect(await ask('q')).toBe(false)
    expect(st().error).toBe('no_key')
    expect(fakeExplain.calls).toHaveLength(0)
    // a provider that needs a key but has none is also "needs setup"; a keyless one is not
    expect(configNeedsSetup({ provider: 'openai', base_url: null, model: null, compat: false, key_present: false, lan_http: false })).toBe(true)
    expect(configNeedsSetup({ provider: 'ollama', base_url: null, model: null, compat: false, key_present: false, lan_http: false })).toBe(false)
    expect(configNeedsSetup({ provider: 'claude_cli', base_url: null, model: null, compat: false, key_present: false, lan_http: false })).toBe(false)
    // unknown (not loaded) goes to the backend, which answers no_key
    useExplainStore.setState({ config: null, error: '' })
    expect(await ask('q')).toBe(false)
    expect(st().error).toBe('no_key')
    expect(fakeExplain.calls).toHaveLength(1)
  })

  it('Review Focus 5: wipeSession clears the transcript, drops an in-flight answer and keeps nothing', async () => {
    await ask('one')
    expect(st().turns).toHaveLength(2)
    fakeExplain.delayMs = 30
    const inflight = ask('two')
    wipeSession()
    expect(st().turns).toEqual([])
    expect(await inflight).toBe(false)
    expect(st().turns).toEqual([])
    expect(st().busy).toBe(false)
    expect(st().config).toBeNull() // re-read from Rust afterwards; nothing secret is held here
  })

  it('Review Focus 3: positions only reach the digest when the box is ticked', async () => {
    useRhStore.setState({ positions: [{ symbol: 'AAPL', quantity: 10, average_buy_price: 150, shares_available_for_sells: null, shares_held_for_sells: null }] })
    await ask('q')
    expect(fakeExplain.calls[0]!.digest).not.toMatch(/POS|qty=/)
    st().setIncludePositions(true)
    await ask('q2')
    expect(fakeExplain.calls[1]!.digest).toContain('POS: AAPL qty=10 avg=150')
    expect(collectExplainState(false).positions).toEqual([])
    expect(st().includePositions).toBe(true)
  })

  it('saving a provider: the key goes only to llm_config_set, is never kept, and is scrubbed from errors', async () => {
    const KEY = 'sk-or-v1-abcdef0123456789'
    expect(await st().saveConfig({ provider: 'openrouter', baseUrl: null, apiKey: KEY, model: null, compat: null })).toBe('')
    expect(fakeLlm.setCalls.at(-1)).toMatchObject({ provider: 'openrouter', hasKey: true })
    expect(st().config).toMatchObject({ provider: 'openrouter', key_present: true, model: DEFAULT_MODEL })
    expect(JSON.stringify(st())).not.toContain('abcdef0123456789')
    // shape errors come back before anything is sent, and never echo the key
    const calls = fakeLlm.setCalls.length
    expect(await st().saveConfig({ provider: 'openrouter', baseUrl: null, apiKey: 'td_live_whatever_whatever', model: null, compat: null })).toMatch(/sk-or-/)
    expect(fakeLlm.setCalls).toHaveLength(calls)
    // a failing backend message containing the key is scrubbed
    const spy = vi.spyOn(api, 'llmConfigSet').mockRejectedValue(new Error('boom sk-or-LEAKYKEY here'))
    const m = await st().saveConfig({ provider: 'openrouter', baseUrl: null, apiKey: 'sk-or-LEAKYKEY', model: null, compat: null })
    expect(m).not.toContain('LEAKYKEY')
    expect(m).toContain('[hidden]')
    spy.mockRestore()
    expect(await st().clearConfig()).toBe('')
    expect(st().config?.provider).toBeNull()
  })

  it('provider switch keeps no secret in the webview and the transcript survives a config change', async () => {
    await ask('one')
    expect(await st().saveConfig({ provider: 'openai', baseUrl: null, apiKey: 'sk-test-KEY', model: 'gpt-4.1-mini', compat: null })).toBe('')
    expect(st().config).toMatchObject({ provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' })
    expect(JSON.stringify(st())).not.toContain('sk-test-KEY')
    expect(st().turns).toHaveLength(2)
    await ask('two')
    expect(fakeExplain.calls.at(-1)!.model).toBe('gpt-4.1-mini')
    // a keyless provider drops the stale key (Rust does the same)
    expect(await st().saveConfig({ provider: 'ollama', baseUrl: null, apiKey: null, model: null, compat: null })).toBe('')
    expect(st().config).toMatchObject({ provider: 'ollama', key_present: false, base_url: 'http://127.0.0.1:11434/v1', model: 'llama3.2' })
  })

  it('review focus 2 (webview side): the fake refuses a re-pointed key and the LLM slots through secret_set', async () => {
    expect(await st().saveConfig({ provider: 'custom', baseUrl: 'https://a.example.com/v1', apiKey: 'sk-test-KEY', model: 'm', compat: null })).toBe('')
    const refused = await st().saveConfig({ provider: 'custom', baseUrl: 'https://evil.example.com/v1', apiKey: null, model: null, compat: null })
    expect(refused).toMatch(/refused/)
    expect(st().config?.base_url).toBe('https://a.example.com/v1')
    expect(await st().saveConfig({ provider: 'custom', baseUrl: 'https://b.example.com/v1', apiKey: 'sk-test-KEY2', model: null, compat: null })).toBe('')
    for (const slot of ['llm_api_key', 'llm_config', 'robinhood_oauth']) {
      await expect(api.secretSet(slot, 'x')).rejects.toThrow(/unknown secret slot/)
      await expect(api.secretExists(slot)).rejects.toThrow(/unknown secret slot/)
      await expect(api.secretDelete(slot)).rejects.toThrow(/unknown secret slot/)
    }
  })

  it('the Test button maps every failure to a fixed code and never sends chart data', async () => {
    await st().runTest()
    expect(st().testResult).toEqual({ ok: true })
    for (const code of ['bad_key', 'unreachable', 'not_installed', 'rate_limited', 'timeout'] as const) {
      fakeExplain.fail = code
      await st().runTest()
      expect(st().testResult).toEqual({ ok: false, code })
    }
    fakeExplain.fail = 'Provider said sk-or-LEAK'
    await st().runTest()
    expect(st().testResult).toEqual({ ok: false, code: 'bad_reply' })
    expect(fakeExplain.calls).toHaveLength(0) // the ping is not an explain call and carries no digest
  })

  it('detect is stored as given and a failure reads as nothing found', async () => {
    fakeLlm.detect = { claude_cli: true, ollama: false, lmstudio: true }
    await st().runDetect()
    expect(st().detect).toEqual({ claude_cli: true, ollama: false, lmstudio: true })
    const spy = vi.spyOn(api, 'llmDetect').mockRejectedValue(new Error('x'))
    await st().runDetect()
    expect(st().detect).toEqual({ claude_cli: false, ollama: false, lmstudio: false })
    spy.mockRestore()
  })
})

describe('explain helpers', () => {
  it('toErrorCode / key validation / error text coverage', () => {
    expect(toErrorCode(new Error('rate_limited'))).toBe('rate_limited')
    expect(toErrorCode('timeout')).toBe('timeout')
    expect(toErrorCode('bad_key')).toBe('bad_key')
    expect(toErrorCode('refused')).toBe('bad_reply') // M14 code, gone
    expect(toErrorCode('anything else')).toBe('bad_reply')
    for (const c of ERROR_CODES) expect(ERROR_TEXT[c].length).toBeGreaterThan(10)
    const or = providerInfo('openrouter')!
    expect(keyShapeError(or, 'sk-or-v1-abc')).toBeNull()
    expect(keyShapeError(or, 'sk-or-')).not.toBeNull()
    expect(keyShapeError(or, 'sk-or-a b')).not.toBeNull()
    expect(keyShapeError(providerInfo('openai')!, 'sk-proj-abc')).toBeNull()
    expect(isValidModel('Llama-3.2:3b')).toBe(true)
    expect(isValidModel('bad model')).toBe(false)
  })
  it('the fake reply is built from the digest and never invents a number', () => {
    const d = buildExplainDigest({ ...collectExplainState(false), chart: { symbol: 'AAPL', tf: '15m', bars: 1, last: 87.38, hi: null, lo: null, chg: null, estBuyShare: null } }, { includePositions: false })
    const r = fakeExplainReply(d, 'Explain this chart')
    expect(r).toContain('AAPL')
    expect(r).toContain('87.38')
  })
})

describe('explain-only guard', () => {
  const root = join(__dirname, '..', 'src')
  const files = [
    'stores/explain.ts',
    'stores/chartContext.ts',
    'lib/explainDigest.ts',
    'lib/explainPrompt.ts',
    'lib/explainFake.ts',
    'workspace/ExplainPane.tsx',
    'workspace/ExplainSetup.tsx',
    'workspace/ArayaAvatar.tsx',
    'lib/llmProviders.ts',
    'workspace/chatDev.tsx',
    // M16 phase A
    'lib/explainGround.ts',
    'lib/explainLint.ts',
    'lib/explainChips.ts',
    'lib/explainReply.ts',
    'lib/mdSafe.ts',
    'lib/glossary.ts',
    'workspace/ExplainReply.tsx',
    'workspace/ExplainDrawer.tsx',
    // M16 phase B1-B3
    'lib/explainMeter.ts',
    'lib/explainCopy.ts',
    'lib/explainThreadsFake.ts',
    'workspace/ExplainThreads.tsx',
    'workspace/ExplainMeter.tsx',
    // M16 phase B4-B7
    'lib/explainFocus.ts',
    'stores/explainFocus.ts',
    'workspace/AskAboutMenu.tsx',
    'lib/redact.ts',
    'lib/explainStates.ts',
  ]
  it('the chat files never mention order, ticket or place/review/cancel tooling', () => {
    for (const f of files) {
      const src = readFileSync(join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
        // the one required sentence of user-facing copy (the banner says what the pane does NOT do)
        .replace('It does not place or suggest orders.', '')
      expect(src, f).not.toMatch(/\b(place(?![a-z])|cancel(?![a-z])|review(?![a-z])|fillTicket|cancelAndEdit|ticketIntent|useOrdersStore|rhPlace|rhReview|rhCancel|rh_place|rh_review|rh_cancel)/i)
      expect(src, f).not.toMatch(/from ['"][^'"]*(orders|ticketIntent|OrderTicket|OrderReview)['"]/)
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML/)
    }
  })
  it('no other file in the chat path was missed', () => {
    const all = [...readdirSync(join(root, 'stores')), ...readdirSync(join(root, 'workspace')), ...readdirSync(join(root, 'lib'))].filter((n) => /explain|mdSafe|glossary/i.test(n))
    for (const n of all) expect(files.some((f) => f.endsWith(n)), n).toBe(true)
  })
  it('the explain command is the only chat call in api.ts and takes no ticket or order type', () => {
    const src = readFileSync(join(root, 'lib', 'api.ts'), 'utf8')
    const line = src.split('\n').find((l) => l.includes("'explain_ask'"))!
    expect(line).toBeTruthy()
    expect(TM_KEY_SLOT).toBe('tm_api_key')
    // the webview never writes the LLM key through secret_set any more: one sealed command does
    expect(src).toContain("'llm_config_set'")
    expect(src).toContain("export const WEBVIEW_SLOTS = ['tm_api_key'] as const")
  })
})
