import { useExplainStore } from '../stores/explain'

/**
 * "What I sent" (M16 A3): the exact data block, the instructions version, the model and a token estimate for the last question.
 * Kept in memory by the store only. There is no key anywhere in it (keys never leave Rust).
 */
export function ExplainDrawer() {
  const sent = useExplainStore((s) => s.lastSent)
  if (!sent) return null
  return (
    <details className="explain-drawer">
      <summary className="small muted">What I sent</summary>
      <div className="small explain-drawer-body">
        <div>
          Instructions version <code>{sent.promptVersion}</code> · model <code>{sent.model || 'provider default'}</code> · about {sent.estTokens} tokens of data and question ({sent.historyTurns} earlier turns replayed; the fixed instructions are not counted).
        </div>
        <div className="muted">Question</div>
        <pre className="explain-drawer-pre">{sent.question}</pre>
        <div className="muted">Data block (exactly as sent)</div>
        <pre className="explain-drawer-pre">{sent.digest}</pre>
      </div>
    </details>
  )
}
