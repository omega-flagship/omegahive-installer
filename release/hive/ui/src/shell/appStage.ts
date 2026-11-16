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
// Acquisition order is foreground order. Updating a background measurement must not raise it above a newer stage.
const publications = new Map<symbol, AppStage | null>()
const compatibilityOwner = Symbol('setAppStage')

function updateCurrent(): void {
  let next: AppStage | null = null
  for (const stage of publications.values()) if (stage !== null) next = stage
  if (same(current, next)) return
  current = next
  if (typeof document !== 'undefined') {
    if (next) document.documentElement.dataset.appStage = next.mode
    else delete document.documentElement.dataset.appStage
  }
  for (const l of listeners) l()
}

/** One publisher per layout-effect lifetime. An outgoing stage can withdraw only its own measurement. */
export function createAppStagePublisher(): { set: (next: AppStage) => void; release: () => void } {
  const owner = Symbol('app stage publisher')
  let released = false
  // Reserve order now, even if this owner's first measurement arrives after another stage's.
  publications.set(owner, null)
  return {
    set(next) {
      if (released) return
      publications.set(owner, next)
      updateCurrent()
    },
    release() {
      if (released) return
      released = true
      publications.delete(owner)
      updateCurrent()
    },
  }
}

/** Compatibility writer: null releases this slot, never another mounted stage's publication. */
export function setAppStage(next: AppStage | null): void {
  if (next === null) publications.delete(compatibilityOwner)
  else publications.set(compatibilityOwner, next)
  updateCurrent()
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
