import type { ReactNode } from 'react'
import bg from '../assets/brand/bg-wide-navy.webp'
import { useBackgrounds } from '../stores/ui'

/**
 * Empty pane message with an optional dimmed brand background (setting `ui.backgrounds`). One of only two places that may import a
 * background (the other is the unlock screen). It renders ONLY when a pane has nothing to show; never wrap data in it.
 */
export function EmptyState({ children, className = '' }: { children: ReactNode; className?: string }) {
  const art = useBackgrounds()
  const style = art ? { backgroundImage: `linear-gradient(90deg, rgba(7,14,31,0.9) 0%, rgba(7,14,31,0.6) 100%), url(${bg})` } : undefined
  return (
    <div className={`pane-empty empty-state${art ? ' with-art' : ''} ${className}`.trim()} style={style}>
      {children}
    </div>
  )
}
