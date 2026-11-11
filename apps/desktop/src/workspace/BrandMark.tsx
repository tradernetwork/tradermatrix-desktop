import mark from '../assets/brand/mark-256.png'
import wordmark from '../assets/brand/wordmark-on-dark.svg'
import { PRODUCT_NAME } from '../lib/brand'

/** Toolbar identity: the TraderMatrix mark, the wordmark and a quiet "Desktop". Small, left, decorative (the name is the accessible label). */
export function BrandMark() {
  return (
    <span className="brand-mark" role="img" aria-label={PRODUCT_NAME} title={PRODUCT_NAME}>
      <img src={mark} alt="" height={22} width={22} draggable={false} />
      <img className="brand-word" src={wordmark} alt="" height={12} draggable={false} />
      <span className="brand-sub">DESKTOP</span>
    </span>
  )
}
