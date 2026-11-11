import { aryaLook, aryaState, type AryaLookName, type AryaState } from '../lib/brand'
import calm128 from '../assets/brand/arya-calm-128.webp'
import calm256 from '../assets/brand/arya-calm-256.webp'
import focused128 from '../assets/brand/arya-focused-128.webp'
import focused256 from '../assets/brand/arya-focused-256.webp'
import wry128 from '../assets/brand/arya-wry-128.webp'
import wry256 from '../assets/brand/arya-wry-256.webp'

const LOOKS: Record<AryaLookName, { x1: string; x2: string }> = {
  calm: { x1: calm128, x2: calm256 },
  focused: { x1: focused128, x2: focused256 },
  wry: { x1: wry128, x2: wry256 },
}

/**
 * Arya's face (M15, states M16 B6). Purely decorative and CSS only: idle is static, thinking a slow gold glow, streaming a pulsing gold ring,
 * check a steady amber ring, error a steady red ring (see `.arya-avatar` in app.css; every animation is off under prefers-reduced-motion).
 * `state` wins over `busy`; `look` overrides the still (the greeting uses `wry`).
 */
export function ArayaAvatar({ busy = false, size = 32, look, state: given }: { busy?: boolean; size?: number; look?: AryaLookName; state?: AryaState }) {
  const state = given ?? aryaState(busy)
  const img = LOOKS[look ?? aryaLook(state)]
  return (
    <img
      className="arya-avatar"
      data-state={state}
      src={img.x1}
      srcSet={`${img.x1} 1x, ${img.x2} 2x`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
