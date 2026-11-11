import { useState } from 'react'
import { useExplainStore } from '../stores/explain'

/**
 * Thread switcher for the chart symbol (M16 B3): pick an earlier conversation about this symbol, start a New thread, export the open one as
 * Markdown, delete it, or delete all chat history. Saved text lives in the local database only; "Save chat history" off writes nothing.
 */
export function ExplainThreads({ symbol }: { symbol: string }) {
  const threads = useExplainStore((s) => s.threads)
  const threadId = useExplainStore((s) => s.threadId)
  const busy = useExplainStore((s) => s.busy)
  const saveHistory = useExplainStore((s) => s.saveHistory)
  const notice = useExplainStore((s) => s.notice)
  const hasTurns = useExplainStore((s) => s.turns.length > 0)
  const [sure, setSure] = useState(false)
  const st = useExplainStore.getState
  return (
    <div className="explain-threads small" role="group" aria-label={`Threads for ${symbol}`}>
      <select
        aria-label="Thread"
        value={threadId ?? ''}
        disabled={busy}
        onChange={(e) => {
          const v = e.target.value
          if (v === '') st().newThread()
          else void st().openThread(Number(v))
        }}
      >
        <option value="">{hasTurns || threadId !== null ? 'New thread' : 'New thread (empty)'}</option>
        {threads.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title || 'Untitled'} ({t.messages})
          </option>
        ))}
      </select>
      <button type="button" disabled={busy || (threadId === null && !hasTurns)} onClick={() => st().newThread()}>
        New thread
      </button>
      <button type="button" disabled={threadId === null} onClick={() => void st().exportThread()} title="Saves a Markdown file of this thread in the app's exports folder">
        Export
      </button>
      <button type="button" disabled={busy || threadId === null} onClick={() => threadId !== null && void st().deleteThread(threadId)}>
        Delete thread
      </button>
      {!sure && (
        <button type="button" disabled={busy} onClick={() => setSure(true)}>
          Delete all chat history
        </button>
      )}
      {sure && (
        <span className="explain-sure">
          Delete every saved thread for every symbol?{' '}
          <button
            type="button"
            onClick={() => {
              setSure(false)
              void st().deleteAllHistory()
            }}
          >
            Yes, delete all
          </button>{' '}
          <button type="button" onClick={() => setSure(false)}>
            Keep
          </button>
        </span>
      )}
      <label title="Off: nothing you ask or read here is written to disk">
        <input type="checkbox" checked={saveHistory} onChange={(e) => void st().setSaveHistory(e.target.checked)} /> Save chat history
      </label>
      {notice && (
        <span className="muted" role="status">
          {notice}
        </span>
      )}
    </div>
  )
}
