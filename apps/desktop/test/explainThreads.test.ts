import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake, fakeExplain, fakeLlm, fakeThreads } from '../src/lib/api'
import { PROMPT_VERSION } from '../src/lib/explainPrompt'
import { useChartContext } from '../src/stores/chartContext'
import { useExplainStore } from '../src/stores/explain'
import { useRhStore } from '../src/stores/rh'
import { wipeSession } from '../src/stores/session'

const st = () => useExplainStore.getState()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chart = (symbol: string, last = 87.38) => useChartContext.setState({ chart: { symbol, tf: '15m', bars: 10, last, hi: 90, lo: 80, chg: 0.01, estBuyShare: 0.5 } })
const KEY = 'sk-or-TESTKEY'

beforeEach(async () => {
  fake.reset()
  st().reset()
  useChartContext.setState({ chart: null, overlays: null, fib: null, strike: null })
  useRhStore.getState().wipe()
  fakeLlm.set('openrouter', null, KEY, null, null)
  await st().loadConfig()
  chart('AAPL')
  await st().openSymbol('AAPL')
})

describe('per-symbol threads (B3)', () => {
  it('an answered question is saved: both turns, the digest HASH only, the usage and the grounding flags', async () => {
    await st().ask('What is the gamma flip?')
    expect(st().threadId).not.toBeNull()
    const rows = fakeThreads.messages()
    expect(rows).toHaveLength(2)
    const [u, a] = rows
    expect([u!.role, a!.role]).toEqual(['user', 'assistant'])
    expect(u!.text).toBe('What is the gamma flip?')
    expect(u!.digest_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a!.digest_hash).toBe(u!.digest_hash)
    expect(a!.completion_tok).toBeGreaterThan(0)
    expect(a!.prompt_version).toBe(PROMPT_VERSION)
    expect(a!.model).toBeTruthy()
    expect(a!.had_positions).toBe(false)
    expect(JSON.parse(a!.flagged_json ?? '[]')).toBeInstanceOf(Array)
    // the open transcript knows the stored ids (for Delete)
    expect(st().turns.map((t) => t.id)).toEqual([u!.id, a!.id])
    expect(st().threads).toHaveLength(1)
    expect(st().threads[0]!.title).toBe('What is the gamma flip?')
  })

  it('privacy: nothing the fake database holds contains the key or any digest line', async () => {
    await st().ask('Explain this chart')
    const digest = fakeExplain.calls[0]!.digest
    const full = fakeThreads.dump()
    expect(full).not.toContain(KEY)
    expect(full).not.toContain('sk-')
    // The fake model's canned reply quotes some digest numbers back (that is the answer text, which is stored as written); every OTHER cell
    // (the question, hashes, tokens, flags, titles) must hold no digest line at all.
    let dump = full
    for (const m of fakeThreads.messages()) if (m.role === 'assistant') dump = dump.split(JSON.stringify(m.text).slice(1, -1)).join('')
    for (const line of digest.split('\n')) expect(dump, line).not.toContain(line)
    expect(full).toContain(fakeThreads.messages()[0]!.digest_hash!)
  })

  it('positions in the digest are only flagged, never stored', async () => {
    useRhStore.setState({ positions: [{ symbol: 'AAPL', quantity: 10, average_buy_price: 150.25, shares_available_for_sells: 10, shares_held_for_sells: 0 }] })
    st().setIncludePositions(true)
    await st().ask('q')
    expect(fakeThreads.messages().every((m) => m.had_positions)).toBe(true)
    expect(fakeThreads.dump()).not.toContain('150.25')
    expect(fakeThreads.dump()).not.toContain('qty=')
  })

  it('threads are per symbol and each symbol reopens its latest thread', async () => {
    await st().ask('about apple')
    chart('MSFT')
    await st().openSymbol('MSFT')
    expect(st().turns).toEqual([])
    expect(st().threadId).toBeNull()
    await st().ask('about microsoft')
    expect(st().threads).toHaveLength(1)
    await st().openSymbol('AAPL')
    expect(st().turns.map((t) => t.text)[0]).toBe('about apple')
    expect(st().turns).toHaveLength(2)
    await st().openSymbol('MSFT')
    expect(st().turns[0]!.text).toBe('about microsoft')
  })

  it('New thread starts empty; the old thread stays on the switcher; the newest is the active one', async () => {
    await st().ask('first topic')
    const first = st().threadId!
    st().newThread()
    expect(st().turns).toEqual([])
    expect(st().threadId).toBeNull()
    await st().ask('second topic')
    const second = st().threadId!
    expect(second).not.toBe(first)
    expect(st().threads.map((t) => t.id)).toEqual([second, first])
    await st().openThread(first)
    expect(st().turns[0]!.text).toBe('first topic')
    expect(st().threadId).toBe(first)
    // leaving and coming back picks the most recently UPDATED thread
    await st().ask('more on the first')
    await st().openSymbol('MSFT')
    await st().openSymbol('AAPL')
    expect(st().threadId).toBe(first)
  })

  it('a reopened thread replays at most 8 turns, trims old answers and never resends a digest', async () => {
    const seeded = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: i % 2 ? 'a'.repeat(1500) : `q${i}` }))
    fakeThreads.seed('AAPL', seeded as { role: 'user' | 'assistant'; text: string }[])
    await st().openSymbol('MSFT')
    await st().openSymbol('AAPL')
    expect(st().turns).toHaveLength(14)
    await st().ask('latest question')
    const call = fakeExplain.calls.at(-1)!
    expect(call.history).toHaveLength(8)
    expect(call.history.slice(0, -1).filter((h) => h.role === 'assistant').every((h) => h.text.length === 600)).toBe(true)
    expect(JSON.stringify(call.history)).not.toMatch(/CHART:|digest/)
  })

  it('a long loaded thread does not use up the per-session question limit', async () => {
    fakeThreads.seed('AAPL', Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` })) as { role: 'user' | 'assistant'; text: string }[])
    await st().openSymbol('MSFT')
    await st().openSymbol('AAPL')
    expect(await st().ask('still allowed')).toBe(true)
  })

  it('Delete on a message removes it and its partner, in the view and on disk', async () => {
    await st().ask('q1')
    await st().ask('q2')
    expect(st().turns).toHaveLength(4)
    await st().deleteMessage(3) // the second answer
    expect(st().turns.map((t) => t.text).filter((t) => t.startsWith('q'))).toEqual(['q1'])
    expect(st().turns).toHaveLength(2)
    expect(fakeThreads.messages()).toHaveLength(2)
    await st().deleteMessage(0) // the last question: the thread goes away
    expect(st().turns).toEqual([])
    expect(st().threadId).toBeNull()
    expect(st().threads).toEqual([])
    expect(fakeThreads.messages()).toEqual([])
  })

  it('Delete thread and Delete all chat history', async () => {
    await st().ask('a')
    st().newThread()
    await st().ask('b')
    const id = st().threadId!
    await st().deleteThread(id)
    expect(st().threads).toHaveLength(1)
    expect(st().threadId).toBeNull()
    expect(st().turns).toEqual([])
    chart('MSFT')
    await st().openSymbol('MSFT')
    await st().ask('c')
    await st().deleteAllHistory()
    expect(fakeThreads.messages()).toEqual([])
    expect(st().threads).toEqual([])
    expect(st().turns).toEqual([])
    expect(st().threadId).toBeNull()
  })

  it('save history off: the chat works, nothing is written, no thread appears', async () => {
    await st().setSaveHistory(false)
    expect(await api.settingGet('chat.saveHistory')).toBe('false')
    expect(await st().ask('private thought')).toBe(true)
    expect(st().turns).toHaveLength(2)
    expect(fakeThreads.messages()).toEqual([])
    expect(fakeThreads.dump()).toBe('')
    expect(st().threadId).toBeNull()
    // an in-memory Delete still works
    await st().deleteMessage(1)
    expect(st().turns).toEqual([])
    await st().setSaveHistory(true)
    expect(await api.settingGet('chat.saveHistory')).toBe('true')
  })

  it('save history is on by default and a garbled setting means on', async () => {
    await st().loadSaveHistory()
    expect(st().saveHistory).toBe(true)
    await api.settingSet('chat.saveHistory', 'maybe')
    await st().loadSaveHistory()
    expect(st().saveHistory).toBe(true)
    await api.settingSet('chat.saveHistory', 'false')
    await st().loadSaveHistory()
    expect(st().saveHistory).toBe(false)
  })

  it('a session wipe (Lock, Disconnect) closes the thread but keeps it on disk; reopening restores it', async () => {
    await st().ask('keep me')
    wipeSession()
    expect(st().turns).toEqual([])
    expect(st().threadId).toBeNull()
    expect(st().threads).toEqual([])
    expect(fakeThreads.messages()).toHaveLength(2)
    await st().openSymbol('AAPL')
    expect(st().turns[0]!.text).toBe('keep me')
  })

  it('a stopped answer is saved as the partial text it was', async () => {
    fakeExplain.chunkDelayMs = 15
    const p = st().ask('q')
    for (let i = 0; i < 200 && (st().streaming?.text.length ?? 0) < 4; i++) await sleep(5)
    await st().stop()
    await p
    const rows = fakeThreads.messages()
    expect(rows).toHaveLength(2)
    expect(rows[1]!.text).toBe(st().turns[1]!.text)
  })

  it('Export writes through the command and shows the path; with nothing open it says so', async () => {
    await st().exportThread()
    expect(st().notice).toMatch(/nothing to export/i)
    expect(st().error).toBe('')
    await st().ask('export me')
    await st().exportThread()
    expect(st().notice).toMatch(/^Saved to .*exports\/tradermatrix-explain-AAPL-.*\.md$/)
    expect(fakeThreads.exports).toHaveLength(1)
    const md = fakeThreads.exports[0]!
    expect(md).toContain('export me')
    expect(md).not.toContain(KEY)
    expect(md).not.toContain('CHART:')
  })
})

describe('fake threads enforce the Rust rules (the dev page must not lie)', () => {
  it('limits and validation mirror explain_threads.rs', async () => {
    await expect(api.explainThreadAppend(null, 'bad symbol!', [{ role: 'user', text: 'x' }])).rejects.toThrow()
    await expect(api.explainThreadAppend(null, 'AAPL', [{ role: 'system' as 'user', text: 'x' }])).rejects.toThrow()
    await expect(api.explainThreadAppend(null, 'AAPL', [{ role: 'user', text: 'x'.repeat(8001) }])).rejects.toThrow()
    await expect(api.explainThreadAppend(null, 'AAPL', [{ role: 'user', text: 'x', digest_hash: 'nothex' }])).rejects.toThrow()
    const o = (await api.explainThreadAppend(null, 'AAPL', [{ role: 'user', text: 'x' }]))!
    await expect(api.explainThreadAppend(o.thread_id, 'MSFT', [{ role: 'user', text: 'y' }])).rejects.toThrow()
    for (let i = 0; i < 230; i++) await api.explainThreadAppend(o.thread_id, 'AAPL', [{ role: 'user', text: `m${i}` }])
    expect((await api.explainThreadLoad(o.thread_id)).length).toBe(200)
    for (let i = 0; i < 52; i++) await api.explainThreadAppend(null, `S${i}`, [{ role: 'user', text: 'q' }])
    expect((await api.explainThreadList(null)).length).toBe(50)
  })
})
