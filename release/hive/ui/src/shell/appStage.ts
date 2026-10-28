import { useSyncExternalStore } from 'react'

/**
 * While an app's own interface is mounted (AppFrame), the host's notices move out of its way (PROGRAMS.md §9c Fit):
 * framed, into the host's bottom lane right of Ω (outside the frame); full-bleed, to a one-line pill at the top centre
 * (apps keep their navigation along the bottom edge). While a whole experience is in front (request Q), the same
 * one-line pill sits at the top centre below the chrome the experience keeps clear (`experienceNoticeTop`), so it never
 * covers its bars, docks or command line. Null: no stage, toasts sit where they always do.
 */
export type AppStage =
  | { mode: 'framed'; lane: { left: number; top: number; right: number; bottom: number } | null }
  | { mode: 'full'; top: number }
  | { mode: 'experience'; top: number }

let current: AppStage | null = null
const listeners = new Set<() => void>()
const same = (a: AppStage | null, b: AppStage | null) => JSON.stringify(a) === JSON.stringify(b)

export function setAppStage(next: AppStage | null): void {
  if (same(current, next)) return
  current = next
  if (typeof document !== 'undefined') {
    if (next) document.documentElement.dataset.appStage = next.mode
    else delete document.documentElement.dataset.appStage
  }
  for (const l of listeners) l()
}

export const appStageNow = () => current

export function useAppStage(): AppStage | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
    () => null,
  )
}
