/**
 * Explain chat store (M14). EXPLAIN ONLY: this file (and the pane) must never import orders, ticketIntent or any rh place / review /
 * cancel call; a test greps for that. The question, a digest built from the other stores, and the last 8 turns go to the single
 * `explain_ask` command. Provider, address and key are saved by the single `llm_config_set` command (M14b); the key passes through
 * `saveConfig` as an argument and is never kept here. The store only knows the non-secret status (provider, address, model, key present).
 */
import { create } from 'zustand'
import { api, type AppendOut, type AskOut, type LlmDetect, type LlmStatus, type NewMessage, type ThreadMeta, type UsageSummary } from '../lib/api'
import { keyShapeError, providerInfo } from '../lib/llmProviders'
import { buildExplainDigest, EMPTY_EXPLAIN_STATE, type BarRow, type ExplainState, type PositionDigest, type SectionsState } from '../lib/explainDigest'
import { groundReply } from '../lib/explainGround'
import { BUDGET_MONTH_KEY, BUDGET_SESSION_KEY, CHAT_MODE_KEY, CHAT_SAVE_HISTORY_KEY, DEFAULT_MODE, estimateTokens, isValidModel, MAX_PROMPT_CHARS, MAX_USER_MESSAGES, newRequestId, parseMode, PROMPT_VERSION, replayHistory, serializeMode, toErrorCode, type ExplainErrorCode, type ExplainMode, type Turn } from '../lib/explainPrompt'
import { looksLikeSecret } from '../lib/redact'
import { useChartContext } from './chartContext'
import { useFocusStore } from './explainFocus'
import { useRhStore } from './rh'
import { useTmStore } from './tm'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Assembles the digest input from what the other stores already hold. Positions only when `includePositions` (default off). */
/** `extra.sections` = the "Ask about this" fragment (M16 B4); `extra.includeBars` = the user ticked "Include recent bars". Both default off. */
export function collectExplainState(includePositions: boolean, extra?: { sections?: SectionsState | null; includeBars?: boolean }): ExplainState {
  const cc = useChartContext.getState()
  const rh = useRhStore.getState()
  const symbol = cc.chart?.symbol ?? rh.chartSymbol
  const tm = useTmStore.getState()
  const entry = tm.bySymbol[symbol]
  const apex = entry?.apex.data ?? null
  const move = entry?.move.data ?? null
  const hz = move ? (move.horizons.find((h) => h.label === tm.settings.horizon) ?? move.horizons[0] ?? null) : null
  const ranked = apex ? [...apex.levels].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).map((l) => l.strike).filter((x): x is number => typeof x === 'number') : []
  const positions: PositionDigest[] = includePositions
    ? [
        ...rh.positions.map((p): PositionDigest => ({ kind: 'equity', symbol: p.symbol, qty: p.quantity, avg: p.average_buy_price })),
        ...rh.optionPositions.map(
          (o): PositionDigest => ({
            kind: 'option',
            symbol: o.chain_symbol,
            right: o.option_type,
            strike: o.strike_price,
            expiration: o.expiration_date,
            qty: o.side === 'short' ? -Math.abs(o.quantity) : o.side === 'long' ? Math.abs(o.quantity) : null,
            avg: o.average_price,
          }),
        ),
      ]
    : []
  return {
    ...EMPTY_EXPLAIN_STATE,
    chart: cc.chart ?? { symbol, tf: null, bars: null, last: null, hi: null, lo: null, chg: null, estBuyShare: null },
    overlays: cc.overlays,
    fib: cc.fib,
    strike: cc.strike,
    levels: apex || move ? { apex: ranked, flip: apex?.gamma_flip ?? null, emLo: hz?.band68?.low ?? null, emHi: hz?.band68?.high ?? null, emPct: hz?.expected_move_pct ?? null } : null,
    ivRank: entry?.iv.data?.iv_rank ?? null,
    positions,
    sections: sectionsFor(extra?.sections ?? null, extra?.includeBars ? cc.recentBars : null),
  }
}

