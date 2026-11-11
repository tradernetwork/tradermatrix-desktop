import { Fragment } from 'react'
import { askAbout } from '../../stores/explainFocus'
import type { LadderRow } from './ladder'

export const LADDER_WIDTH_PX = 70

const SOURCE_NAME: Record<string, string> = { tm: 'TraderMatrix Apex level', flip: 'TraderMatrix gamma flip', em: 'TraderMatrix expected-move edge', fib: 'Fibonacci level (HTF swing)', atr: 'ATR stop / target', fvg: 'Fair-value gap edge', here: 'Last price' }

export interface LadderColumnProps {
  rows: readonly LadderRow[]
  /** Click on a level or tick row. The handler only FILLS the ticket limit price; it never reviews or places. */
  onPick: (row: LadderRow) => void
}

/** Right-gutter level ladder: thin HTML column next to the chart canvas. Text is mono; filled chips only for TraderMatrix levels. */
export function LadderColumn({ rows, onPick }: LadderColumnProps) {
  return (
    <div className="ladder-col" data-testid="ladder" aria-label="Price level ladder" style={{ width: LADDER_WIDTH_PX }}>
      {rows.map((r, i) => {
        const key = `${r.kind}-${r.source}-${r.price}-${r.label}-${i}`
        if (r.kind === 'tick') {
          return (
            <button
              key={key}
              type="button"
              className="ladder-tick"
              style={{ top: r.y }}
              title={`${r.label} (${SOURCE_NAME[r.source] ?? r.source}). Click to put ${r.price} in the ticket limit price.`}
              onClick={() => onPick(r)}
              onContextMenu={(e) => {
                e.preventDefault()
                askAbout({ kind: 'ladder', price: r.price, source: r.source }, { x: e.clientX, y: e.clientY })
              }}
            />
          )
        }
        const tip = r.kind === 'here' ? `Last ${r.price}` : `${r.label} (${SOURCE_NAME[r.source] ?? r.source}). Click to put ${r.price} in the ticket limit price (you still review and place).`
        return (
          <Fragment key={key}>
            {Math.abs(r.labelY - r.y) > 1 && <div className="ladder-lead" style={{ top: Math.min(r.y, r.labelY), height: Math.abs(r.labelY - r.y) }} aria-hidden="true" />}
            <button
              type="button"
              className={`ladder-row ladder-${r.source}${r.chip ? ' chip' : ''}`}
              style={{ top: r.labelY }}
              title={tip}
              disabled={r.kind === 'here'}
              onClick={() => onPick(r)}
              onContextMenu={(e) => {
                e.preventDefault()
                if (r.kind !== 'here') askAbout({ kind: 'ladder', price: r.price, source: r.source }, { x: e.clientX, y: e.clientY })
              }}
            >
              {r.kind === 'here' ? `► ${r.label}` : r.label}
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
