// Purpose: let a reader outside the store (a page's own reads, the Ask, Studio and app-frame stores) read again whenever
// the store does after a live-stream gap (store resync, its `resyncs` count).
import { useEffect, useRef } from 'react'
import { useHive } from '../store/store'

/**
 * Call `fn` each time the store reads again because what was read may miss something the live stream said (the events
 * socket came back after a gap, or a read predates its subscription: api/live.ts onResync). Never on subscribing; the
 * store's own sign-in changes start a new session, which every reader reads afresh anyway. Returns stop.
 */
export function onStoreResync(fn: () => void): () => void {
  return useHive.subscribe((s, prev) => {
    if (s.resyncs !== prev.resyncs && s.session === prev.session) fn()
  })
}

/** onStoreResync for a component: the latest `fn` runs on each resync while it is mounted. */
export function useOnResync(fn: () => void): void {
  const latest = useRef(fn)
  useEffect(() => {
    latest.current = fn
  })
  useEffect(() => onStoreResync(() => latest.current()), [])
}
