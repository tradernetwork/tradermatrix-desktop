import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake, fakeExplain, fakeLlm } from '../src/lib/api'
import { copyPlain } from '../src/lib/explainCopy'
import { ERROR_TEXT, replayHistory, toErrorCode } from '../src/lib/explainPrompt'
import { fakeExplainReply } from '../src/lib/explainFake'
import { useChartContext } from '../src/stores/chartContext'
import { useExplainStore } from '../src/stores/explain'
import { useRhStore } from '../src/stores/rh'
import { wipeSession } from '../src/stores/session'

const st = () => useExplainStore.getState()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chart = (last: number) => useChartContext.setState({ chart: { symbol: 'AAPL', tf: '15m', bars: 10, last, hi: 90, lo: 80, chg: 0.01, estBuyShare: 0.5 } })
const until = async (f: () => boolean, ms = 2000) => {
  const t = Date.now()
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting')
    await sleep(5)
  }
}

beforeEach(async () => {
  fake.reset()
  st().reset()
  useChartContext.setState({ chart: null, overlays: null, fib: null, strike: null })
  useRhStore.getState().wipe()
  fakeLlm.set('openrouter', null, 'sk-or-TESTKEY', null, null)
  await st().loadConfig()
  chart(87.38)
})

describe('streaming (B1)', () => {
  it('the partial reply grows while it streams and the final turn is the whole reply', async () => {
    fakeExplain.chunkDelayMs = 10
    const p = st().ask('Explain this chart')
    await until(() => (st().streaming?.text.length ?? 0) > 0)
    expect(st().busy).toBe(true)
    const early = st().streaming!.text
    await until(() => (st().streaming?.text.length ?? 0) > early.length)
    expect(await p).toBe(true)
    expect(st().streaming).toBeNull()
    expect(st().busy).toBe(false)
    const full = fakeExplainReply(fakeExplain.calls[0]!.digest, 'Explain this chart')
    expect(st().turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(st().turns[1]!.text).toBe(full)
    expect(st().turns[1]!.partial).toBeFalsy()
    expect(fakeExplain.calls).toHaveLength(1)
    expect(fakeExplain.calls[0]!.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('a provider that cannot stream answers once and the pane still shows the whole answer', async () => {
    fakeExplain.canStream = false
    expect(await st().ask('q')).toBe(true)
    expect(st().turns[1]!.text).toContain('FAKE reply')
    expect(fakeExplain.deltaCount).toBe(1)
  })

  it('Stop keeps the partial text, marks it, sends no more deltas, and the next ask works', async () => {
    fakeExplain.chunkDelayMs = 20
    const p = st().ask('q')
    await until(() => (st().streaming?.text.length ?? 0) > 5)
    await st().stop()
    expect(await p).toBe(true)
    const full = fakeExplainReply(fakeExplain.calls[0]!.digest, 'q')
    const last = st().turns.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.partial).toBe(true)
    expect(last.text.length).toBeGreaterThan(0)
    expect(last.text.length).toBeLessThan(full.length)
    expect(full.startsWith(last.text)).toBe(true)
    expect(st().streaming).toBeNull()
    expect(st().busy).toBe(false)
    expect(st().error).toBe('')
    const frozen = JSON.stringify(st().turns)
    await sleep(150)
    expect(JSON.stringify(st().turns)).toBe(frozen)
    expect(fakeExplain.stopped).toEqual([fakeExplain.calls[0]!.requestId])
    fakeExplain.chunkDelayMs = 0
    expect(await st().ask('again')).toBe(true)
  })

  it('Stop before any text arrives adds nothing and shows no error', async () => {
    fakeExplain.delayMs = 80
    const p = st().ask('q')
    await sleep(10)
    await st().stop()
    expect(await p).toBe(false)
    expect(st().turns).toEqual([])
    expect(st().error).toBe('')
    expect(st().busy).toBe(false)
  })

  it('stop with nothing in flight does nothing', async () => {
    await st().stop()
    expect(fakeExplain.stopped).toEqual([])
  })

  it('the idle watchdog: a stalled stream ends as a timeout, the partial is kept and nothing is re-sent', async () => {
    fakeExplain.stall = true
    fakeExplain.idleMs = 60
    fakeExplain.chunkDelayMs = 5
    const ok = await st().ask('q')
    expect(ok).toBe(true)
    expect(st().error).toBe('timeout')
    const last = st().turns.at(-1)!
    expect(last.partial).toBe(true)
    expect(last.text.length).toBeGreaterThan(0)
    expect(fakeExplain.calls).toHaveLength(1)
    await sleep(100)
    expect(fakeExplain.calls).toHaveLength(1)
    expect(st().busy).toBe(false)
  })

  it('a failure with no text keeps no question (the draft stays) and a fixed code', async () => {
    fakeExplain.fail = 'unreachable'
    expect(await st().ask('q')).toBe(false)
    expect(st().turns).toEqual([])
    expect(st().error).toBe('unreachable')
  })

  it('double-clicking Ask sends one request', async () => {
    fakeExplain.chunkDelayMs = 10
    const a = st().ask('first')
    const b = st().ask('first')
    expect(await b).toBe(false)
    expect(await a).toBe(true)
    expect(fakeExplain.calls).toHaveLength(1)
  })

  it('a session wipe mid-stream stops the stream, delivers no more text and does not re-send', async () => {
    fakeExplain.chunkDelayMs = 20
    const p = st().ask('q')
    await until(() => (st().streaming?.text.length ?? 0) > 3)
    wipeSession()
    expect(st().turns).toEqual([])
    expect(st().streaming).toBeNull()
    expect(st().busy).toBe(false)
    expect(await p).toBe(false)
    await sleep(150)
    expect(st().turns).toEqual([])
    expect(st().streaming).toBeNull()
    expect(fakeExplain.stopped).toHaveLength(1)
    expect(fakeExplain.calls).toHaveLength(1)
    expect(st().usage).toBeNull()
  })
})

describe('Retry and Copy (B1)', () => {
  it('Retry re-asks the SAME question with a FRESH digest and replaces the old answer', async () => {
    chart(87.38)
    expect(await st().ask('Explain this chart')).toBe(true)
    chart(91.11)
    expect(await st().retry()).toBe(true)
    expect(fakeExplain.calls).toHaveLength(2)
    expect(fakeExplain.calls[1]!.question).toBe('Explain this chart')
    expect(fakeExplain.calls[0]!.digest).toContain('last=87.38')
    expect(fakeExplain.calls[1]!.digest).toContain('last=91.11')
    expect(fakeExplain.calls[1]!.history).toEqual([])
    expect(st().turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(st().turns[0]!.text).toBe('Explain this chart')
    expect(st().turns[1]!.text).toContain('91.11')
  })

  it('Retry only repeats the last question and never when nothing was asked, or while busy', async () => {
    expect(await st().retry()).toBe(false)
    await st().ask('one')
    await st().ask('two')
    fakeExplain.chunkDelayMs = 20
    const p = st().retry()
    expect(await st().retry()).toBe(false)
    await p
    expect(fakeExplain.calls.map((c) => c.question)).toEqual(['one', 'two', 'two'])
    expect(fakeExplain.calls[2]!.history.map((h) => h.text)).toEqual(['one', fakeExplainReply(fakeExplain.calls[0]!.digest, 'one')])
  })

  it('a Retry that the guards refuse leaves the transcript alone', async () => {
    await st().ask('one')
    fakeLlm.reset()
    await st().loadConfig()
    expect(await st().retry()).toBe(false)
    expect(st().turns.map((t) => t.role)).toEqual(['user', 'assistant'])
  })

  it('Copy writes the plain reply text to the clipboard', async () => {
    const written: string[] = []
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void written.push(t) } })
    const reply = 'It sits mid-range.\n\n**Bold** and `code` and <b>tags</b>.\n\nUsed: CHART'
    expect(await copyPlain(reply)).toBe(true)
    expect(written).toEqual([reply])
    vi.stubGlobal('navigator', {})
    expect(await copyPlain(reply)).toBe(false)
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => Promise.reject(new Error('denied')) } })
    expect(await copyPlain(reply)).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('replay history (B3)', () => {
  it('only the last 8 turns, older assistant turns cut to 600 chars, the newest answer whole, plain role/text only', () => {
    const long = 'x'.repeat(2000)
    const turns = Array.from({ length: 14 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: i % 2 ? long : `q${i}`, id: i, partial: false }))
    const h = replayHistory(turns)
    expect(h).toHaveLength(8)
    expect(h[0]!.text).toBe('q6')
    expect(h.filter((t) => t.role === 'assistant').slice(0, -1).every((t) => t.text.length === 600)).toBe(true)
    expect(h.at(-1)!.text).toHaveLength(2000)
    for (const t of h) expect(Object.keys(t).sort()).toEqual(['role', 'text'])
    expect(replayHistory([])).toEqual([])
  })
})

describe('cost meter + budgets (B2)', () => {
  it('after an answer the meter has this session usage and a flagged estimate when the provider reports none', async () => {
    fakeExplain.reportsUsage = false
    await st().ask('q')
    const u = st().usage!
    expect(u.session_tokens).toBeGreaterThan(0)
    expect(u.session_estimated).toBe(true)
    expect(u.session_cap).toBe(60_000)
    fakeExplain.reportsUsage = true
    await st().ask('q2')
    expect(st().usage!.session_tokens).toBeGreaterThan(u.session_tokens)
  })

  it('a used-up budget is the fixed code "budget": nothing is sent and the text is plain words', async () => {
    fakeExplain.sessionTokens = 60_000
    expect(await st().ask('q')).toBe(false)
    expect(st().error).toBe('budget')
    expect(fakeExplain.calls).toHaveLength(0)
    expect(toErrorCode(new Error('budget'))).toBe('budget')
    expect(ERROR_TEXT.budget).toMatch(/budget/i)
    expect(ERROR_TEXT.budget).not.toMatch(/[a-z]+_[a-z]+/)
  })

  it('a session wipe resets the session count', async () => {
    await st().ask('q')
    expect(fakeExplain.sessionTokens).toBeGreaterThan(0)
    wipeSession()
    await sleep(10)
    expect(fakeExplain.sessionTokens).toBe(0)
  })

  it('budgets are settings: setBudget stores JSON numbers and the meter follows', async () => {
    await st().refreshUsage()
    await st().setBudget('session_tokens', 25_000)
    await st().setBudget('month_usd', 0.5)
    expect(await api.settingGet('chat.budget.session_tokens')).toBe('25000')
    expect(await api.settingGet('chat.budget.month_usd')).toBe('0.5')
    expect(st().usage!.session_cap).toBe(25_000)
    expect(st().usage!.month_cap).toBe(0.5)
    // nonsense is refused locally and nothing is written
    await st().setBudget('session_tokens', -4)
    await st().setBudget('month_usd', Number.NaN)
    expect(await api.settingGet('chat.budget.session_tokens')).toBe('25000')
  })
})