function sectionsFor(focus: SectionsState | null, bars: readonly { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[] | null): SectionsState | undefined {
  if (!focus && !(bars && bars.length)) return undefined
  const rows: BarRow[] | undefined = bars && bars.length ? bars.slice(-30).map((b) => ({ ts: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })) : undefined
  return { ...(focus ?? {}), ...(rows ? { bars: rows } : {}) }
}

export interface SaveForm {
  provider: string
  /** null = keep the current address (hosted providers have a fixed one). */
  baseUrl: string | null
  /** The key leaves this object into `llm_config_set` and is never stored. null = keep the saved key. */
  apiKey: string | null
  model: string | null
  compat: boolean | null
  /** Hermes only: "I accept plain LAN http". */
  lanHttp?: boolean | null
}
/** What one question sent (A3). In memory only: never persisted, never holds a key. */
export interface Sent {
  digest: string
  promptVersion: string
  model: string
  /** ceil(chars / 4) over the digest, the question and the replayed turns (the fixed instructions are not counted). */
  estTokens: number
  question: string
  historyTurns: number
  /** The "Ask about this" fragment that rode along (memory only; Retry reuses it). */
  focus?: SectionsState | null
}
/** One transcript turn. `id` = the stored message id (when history is saved), `partial` = the answer was stopped or cut off. */
export interface ChatTurn extends Turn {
  id?: number
  partial?: boolean
}
/** The in-flight answer: its request id, the text so far and the thread view (`gen`) it belongs to. */
export interface Streaming {
  requestId: string
  text: string
  gen: number
}
export type SentLogEntry = Sent & { /** Index in `turns` of the assistant reply this was sent for. */ turnIndex: number }
export type TestResult = { ok: true } | { ok: false; code: ExplainErrorCode }

interface ExplainStore {
  turns: ChatTurn[]
  busy: boolean
  /** Non-null while an answer streams in (M16 B1). */
  streaming: Streaming | null
  /** The header meter (M16 B2). null = not loaded. */
  usage: UsageSummary | null
  /** Setting `chat.saveHistory` (default true): off = nothing is written to disk. */
  saveHistory: boolean
  /** Threads for `threadSymbol`, newest first (M16 B3); `threadId` = the open one (null = a new, unsaved thread). */
  threads: ThreadMeta[]
  threadId: number | null
  threadSymbol: string | null
  /** Bumped whenever another thread is shown, so a late answer never lands in the wrong one. */
  threadGen: number
  /** Questions sent this session (the 40 limit); reopening a long thread does not count. */
  sessionAsks: number
  /** One-line result of the last export or delete ('' = none). */
  notice: string
  /** Fixed code of the last failure ('' when fine). Never provider text. */
  error: ExplainErrorCode | ''
  includePositions: boolean
  /** "Include recent bars" (default off): adds the BARS section (last 30 OHLCV lines) to the digest. */
  includeBars: boolean
  /** Non-secret provider status from `llm_config_status`. null = not loaded yet (or wiped). provider === null = nothing set up. */
  config: LlmStatus | null
  /** What is installed / running on this computer (loopback probes and a PATH search). null = not probed. */
  detect: LlmDetect | null
  setupOpen: boolean
  saving: boolean
  testing: boolean
  testResult: TestResult | null
  epoch: number
  /** Teaching mode (A6), a closed enum persisted as the `chat.mode` setting. Survives a session wipe (it is a preference). */
  mode: ExplainMode
  /** The last question's payload (A3), shown in the "What I sent" drawer; set at send time, so it also shows a failed ask. */
  lastSent: Sent | null
  /** One entry per answered question; the pane grounds each reply against the digest that produced it. */
  sentLog: SentLogEntry[]
  setMode: (m: ExplainMode) => Promise<void>
  loadMode: () => Promise<void>
  /** Resolves true when an answer (or the part of one that arrived) was added. `retryIndex` = replace the question + answer at that turn. */
  ask: (question: string, opts?: { retryIndex?: number }) => Promise<boolean>
  /** Stop: ends the in-flight answer, keeping the text that already arrived. */
  stop: () => Promise<void>
  /** Re-asks the last question with a fresh digest, replacing the last answer. */
  retry: () => Promise<boolean>
  refreshUsage: () => Promise<void>
  setBudget: (kind: 'session_tokens' | 'month_usd', value: number) => Promise<void>
  loadSaveHistory: () => Promise<void>
  setSaveHistory: (v: boolean) => Promise<void>
  loadThreadList: (symbol: string) => Promise<void>
  openSymbol: (symbol: string) => Promise<void>
  openThread: (id: number) => Promise<void>
  newThread: () => void
  deleteMessage: (index: number) => Promise<void>
  deleteThread: (id: number) => Promise<void>
  deleteAllHistory: () => Promise<void>
  exportThread: () => Promise<void>
  setIncludePositions: (v: boolean) => void
  setIncludeBars: (v: boolean) => void
  loadConfig: () => Promise<void>
  runDetect: () => Promise<void>
  openSetup: (open: boolean) => void
  /** Returns '' on success or a message that never contains the key. */
  saveConfig: (f: SaveForm) => Promise<string>
  clearConfig: () => Promise<string>
  runTest: () => Promise<void>
  /** Session wipe (Disconnect, Lock vault): drop the transcript and any in-flight answer. The provider choice is re-read afterwards. */
  wipe: () => void
  reset: () => void
}

const needsSetup = (c: LlmStatus | null): boolean => {
  if (!c) return false // unknown: let the backend answer (it says no_key)
  if (!c.provider) return true
  const p = providerInfo(c.provider)
  return !!p?.needsKey && !c.key_present
}
export const configNeedsSetup = needsSetup

/** Indexes a Delete takes with `index`: a question takes the answer after it, an answer takes the question before it (same rule as explain_threads.rs). */
export function pairOf(turns: readonly ChatTurn[], index: number): number[] {
  const t = turns[index]
  if (!t) return []
  if (t.role === 'user') return turns[index + 1]?.role === 'assistant' ? [index, index + 1] : [index]
  return turns[index - 1]?.role === 'user' ? [index - 1, index] : [index]
}

const FRESH = {
  turns: [] as ChatTurn[],
  busy: false,
  streaming: null as Streaming | null,
  usage: null as UsageSummary | null,
  threads: [] as ThreadMeta[],
  threadId: null as number | null,
  threadSymbol: null as string | null,
  sessionAsks: 0,
  notice: '',
}

/** Builds the two rows for one answered question. The digest never goes in, only its hash (from Rust) and the grounding flags. */
function messagesFor(question: string, text: string, sent: Sent, out: AskOut | null, includePositions: boolean): NewMessage[] {
  const flagged = groundReply(text, sent.digest).flagged.map((f) => ({ text: f.text, start: f.start, end: f.end }))
  let flaggedJson = JSON.stringify(flagged)
  for (let n = flagged.length; flaggedJson.length > 3500 && n > 0; ) flaggedJson = JSON.stringify(flagged.slice(0, --n))
  const hash = out?.digest_hash ?? null
  return [
    { role: 'user', text: question, digest_hash: hash, had_positions: includePositions, prompt_version: PROMPT_VERSION },
    {
      role: 'assistant',
      text,
      prompt_tok: out?.usage.prompt ?? null,
      completion_tok: out?.usage.completion ?? null,
      model: out?.model || null,
      digest_hash: hash,
      had_positions: includePositions,
      prompt_version: PROMPT_VERSION,
      flagged_json: flaggedJson,
    },
  ]
}

export const useExplainStore = create<ExplainStore>((set, get) => ({
  ...FRESH,
  saveHistory: true,
  threadGen: 0,
  error: '',
  includePositions: false,
  includeBars: false,
  config: null,
  detect: null,
  setupOpen: false,
  saving: false,
  testing: false,
  testResult: null,
  epoch: 0,
  mode: DEFAULT_MODE,
  lastSent: null,
  sentLog: [],

  setMode: async (m) => {
    set({ mode: m })
    try {
      await api.settingSet(CHAT_MODE_KEY, serializeMode(m))
    } catch {
      /* the choice still holds for this session */
    }
  },
  loadMode: async () => {
    try {
      set({ mode: parseMode(await api.settingGet(CHAT_MODE_KEY)) })
    } catch {
      /* keeps the default */
    }
  },

  ask: async (raw, opts) => {
    const s = get()
    if (s.busy) return false
    const question = raw.trim()
    if (!question) return false
    if ([...question].length > MAX_PROMPT_CHARS) {
      set({ error: 'too_long' })
      return false
    }
    // M16 B7: a pasted key never leaves the webview (nothing is sent or saved).
    if (looksLikeSecret(question)) {
      set({ error: 'key_like' })
      return false
    }
    if (s.sessionAsks >= MAX_USER_MESSAGES) {
      set({ error: 'limit' })
      return false
    }
    if (needsSetup(s.config)) {
      set({ error: 'no_key' })
      return false
    }
    const model = s.config?.model ?? ''
    if (model && !isValidModel(model)) {
      set({ error: 'bad_request' })
      return false
    }
    const epoch = s.epoch
    const includePositions = s.includePositions
    const includeBars = s.includeBars
    // the pointed-at fragment (M16 B4): the pending one, or (on Retry) the one that went with the question being retried
    const pending = useFocusStore.getState().focus
    const retryFocus = opts?.retryIndex !== undefined ? (s.sentLog.find((x) => x.turnIndex === opts.retryIndex! + 1)?.focus ?? null) : null
    const focusSections = pending?.sections ?? retryFocus
    const symbol = collectExplainState(includePositions).chart?.symbol ?? ''
    const requestId = newRequestId()
    // Busy first (before any await): a double click or a second Ask can never start a second request.
    set({ busy: true, error: '', notice: '', streaming: { requestId, text: '', gen: s.threadGen } })
    let acc = ''
    try {
      if (get().threadSymbol !== symbol) {
        if (get().threadSymbol === null && get().turns.length === 0) set({ threadSymbol: symbol })
        else await get().openSymbol(symbol)
        if (get().epoch !== epoch) return false
      }
      let base = get().turns
      if (opts?.retryIndex !== undefined && get().turns[opts.retryIndex]?.role === 'user') {
        // Retry: the old question + answer go (view and disk) and the same question is asked again, below, with a fresh digest.
        const old = get().turns[opts.retryIndex]
        base = get().turns.slice(0, opts.retryIndex)
        const tid = get().threadId
        if (old?.id !== undefined && tid !== null) {
          try {
            await api.explainThreadDelete(tid, old.id)
          } catch {
            /* the old rows stay on disk; the view still drops them */
          }
          if (base.length === 0) set({ threadId: null })
        }
        if (get().epoch !== epoch) return false
        set({ turns: base, sentLog: get().sentLog.filter((x) => x.turnIndex < base.length) })
      }
      const gen = get().threadGen
      const threadId = get().threadId
      const history = replayHistory(base)
      const digest = buildExplainDigest(collectExplainState(includePositions, { sections: focusSections, includeBars }), { includePositions })
      const chars = [...digest].length + [...question].length + history.reduce((n, h) => n + [...h.text].length, 0)
      const sent: Sent = { digest, promptVersion: PROMPT_VERSION, model, estTokens: estimateTokens(chars), question, historyTurns: history.length, focus: focusSections }
      set({ lastSent: sent, streaming: { requestId, text: '', gen } })
      let out: AskOut | null = null
      let failure: unknown = null
      try {
        out = await api.explainAsk(model, digest, question, history, s.mode, requestId, (t) => {
          if (get().epoch !== epoch) return
          acc += t
          const cur = get().streaming
          if (cur && cur.requestId === requestId) set({ streaming: { ...cur, text: acc } })
        })
      } catch (e) {
        failure = e
      }
      const wiped = get().epoch !== epoch
      const text = out ? out.text : acc
      const code: ExplainErrorCode | '' = failure ? toErrorCode(failure) : ''
      if (!text.trim()) {
        if (!wiped) {
          set({ streaming: null, error: code })
          void get().refreshUsage()
        }
        return false
      }
      // the fragment rode on this question: it is spent once any answer text arrived (a failed ask with no text keeps it for the next try)
      if (pending && useFocusStore.getState().focus?.id === pending.id) useFocusStore.getState().clearFocus()
      const partial = out ? out.end === 'cancelled' : true
      const turn: ChatTurn = partial ? { role: 'assistant', text, partial: true } : { role: 'assistant', text }
      const here = !wiped && get().threadGen === gen
      let at = -1
      if (here) {
        const before = get().turns
        at = before.length
        set({ turns: [...before, { role: 'user', text: question }, turn], streaming: null, error: code, sessionAsks: get().sessionAsks + 1, sentLog: [...get().sentLog, { ...sent, turnIndex: at + 1 }] })
      } else if (!wiped) {
        set({ streaming: null, error: code })
      }
      // Saved even when the session was wiped mid-answer (the history stays on disk); a no-op when "save history" is off.
      let saved: AppendOut | null = null
      try {
        saved = await api.explainThreadAppend(threadId, symbol, messagesFor(question, text, sent, out, includePositions))
      } catch {
        saved = null
      }
      if (saved && here && get().epoch === epoch && get().threadGen === gen) {
        const ids = saved.message_ids
        const turns = get().turns.map((t, i) => (i === at ? { ...t, id: ids[0] } : i === at + 1 ? { ...t, id: ids[1] } : t))
        set({ turns, threadId: saved.thread_id })
        void get().loadThreadList(symbol)
      }
      if (!wiped) void get().refreshUsage()
      return !wiped
    } finally {
      if (get().epoch === epoch) set({ busy: false, streaming: null })
    }
  },

  stop: async () => {
    const cur = get().streaming
    if (!cur) return
    try {
      await api.explainStop(cur.requestId)
    } catch {
      /* the answer ends on its own */
    }
  },

  retry: async () => {
    const t = get().turns
    const last = t.length - 1
    if (get().busy || last < 1 || t[last]!.role !== 'assistant' || t[last - 1]!.role !== 'user') return false
    return get().ask(t[last - 1]!.text, { retryIndex: last - 1 })
  },

  refreshUsage: async () => {
    const epoch = get().epoch
    try {
      const u = await api.explainUsageSummary(false)
      if (get().epoch === epoch) set({ usage: u })
    } catch {
      /* the meter just stays as it was */
    }
  },
  setBudget: async (kind, value) => {
    const ok = kind === 'session_tokens' ? Number.isInteger(value) && value >= 1000 && value <= 10_000_000 : Number.isFinite(value) && value > 0 && value <= 10_000
    if (!ok) return
    try {
      await api.settingSet(kind === 'session_tokens' ? BUDGET_SESSION_KEY : BUDGET_MONTH_KEY, JSON.stringify(value))
    } catch {
      return
    }
    await get().refreshUsage()
  },
  loadSaveHistory: async () => {
    try {
      const raw = await api.settingGet(CHAT_SAVE_HISTORY_KEY)
      let on = true
      if (raw) {
        try {
          on = JSON.parse(raw.trim()) !== false
        } catch {
          on = true
        }
      }
      set({ saveHistory: on })
    } catch {
      /* keeps the default */
    }
  },
  setSaveHistory: async (v) => {
    set({ saveHistory: v })
    try {
      await api.settingSet(CHAT_SAVE_HISTORY_KEY, JSON.stringify(v))
    } catch {
      /* the choice still holds for this session */
    }
  },

  loadThreadList: async (symbol) => {
    try {
      const list = await api.explainThreadList(symbol)
      if (get().threadSymbol === symbol) set({ threads: list })
    } catch {
      /* the switcher keeps what it had */
    }
  },
  openSymbol: async (symbol) => {
    const gen = get().threadGen + 1
    set({ threadSymbol: symbol, threadGen: gen, turns: [], threadId: null, sentLog: [], threads: [], notice: '' })
    try {
      const list = await api.explainThreadList(symbol)
      if (get().threadGen !== gen) return
      set({ threads: list })
      if (list[0]) await get().openThread(list[0].id)
    } catch {
      /* no saved threads: an empty one */
    }
  },
  openThread: async (id) => {
    const gen = get().threadGen + 1
    set({ threadGen: gen })
    try {
      const msgs = await api.explainThreadLoad(id)
      if (get().threadGen !== gen) return
      set({ turns: msgs.map((m): ChatTurn => (m.role === 'assistant' ? { role: 'assistant', text: m.text, id: m.id } : { role: 'user', text: m.text, id: m.id })), threadId: id, sentLog: [], notice: '' })
    } catch {
      /* stays on the current view */
    }
  },
  newThread: () => set({ turns: [], threadId: null, sentLog: [], error: '', notice: '', threadGen: get().threadGen + 1 }),

  deleteMessage: async (index) => {
    const s = get()
    const gone = pairOf(s.turns, index)
    if (s.busy || gone.length === 0) return
    const target = s.turns[index]!
    const tid = s.threadId
    const remap = (i: number) => i - gone.filter((g) => g < i).length
    set({
      turns: s.turns.filter((_, i) => !gone.includes(i)),
      sentLog: s.sentLog.filter((x) => !gone.includes(x.turnIndex)).map((x) => ({ ...x, turnIndex: remap(x.turnIndex) })),
    })
    if (target.id !== undefined && tid !== null) {
      try {
        await api.explainThreadDelete(tid, target.id)
      } catch {
        /* still on disk */
      }
      if (get().threadId === tid && get().turns.length === 0) set({ threadId: null })
      if (s.threadSymbol) await get().loadThreadList(s.threadSymbol)
    }
  },
  deleteThread: async (id) => {
    try {
      await api.explainThreadDelete(id, null)
    } catch {
      return
    }
    if (get().threadId === id) set({ turns: [], threadId: null, sentLog: [], threadGen: get().threadGen + 1 })
    const sym = get().threadSymbol
    if (sym) await get().loadThreadList(sym)
  },
  deleteAllHistory: async () => {
    try {
      await api.explainThreadDeleteAll()
    } catch {
      return
    }
    set({ turns: [], threadId: null, threads: [], sentLog: [], notice: 'All chat history was deleted.', threadGen: get().threadGen + 1 })
  },
  exportThread: async () => {
    const id = get().threadId
    if (id === null) {
      set({ notice: 'Nothing to export yet.' })
      return
    }
    try {
      const path = await api.explainThreadExport(id)
      set({ notice: `Saved to ${path}` })
    } catch {
      set({ notice: 'Could not export this thread.' })
    }
  },

  setIncludePositions: (v) => set({ includePositions: v }),
  setIncludeBars: (v) => set({ includeBars: v }),

  loadConfig: async () => {
    try {
      set({ config: await api.llmConfigStatus() })
    } catch {
      /* stays unknown */
    }
  },
  runDetect: async () => {
    try {
      set({ detect: await api.llmDetect() })
    } catch {
      set({ detect: { claude_cli: false, ollama: false, lmstudio: false } })
    }
  },
  openSetup: (open) => set({ setupOpen: open, testResult: open ? get().testResult : null }),

  saveConfig: async (f) => {
    // Cheap shape check on the key before it leaves the page; Rust validates again.
    const p = providerInfo(f.provider)
    if (p && f.apiKey && keyShapeError(p, f.apiKey)) return keyShapeError(p, f.apiKey) ?? ''
    set({ saving: true })
    try {
      const status = await api.llmConfigSet(f.provider, f.baseUrl, f.apiKey, f.model, f.compat, f.lanHttp ?? null)
      set({ saving: false, config: status, testResult: null, error: get().error === 'no_key' ? '' : get().error })
      return ''
    } catch (e) {
      set({ saving: false })
      const m = (e instanceof Error ? e.message : String(e)).trim()
      const scrubbed = f.apiKey ? m.split(f.apiKey.trim()).join('[hidden]') : m
      return scrubbed === 'bad_request' ? 'That setup was refused (check the address, the key and the model).' : scrubbed
    }
  },
  clearConfig: async () => {
    set({ saving: true })
    try {
      await api.llmConfigClear()
    } catch (e) {
      set({ saving: false })
      return e instanceof Error ? e.message : String(e)
    }
    set({ saving: false, testResult: null })
    await get().loadConfig()
    return ''
  },
  runTest: async () => {
    if (get().testing) return
    set({ testing: true, testResult: null })
    try {
      await api.llmTest()
      set({ testing: false, testResult: { ok: true } })
    } catch (e) {
      set({ testing: false, testResult: { ok: false, code: toErrorCode(e) } })
    }
  },

  wipe: () => {
    const cur = get().streaming
    // Stop the in-flight answer (no more text) and forget this session's token count; the saved threads stay on disk.
    if (cur) void api.explainStop(cur.requestId).catch(() => undefined)
    void api.explainUsageSummary(true).catch(() => undefined)
    useFocusStore.getState().reset()
    set({ ...FRESH, includeBars: false, error: '', lastSent: null, sentLog: [], config: null, testing: false, testResult: null, saving: false, threadGen: get().threadGen + 1, epoch: get().epoch + 1 })
  },
  reset: () => {
    useFocusStore.getState().reset()
    set({ ...FRESH, error: '', lastSent: null, sentLog: [], mode: DEFAULT_MODE, includePositions: false, includeBars: false, config: null, detect: null, setupOpen: false, saving: false, testing: false, testResult: null, epoch: 0, saveHistory: true, threadGen: 0 })
  },
}))
