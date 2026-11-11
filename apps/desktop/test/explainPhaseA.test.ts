import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake, fakeExplain, fakeLlm } from '../src/lib/api'
import { buildExplainDigest } from '../src/lib/explainDigest'
import { explainVariants, fakeExplainReply } from '../src/lib/explainFake'
import { groundReply } from '../src/lib/explainGround'
import { lintReply } from '../src/lib/explainLint'
import { estimateTokens, parseMode, PROMPT_VERSION, serializeMode, CHAT_MODE_KEY } from '../src/lib/explainPrompt'
import { findTerms } from '../src/lib/glossary'
import { useChartContext } from '../src/stores/chartContext'
import { useExplainStore } from '../src/stores/explain'
import { useRhStore } from '../src/stores/rh'
import { wipeSession } from '../src/stores/session'

const st = () => useExplainStore.getState()
const ask = (q: string) => st().ask(q)
beforeEach(async () => {
  fake.reset()
  st().reset()
  useChartContext.setState({ chart: null, overlays: null, fib: null, strike: null })
  useRhStore.getState().wipe()
  fakeLlm.set('openrouter', null, 'sk-or-TESTKEY', null, null)
  await st().loadConfig()
})

describe('PROMPT_VERSION mirrors Rust', () => {
  it('same string in client.rs and explainPrompt.ts', () => {
    const rs = readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'llm', 'client.rs'), 'utf8')
    expect(rs.match(/PROMPT_VERSION: &str = "([^"]+)"/)![1]).toBe(PROMPT_VERSION)
  })
})

describe('teaching mode (A6)', () => {
  it('parse: JSON enum only, anything else is beginner', () => {
    expect(parseMode(null)).toBe('beginner')
    expect(parseMode(serializeMode('trader'))).toBe('trader')
    expect(parseMode(serializeMode('beginner'))).toBe('beginner')
    for (const bad of ['{{', 'trader', '"expert"', '1', 'null', '"Trader"', '']) expect(parseMode(bad), bad).toBe('beginner')
    expect(CHAT_MODE_KEY).toBe('chat.mode')
  })
  it('default beginner; setMode persists to the setting and round trips; bad stored JSON loads as the default', async () => {
    expect(st().mode).toBe('beginner')
    await st().setMode('trader')
    expect(st().mode).toBe('trader')
    expect(await api.settingGet(CHAT_MODE_KEY)).toBe('"trader"')
    st().reset()
    expect(st().mode).toBe('beginner')
    await st().loadMode()
    expect(st().mode).toBe('trader')
    await api.settingSet(CHAT_MODE_KEY, '{{not json')
    st().reset()
    await st().loadMode()
    expect(st().mode).toBe('beginner')
  })
  it('the mode string travels as the 5th argument of the one explain command', async () => {
    await ask('a')
    await st().setMode('trader')
    await ask('b')
    expect(fakeExplain.calls.map((c) => c.mode)).toEqual(['beginner', 'trader'])
  })
  it('the fake backend (like Rust) refuses an unknown mode with bad_request', async () => {
    await expect(api.explainAsk('', 'CHART: x', 'q', [], 'expert')).rejects.toThrow('bad_request')
  })
  it('toggling does not change history or wipe the transcript', async () => {
    await ask('a')
    await st().setMode('trader')
    expect(st().turns).toHaveLength(2)
  })
})

