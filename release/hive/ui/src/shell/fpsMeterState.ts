import { useSyncExternalStore } from 'react'

/** On/off state for the frame-rate meter (FpsMeter.tsx), and its frame statistics. */
const KEY = 'omegahive.ui.fps'
const subs = new Set<() => void>()
let on = read()

function read(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const q = new URLSearchParams(window.location.search).get('fps')
    if (q === '1' || q === '0') window.localStorage.setItem(KEY, q)
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setFpsMeter(next: boolean) {
  on = next
  try {
    window.localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
    /* remembered for this page only */
  }
  subs.forEach((f) => f())
}

export function useFpsMeterOn(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    () => on,
    () => false,
  )
}

/** Frame statistics over a window of frame durations (ms). Exported for tests. */
export function frameStats(durations: number[]): { fps: number; p95: number; worst: number; slow: number } {
  if (!durations.length) return { fps: 0, p95: 0, worst: 0, slow: 0 }
  const total = durations.reduce((a, b) => a + b, 0)
  const sorted = [...durations].sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  return { fps: Math.round((durations.length * 1000) / total), p95: Math.round(p95 * 10) / 10, worst: Math.round(sorted[sorted.length - 1]), slow: durations.filter((d) => d > 33.4).length }
}

