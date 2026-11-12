import { useEffect, useState, type RefObject } from 'react'

/** Live clientWidth of an element (ResizeObserver). 0 until the first measurement; fallback when ResizeObserver is missing. */
export function useElWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setW(el.clientWidth)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}
