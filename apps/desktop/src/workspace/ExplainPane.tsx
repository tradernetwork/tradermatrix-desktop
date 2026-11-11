import { useEffect, useRef, useState } from 'react'
import { ARYA_INTRO } from '../lib/brand'
import { chipsFor } from '../lib/explainChips'
import { copyPlain } from '../lib/explainCopy'
import { ERROR_TEXT, EXPLAIN_MODES, MAX_PROMPT_CHARS } from '../lib/explainPrompt'
import { aryaStateFor, factForDay, flaggedCountFor, freshness, naMessage, naNotes } from '../lib/explainStates'
import { positionsWarning, providerInfo } from '../lib/llmProviders'
import { useChartContext } from '../stores/chartContext'
import { collectExplainState, configNeedsSetup, useExplainStore } from '../stores/explain'
import { useFocusStore } from '../stores/explainFocus'
import { useRhStore } from '../stores/rh'
import { useTmStore } from '../stores/tm'
import { useVaultStore } from '../stores/vault'
import { ArayaAvatar } from './ArayaAvatar'
import { EmptyState } from './EmptyState'
import { ExplainDrawer } from './ExplainDrawer'
import { ExplainMeter } from './ExplainMeter'
import { ExplainReply } from './ExplainReply'
import { ExplainSetup } from './ExplainSetup'
import { ExplainThreads } from './ExplainThreads'

/**
 * Explain pane (M14). EXPLAIN ONLY: it describes what is on screen. It has no order, ticket or proposal path of any kind.
 * Replies render through ExplainReply (React text nodes only, no HTML, links are not links); your own questions are plain text.
 */
