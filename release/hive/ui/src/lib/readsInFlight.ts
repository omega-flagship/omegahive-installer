// Purpose: one count of the page's reads in flight, whatever they read: a resource's fetch (lib/useResource), a page's
// or a look's code still arriving (lib/lazyRoute, experiences/ExperienceHost). The Ask's act runner waits for it to
// reach 0 before it reads the page an act left (features/ask/conductor settledPage), as TanStack Query's isFetching
// counts queries in flight and Angular's whenStable waits for pending tasks.

const flying = new Set<object>()
const listeners = new Set<() => void>()

/** How many reads are in flight now. */
export const readsInFlight = (): number => flying.size

/** Calls back whenever that count changes; returns an unsubscribe. */
export function onReadsInFlight(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Mark `reader` as reading (`on`) or not; a reader counts once however often it is marked. */
export function flight(reader: object, on: boolean): void {
  if (on === flying.has(reader)) return
  if (on) flying.add(reader)
  else flying.delete(reader)
  for (const fn of [...listeners]) fn()
}

/** `read`, counted as a read in flight until it settles, whichever way. */
export function trackRead<T>(read: Promise<T>): Promise<T> {
  const reader = {}
  flight(reader, true)
  const landed = () => flight(reader, false)
  read.then(landed, landed)
  return read
}
