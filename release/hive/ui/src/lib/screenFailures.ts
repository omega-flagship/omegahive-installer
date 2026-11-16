// Purpose: the screen engine's word that a screen could not be composed or one of its parts drawn, for whoever keeps the
// page's errors to hear (lib/recentErrors.ts). The engine imports only this, which reads no store, so a test that mocks
// the store can still load any screen.

/** One failure: where it was and what was thrown. */
export interface ScreenFailure {
  /** the screen, with the part when one part failed: "settings", "cellar (part 20)" */
  where: string
  message: string
}

const hearers = new Set<(f: ScreenFailure) => void>()

/** Hear every screen failure from now on; the returned function stops it. */
export function onScreenFailure(fn: (f: ScreenFailure) => void): () => void {
  hearers.add(fn)
  return () => {
    hearers.delete(fn)
  }
}

/** A screen or one of its parts failed: every hearer is told, in the order they began to hear. */
export function screenFailed(f: ScreenFailure): void {
  for (const fn of [...hearers]) fn(f)
}