export function ExplainPane() {
  const turns = useExplainStore((s) => s.turns)
  const busy = useExplainStore((s) => s.busy)
  const error = useExplainStore((s) => s.error)
  const config = useExplainStore((s) => s.config)
  const setupOpen = useExplainStore((s) => s.setupOpen)
  const includePositions = useExplainStore((s) => s.includePositions)
  const includeBars = useExplainStore((s) => s.includeBars)
  const focus = useFocusStore((s) => s.focus)
  const mode = useExplainStore((s) => s.mode)
  const sentLog = useExplainStore((s) => s.sentLog)
  const streaming = useExplainStore((s) => s.streaming)
  const threadGen = useExplainStore((s) => s.threadGen)
  const epoch = useExplainStore((s) => s.epoch)
  // chips are rebuilt from the on-screen state: re-render when the chart context or the TM data changes
  useChartContext((s) => s)
  useTmStore((s) => s.bySymbol)
  const asOf = useChartContext((s) => s.asOf)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const vaultUnlocked = useVaultStore((s) => s.status?.unlocked)
  const chartSymbol = useRhStore((s) => s.chartSymbol)
  const symbol = useChartContext((s) => s.chart?.symbol) ?? chartSymbol
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState<number | null>(null)
  const end = useRef<HTMLDivElement>(null)

  const configUnknown = config === null
  useEffect(() => {
    void useExplainStore.getState().loadConfig()
  }, [vaultUnlocked, configUnknown])
  useEffect(() => {
    void useExplainStore.getState().loadMode()
    void useExplainStore.getState().loadSaveHistory()
    void useExplainStore.getState().refreshUsage()
  }, [epoch])
  // One thread per symbol: switching the chart symbol (or unlocking after a wipe) opens that symbol's latest saved thread.
  useEffect(() => {
    if (vaultUnlocked === false) return
    if (useExplainStore.getState().threadSymbol !== symbol) void useExplainStore.getState().openSymbol(symbol)
  }, [symbol, vaultUnlocked, epoch])
  // The digest reads TM levels from the TM store: make sure this symbol's three legs are loaded (cached 60 s / 5 min, reads only).
  useEffect(() => {
    void useTmStore.getState().loadSymbol(symbol, ['apex', 'move', 'iv'])
  }, [symbol])
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [turns, busy, streaming?.text])

  // "Ask about this" (M16 B4): the menu choice prefills the question box. It never sends; the user presses Ask.
  const focusId = focus?.id
  useEffect(() => {
    const f = useFocusStore.getState().focus
    if (f) setDraft(f.question)
  }, [focusId])

  const send = async (text: string) => {
    const ok = await useExplainStore.getState().ask(text)
    if (ok) setDraft('')
  }
  const over = [...draft].length > MAX_PROMPT_CHARS
  const needsSetup = configNeedsSetup(config)
  const prov = providerInfo(config?.provider)
  // Arya's state (M16 B6): from the store flags; the newest answer's grounding flags decide "check numbers"
  const lastIdx = turns.map((t) => t.role).lastIndexOf('assistant')
  const flagged = lastIdx >= 0 ? flaggedCountFor(turns[lastIdx]!.text, sentLog.find((x) => x.turnIndex === lastIdx)?.digest ?? null) : 0
  const streamingText = !!(streaming && streaming.gen === threadGen && streaming.text)
  const arya = aryaStateFor({ busy, streamingText, flagged, error: !!error })
  const stamp = freshness(asOf, now)

  return (
    <div className="pane explain-pane">
      <div className="explain-banner" role="note">
        Explains what is on screen. It does not place or suggest orders.
      </div>
      {(needsSetup || setupOpen) && <ExplainSetup />}
      {!(needsSetup || setupOpen) && (
        <>
          <div className="pane-head explain-head">
            <span className="small" title="Where the answers come from">
              {prov ? prov.label : 'Provider'}
              {config?.model ? ` \u00b7 ${config.model}` : ''}
            </span>
            <button type="button" onClick={() => useExplainStore.getState().openSetup(true)} disabled={busy}>
              Change provider
            </button>
            <label className="small" title="Adds your open positions (symbol, quantity, average price; no account numbers) to what the model sees. Off by default.">
              <input type="checkbox" checked={includePositions} onChange={(e) => useExplainStore.getState().setIncludePositions(e.target.checked)} /> Include my positions
            </label>
            <label className="small" title="Adds the last 30 bars on screen (open, high, low, close, volume) to what the model sees. Off by default.">
              <input type="checkbox" checked={includeBars} onChange={(e) => useExplainStore.getState().setIncludeBars(e.target.checked)} /> Include recent bars
            </label>
            <div className="explain-mode" role="group" aria-label="Teaching mode">
              {EXPLAIN_MODES.map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? 'sel' : ''} onClick={() => void useExplainStore.getState().setMode(m)} title={m === 'beginner' ? 'Defines terms and uses everyday words' : 'Terse and numeric, skips definitions'}>
                  {m === 'beginner' ? 'Beginner' : 'Trader'}
                </button>
              ))}
            </div>
            <span className="muted small">{symbol}</span>
            <ArayaAvatar state={arya} size={22} />
            {stamp && (
              <span className="explain-fresh small" data-testid="explain-fresh" title="When the chart data on screen last arrived">
                {stamp}
              </span>
            )}
          </div>
          {positionsWarning(config?.provider) && (
            <div className="explain-warn small" role="note">
              {positionsWarning(config?.provider)}
            </div>
          )}
          <ExplainThreads symbol={symbol} />
          <ExplainMeter />
      <div className="explain-chips" role="group" aria-label="Quick questions">
        {chipsFor(collectExplainState(false)).map((p) => (
          <button key={p} type="button" disabled={busy} onClick={() => void send(p)}>
            {p}
          </button>
        ))}
      </div>
      <div className="explain-log" role="log" aria-live="polite" aria-label="Explain transcript">
        {turns.length === 0 && !busy && (
          <EmptyState className="arya-intro">
            <ArayaAvatar look="wry" size={56} />
            <div>
              <div className="arya-intro-line">{ARYA_INTRO}</div>
              <div className="muted small">Ask about the chart, the Apex levels, the expected move or the strike check.</div>
              <div className="arya-fact small" data-testid="arya-fact">
                Today: {factForDay(new Date())}
              </div>
            </div>
          </EmptyState>
        )}
        {turns.map((t, i) => (
          <div key={t.id ?? `t${i}`} className={`explain-turn ${t.role}`}>
            {t.role === 'assistant' && <ArayaAvatar size={28} state={i === lastIdx && flagged > 0 ? 'check' : undefined} />}
            <div className="explain-body">
              <span className="explain-who">{t.role === 'user' ? 'You' : 'Arya'}</span>
              {t.role === 'user' ? <div className="explain-text">{t.text}</div> : <ExplainReply text={t.text} digest={sentLog.find((x) => x.turnIndex === i)?.digest ?? null} />}
              {t.partial && <div className="muted small">This answer was cut short. Retry asks it again.</div>}
              {t.role === 'assistant' && i > 0 && turns[i - 1]!.role === 'user' && (() => {
                const dg = sentLog.find((x) => x.turnIndex === i)?.digest
                const na = dg ? naNotes(turns[i - 1]!.text, dg) : []
                return na.length > 0 ? (
                  <div className="explain-na small" data-testid="explain-na">
                    {naMessage(na)}
                  </div>
                ) : null
              })()}
              <div className="explain-actions small">
                {t.role === 'assistant' && (
                  <button
                    type="button"
                    onClick={() => {
                      void copyPlain(t.text).then((ok) => setCopied(ok ? i : null))
                    }}
                  >
                    {copied === i ? 'Copied' : 'Copy'}
                  </button>
                )}
                {t.role === 'assistant' && i === turns.length - 1 && (
                  <button type="button" disabled={busy} onClick={() => void useExplainStore.getState().retry()} title="Ask the same question again with fresh data">
                    Retry
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => void useExplainStore.getState().deleteMessage(i)} title="Deletes this message and the one it goes with">
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
        {busy && (
          <div className="explain-turn assistant">
            <ArayaAvatar state={streamingText ? 'streaming' : 'thinking'} size={28} />
            {streaming && streaming.gen === threadGen && streaming.text ? (
              <div className="explain-body">
                <span className="explain-who">Arya</span>
                <ExplainReply text={streaming.text} digest={null} />
              </div>
            ) : (
              <div className="muted small">Thinking...</div>
            )}
          </div>
        )}
        <div ref={end} />
      </div>
      <ExplainDrawer />
      {error && (
        <div className="err small" role="alert">
          {ERROR_TEXT[error]}
        </div>
      )}
      {focus && (
        <div className="explain-focus small" role="note" data-testid="explain-focus">
          <span>Pointed at: {focus.label}.</span>
          <span className="muted">Its numbers go with your next question.</span>
          <button type="button" onClick={() => useFocusStore.getState().clearFocus()}>
            Clear
          </button>
        </div>
      )}
      <form
        className="explain-input"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && draft.trim() && !over) void send(draft)
        }}
      >
        <textarea
          aria-label="Question"
          rows={2}
          value={draft}
          placeholder="What am I looking at?"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!busy && draft.trim() && !over) void send(draft)
            }
          }}
        />
        <div className="explain-input-row">
          <span className={`small ${over ? 'err' : 'muted'}`} data-testid="explain-counter">
            {[...draft].length}/{MAX_PROMPT_CHARS}
          </span>
          {busy ? (
            <button type="button" onClick={() => void useExplainStore.getState().stop()} title="Stop the answer; what arrived so far is kept">
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim() || over}>
              Ask
            </button>
          )}
        </div>
      </form>
        </>
      )}
    </div>
  )
}
