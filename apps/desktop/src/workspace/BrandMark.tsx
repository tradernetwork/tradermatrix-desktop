import mark from '../assets/brand/mark-256.png'
import wordmark from '../assets/brand/wordmark-on-dark.svg'
import { PRODUCT_NAME } from '../lib/brand'

/**
 * Toolbar identity: the TraderMatrix mark, the wordmark and a quiet "Desktop". Small, left, decorative (the name is the accessible label).
 * M22: `text={false}` keeps just the mark (the toolbar plan drops the wordmark text when the bar is narrow so it never overlaps its neighbours).
 */
export function BrandMark({ text = true }: { text?: boolean }) {
  return (
    <span className="brand-mark" role="img" aria-label={PRODUCT_NAME} title={PRODUCT_NAME}>
      <img src={mark} alt="" height={22} width={22} draggable={false} />
      {text && <img className="brand-word" src={wordmark} alt="" height={12} draggable={false} />}
      {text && <span className="brand-sub">DESKTOP</span>}
    </span>
  )
}
