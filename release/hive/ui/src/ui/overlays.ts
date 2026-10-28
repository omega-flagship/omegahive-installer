import { useEffect, useSyncExternalStore, type RefObject } from 'react'

/**
 * The bottom space a phone sheet keeps clear for the universal Ask: the safe area plus the Ask's own room (--ask-room,
 * set by features/ask/AskHost while the Ask shows: its height above the bottom plus the capsule). A sheet that ends its
 * scroll area here is never covered by the Ask, which stays on screen over every sheet (always present, never covering).
 */
export const ASK_RESERVE = 'calc(var(--sab, 0px) + var(--ask-room, 0px))'

/**
 * ASK_RESERVE in pixels, now: resolved by the browser from the same expression (a hidden probe of that height), for
 * what is placed in script rather than in CSS (the guided demo's caption). 0 where nothing can be measured.
 */
export function askReservePx(doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): number {
  if (!doc?.body) return 0
  const probe = doc.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = `position:fixed;left:0;bottom:0;width:0;visibility:hidden;pointer-events:none;height:${ASK_RESERVE}`
  doc.body.appendChild(probe)
  const h = probe.getBoundingClientRect().height
  probe.remove()
  return Number.isFinite(h) && h > 0 ? h : 0
}

/**
 * Open overlays (the phone More sheet, a nav menu, a phone sheet): first-visit hints that belong to the view beneath wait
 * while one is open (tour/ViewInfo), so a hint never sits on top of a menu or a sheet it is not part of.
 */
const open = new Set<HTMLElement>()
let snapshot: readonly HTMLElement[] = []
const subs = new Set<() => void>()
const changed = () => {
  snapshot = [...open]
  subs.forEach((f) => f())
}

export function registerOverlay(el: HTMLElement): () => void {
  open.add(el)
  changed()
  return () => {
    open.delete(el)
    changed()
  }
}

/** Register this element as an open overlay while it is mounted. */
export function useOverlay(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    return el ? registerOverlay(el) : undefined
  }, [ref])
}

const subscribe = (cb: () => void) => {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}
const read = () => snapshot

/** Whether an open overlay covers `inside`: an overlay that contains it (its own sheet) does not count. */
export const coveredBy = (overlays: readonly HTMLElement[], inside: Node | null): boolean => overlays.some((o) => !inside || !o.contains(inside))

/** The overlays open now (tests and tools). */
export const openOverlays = (): readonly HTMLElement[] => read()

/** Whether an open overlay that does not contain `ref` covers it (a hint's button inside its own sheet is not covered). */
export function useCovered(ref: RefObject<HTMLElement | null>): boolean {
  return useSyncExternalStore(
    subscribe,
    () => coveredBy(snapshot, ref.current),
    () => false,
  )
}
