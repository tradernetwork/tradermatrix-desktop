/** The alert sound: one small bundled WAV (CSP unchanged: 'self'). Unlocked by the first user click, because webviews refuse audio before a gesture. */
import dingUrl from '../assets/alert-ding.wav'

export interface AudioLike {
  play: () => Promise<void> | void
  pause: () => void
  currentTime: number
  volume: number
  muted: boolean
}

export function createSound(make: () => AudioLike = () => new Audio(dingUrl) as unknown as AudioLike) {
  let a: AudioLike | null = null
  const get = (): AudioLike => (a ??= make())
  return {
    /** Call from a click: a muted play/pause primes the element so later plays are allowed. */
    unlock(): void {
      try {
        const el = get()
        el.muted = true
        void Promise.resolve(el.play()).then(
          () => {
            el.pause()
            el.currentTime = 0
            el.muted = false
          },
          () => {
            el.muted = false
          },
        )
      } catch {
        /* no audio in this environment */
      }
    },
    play(): void {
      const el = get()
      el.muted = false
      el.currentTime = 0
      el.volume = 0.6
      void Promise.resolve(el.play()).catch(() => undefined)
    },
  }
}
