import { useMemo, type ReactNode } from 'react'
import { buildReply, type Run } from '../lib/explainReply'
import { LINT_NOTICE } from '../lib/explainLint'

/** One run as React text nodes only. No HTML is ever produced from reply text: no anchors, no images, no innerHTML. */
function RunView({ run }: { run: Run }) {
  let el: ReactNode = run.text
  if (run.code) el = <code>{el}</code>
  if (run.bold) el = <strong>{el}</strong>
  if (run.flagged)
    el = (
      <span className="num-flag" title="not in the data I sent">
        {el}
      </span>
    )
  if (run.def)
    el = (
      <span className="gloss" tabIndex={0} data-def={run.def}>
        {el}
      </span>
    )
  return <>{el}</>
}
const Runs = ({ runs }: { runs: Run[] }) => (
  <>
    {runs.map((r, i) => (
      <RunView key={i} run={r} />
    ))}
  </>
)

/**
 * A model reply (M16). Pipeline (lib/explainReply.ts): grounding check -> lint notice -> safe markdown -> glossary.
 * `digest` is the data that was sent for THIS reply (null = unknown, nothing is grounded).
 */
export function ExplainReply({ text, digest }: { text: string; digest: string | null }) {
  const r = useMemo(() => buildReply(text, digest), [text, digest])
  return (
    <div className="explain-text md">
      {r.blocks.map((b, i) => {
        if (b.t === 'p')
          return (
            <p key={i} className="md-p">
              <Runs runs={b.runs} />
            </p>
          )
        if (b.t === 'table')
          return (
            <table key={i} className="md-table">
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j}>
                      <Runs runs={c} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((c, k) => (
                      <td key={k}>
                        <Runs runs={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        const items = b.items.map((it, j) => (
          <li key={j} style={{ marginLeft: it.depth * 14 }}>
            <Runs runs={it.runs} />
          </li>
        ))
        return b.ordered ? (
          <ol key={i} className="md-list">
            {items}
          </ol>
        ) : (
          <ul key={i} className="md-list">
            {items}
          </ul>
        )
      })}
      {r.lintNotice && (
        <div className="explain-notice small" role="note">
          {LINT_NOTICE}
        </div>
      )}
    </div>
  )
}