describe('what I sent (A3)', () => {
  it('estimate math', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(1)).toBe(1)
    expect(estimateTokens(4)).toBe(1)
    expect(estimateTokens(401)).toBe(101)
  })
  it('keeps the exact digest, version, model and estimate per turn, in memory', async () => {
    useChartContext.setState({ chart: { symbol: 'AAPL', tf: '15m', bars: 10, last: 87.38, hi: 90, lo: 80, chg: 0.01, estBuyShare: 0.5 } })
    await ask('first question')
    useChartContext.setState({ chart: { symbol: 'AAPL', tf: '15m', bars: 11, last: 88.5, hi: 90, lo: 80, chg: 0.02, estBuyShare: 0.5 } })
    await ask('second question')
    expect(st().sentLog).toHaveLength(2)
    expect(st().sentLog[0]!.digest).toBe(fakeExplain.calls[0]!.digest)
    expect(st().sentLog[1]!.digest).toBe(fakeExplain.calls[1]!.digest)
    expect(st().sentLog[0]!.digest).toContain('last=87.38')
    expect(st().sentLog[1]!.digest).toContain('last=88.5')
    const s = st().lastSent!
    expect(s.promptVersion).toBe(PROMPT_VERSION)
    expect(s.model).toBe('deepseek/deepseek-v4-flash')
    const hist = fakeExplain.calls[1]!.history.reduce((n, h) => n + [...h.text].length, 0)
    expect(s.estTokens).toBe(estimateTokens([...s.digest].length + [...'second question'].length + hist))
    expect(s.question).toBe('second question')
    // the log is indexed by the assistant turn it produced (so the pane can ground each reply against ITS digest)
    expect(st().sentLog.map((x) => x.turnIndex)).toEqual([1, 3])
  })
  it('never holds a key (fixture grep over everything retained)', async () => {
    await ask('q')
    const blob = JSON.stringify({ l: st().lastSent, log: st().sentLog })
    expect(blob).not.toContain('sk-or-TESTKEY')
    expect(blob).not.toMatch(/sk-(or-)?[A-Za-z0-9-]*KEY/)
  })
  it('a failed ask still shows what was sent, but is not in the per-turn log', async () => {
    fakeExplain.fail = 'timeout'
    await ask('q')
    expect(st().lastSent?.question).toBe('q')
    expect(st().sentLog).toHaveLength(0)
  })
  it('session wipe clears them; reset too', async () => {
    await ask('q')
    wipeSession()
    expect(st().lastSent).toBeNull()
    expect(st().sentLog).toEqual([])
    await ask('q2')
    st().reset()
    expect(st().lastSent).toBeNull()
  })
})

describe('canned dev replies exercise each pipeline stage', () => {
  const digest = buildExplainDigest(
    {
      chart: { symbol: 'AAPL', tf: '15m', bars: 834, last: 87.38, hi: 89.1, lo: 85.25, chg: 0.0123, estBuyShare: 0.41 },
      overlays: { fib: 'key', fvg: false, ma: [50, 200], atr: 'off' },
      levels: { apex: [97, 95, 90], flip: 88.5, emLo: 83.1, emHi: 91.7, emPct: 0.049 },
      ivRank: 72,
      fib: { up: true, r382: 86.1, r500: 85.9, r618: 85.4 },
      strike: { right: 'put', strike: 95, dte: 9, emUnits: 1.25, wall: 97, earningsInside: false, verdict: 'protected' },
      positions: [],
    },
    { includePositions: false },
  )
  it('lists the variants', () => {
    expect(explainVariants).toEqual(['grounded', 'ungrounded', 'prescriptive', 'hostile', 'glossary'])
  })
  it('grounded: no flags, no lint', () => {
    const r = fakeExplainReply(digest, 'explain', 'grounded')
    expect(groundReply(r, digest).flagged).toEqual([])
    expect(lintReply(r).prescriptive).toBe(false)
  })
  it('ungrounded: at least one flag', () => {
    expect(groundReply(fakeExplainReply(digest, 'explain', 'ungrounded'), digest).flagged.length).toBeGreaterThan(0)
  })
  it('prescriptive: lint fires', () => {
    expect(lintReply(fakeExplainReply(digest, 'explain', 'prescriptive')).prescriptive).toBe(true)
  })
  it('hostile: carries the hostile strings and markdown', () => {
    const r = fakeExplainReply(digest, 'explain', 'hostile')
    for (const s of ['<script>', '[x](javascript:alert(1))', '**', '|']) expect(r).toContain(s)
  })
  it('glossary: several terms', () => {
    expect(findTerms(fakeExplainReply(digest, 'explain', 'glossary')).length).toBeGreaterThanOrEqual(5)
  })
  it('the fake backend serves the chosen variant', async () => {
    fakeExplain.variant = 'ungrounded'
    await ask('q')
    expect(st().turns[1]!.text).toBe(fakeExplainReply(fakeExplain.calls[0]!.digest, 'q', 'ungrounded'))
  })
})
