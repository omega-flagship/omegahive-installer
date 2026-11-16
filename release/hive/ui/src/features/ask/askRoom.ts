// Purpose: the room the Ask takes, reported once for pages, sheets, toasts, the looks' own panels and the hive map
// (--ask-room above the bottom edge, --ask-room-left beside the half size's column, and the scene's ask inset), and
// where its open thread is drawn, reported for the stage, which keeps clear of it.
import { useEffect, useLayoutEffect, useState } from 'react'
import { useScene } from '../../scene/sceneStore'

/**
 * The room the docked Ask takes above the bottom edge (CSS px): its place above the bottom safe area plus the capsule
 * and its gap (64 minimum). The measured whole floating dock includes its answerer row; Professional keeps its
 * existing 12 px gap, the other floating skins keep 8 px. Pure, and tested.
 */
export function askRoom(place: { bottom: number }, isPro: boolean, measuredHeight: number): number {
  const height = Number.isFinite(measuredHeight) ? Math.max(0, measuredHeight) : 0
  return place.bottom + Math.max(64, height + (isPro ? 12 : 8))
}

/** The gap the looks keep from the half size's column, as pages keep 12 px from the rail. */
export const HALF_GAP = 12

/**
 * The room the Ask takes on each side for the region its screen gives it (askScreen.ts): a dock across the foot takes room
 * above the bottom edge (askRoom); the half size's column takes the left of the screen to its right edge and its gap,
 * with its field inside it, so it takes none at the foot: what the look draws right of it has the whole height, e.g.
 * a column at 236 px, 578 px wide, takes { bottom: 0, left: 826 }. Pure, and tested.
 */
export function askRoomFor(region: string, place: { bottom: number; left: number; width: number }, isPro: boolean, measuredHeight: number): { bottom: number; left: number } {
  if (region === 'half-left') return { bottom: 0, left: place.left + place.width + HALF_GAP }
  return { bottom: askRoom(place, isPro, measuredHeight), left: 0 }
}

/**
 * The ONE writer of `--ask-room` and `--ask-room-left` (followups-r6): nothing else sets them (askRoomOwner.test scans
 * every source file), so the CSS values and the map's inset can never disagree.
 * Where that room is reported: `--ask-room` (pages pad their scroll, sheets keep their reserve, phone toasts stack above
 * it), `--ask-room-left` while the half size's column takes the left (a page's window, Professional's home and
 * workspace and the looks' left panels start right of it; absent otherwise, so `var(--ask-room-left, 0px)` is 0) and
 * the hive map's scene inset `ask` (its fits keep the galaxies' names clear of the Ask, followups-r5). `null` clears
 * them all: the Ask is not shown, or AskHost went away.
 */
export function setAskRoom(root: { style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> }, room: number | null, left = 0): void {
  if (room === null) {
    root.style.removeProperty('--ask-room')
    root.style.removeProperty('--ask-room-left')
    useScene.getState().setInset('ask', null)
    return
  }
  root.style.setProperty('--ask-room', `${room}px`)
  if (left > 0) root.style.setProperty('--ask-room-left', `${left}px`)
  else root.style.removeProperty('--ask-room-left')
  useScene.getState().setInset('ask', left > 0 ? { bottom: room, left } : { bottom: room })
}

/**
 * The ONE reader of `--ask-room` for code (followups-r6): the room setAskRoom last reported on this root, in CSS px; 0
 * when no Ask is shown. CSS reads the variable itself (`var(--ask-room, 0px)`).
 */
export function readAskRoom(root: { style: Pick<CSSStyleDeclaration, 'getPropertyValue'> } = document.documentElement): number {
  return parseFloat(root.style.getPropertyValue('--ask-room')) || 0
}

/**
 * The ONE writer of the scene's `askThread`: where the Ask's open thread is drawn, for the stage (screens/arrange),
 * which is drawn under the Ask and arranges what is shown clear of it. A component that draws the thread (FloatingAsk's
 * sheet, side, pinned and rising panels; the still line's letter) passes the first of the pair as its `ref` and calls
 * the second when its entrance ends: the box is read on mount, on a resize of the thread or the window, after every
 * render (a new place for the dock moves the thread without resizing it) and after its entrance (getBoundingClientRect
 * includes the entrance's transform), and cleared once the thread it holds has left the page. A detach says nothing of
 * which element went (React and framer-motion call the ref with null), and one placement's exit animation can outlive
 * the next one's entrance (AnimatePresence: the rising thread still fading out after the half column came in), so a
 * detach is settled after its commit, when the element that went is off the page: the report is cleared only if the
 * element it holds is gone. Each read costs one getBoundingClientRect; an unchanged box writes nothing.
 */
export function useThreadReport(): readonly [(el: HTMLElement | null) => void, () => void] {
  const [r] = useState(threadReporter)
  useLayoutEffect(() => {
    r.measure()
  })
  useEffect(() => {
    window.addEventListener('resize', r.measure)
    return () => window.removeEventListener('resize', r.measure)
  }, [r])
  return [r.ref, r.measure] as const
}

/** The part of a report a node needs: its box, and whether it is still on the page. */
type Reported = Pick<HTMLElement, 'getBoundingClientRect' | 'isConnected'>

/**
 * One thread report apart from React (useThreadReport holds one per component that draws a thread): `ref` attaches a
 * node and reads its box, and settles a detach after its commit, clearing the scene's thread only if the node it holds
 * has left the page; `measure` reads the held node's box again.
 */
export function threadReporter(): { ref: (node: Reported | null) => void; measure: () => void } {
  let el: Reported | null = null
  let watch: ResizeObserver | null = null
  const measure = () => {
    const r = el?.getBoundingClientRect()
    if (!r) return
    useScene.getState().setAskThread(r.width >= 1 && r.height >= 1 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null)
  }
  const ref = (node: Reported | null) => {
    if (!node) {
      queueMicrotask(() => {
        if (el?.isConnected) return
        watch?.disconnect()
        watch = null
        el = null
        useScene.getState().setAskThread(null)
      })
      return
    }
    watch?.disconnect()
    watch = null
    el = node
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      watch = new ResizeObserver(measure)
      watch.observe(node as Element)
    }
  }
  return { ref, measure }
}
