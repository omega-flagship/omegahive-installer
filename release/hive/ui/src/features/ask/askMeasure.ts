/**
 * Everything the Ask measures of the page around it (AskHost), in one place: where Ω is, the chrome an experience keeps
 * clear, whether the experience's own field is on screen, and the Professional card's height. Awake, the first three
 * re-measure on a slow poll. `still` (useAskStill: the page is hidden, or a phased experience rests uncovered) stops
 * every poll; each measure is then taken on entering and leaving it, and on resize (Cosmos weak-device gate and
 * Classic/Professional R3.1, 3 Nov).
 */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { restHolds, usePhase } from '../../shell/phase'
import type { ClearBox } from './placement'

const pageVisible = () => typeof document !== 'undefined' && !document.hidden
function onPageVisibility(change: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined
  document.addEventListener('visibilitychange', change)
  return () => document.removeEventListener('visibilitychange', change)
}

/** Nothing moves: the page is hidden, or a phased experience rests with nothing over it (a covered rest still measures). */
export function useAskStill(routeName: string): boolean {
  const resting = usePhase((s) => restHolds(s))
  const visible = useSyncExternalStore(onPageVisibility, pageVisible, () => false)
  return !visible || (resting && routeName === 'hive')
}

/** `still`: the shell rests and nothing moves, so it is measured once (and on resize), with no poll. */
export function useOmegaRight(dep: unknown, still: boolean): number | null {
  const [right, setRight] = useState<number | null>(null)
  useEffect(() => {
    const measure = () => {
      const o = document.querySelector('[data-omega-button]')?.getBoundingClientRect()
      setRight(o && o.width ? o.right : null)
    }
    measure()
    const t = still ? 0 : window.setInterval(measure, 800)
    window.addEventListener('resize', measure)
    return () => {
      if (t) window.clearInterval(t)
      window.removeEventListener('resize', measure)
    }
  }, [dep, still])
  return right
}

/** The bottom safe area, measured (the Ask's `bottom` is above it). */
function readSab(): number {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)'
  document.body.appendChild(probe)
  const v = parseFloat(getComputedStyle(probe).paddingBottom) || 0
  probe.remove()
  return v
}

/**
 * The chrome an experience keeps clear (`data-xc-keep-clear`: navigators, pills, docks, chip rows), measured while the
 * experience is in front, re-measured on a slow poll and on resize; the Ask's own marks and Ω are not counted (Ω is
 * placeAsk's). State changes only when a box really moved.
 */
export function useKeepClear(active: boolean, still: boolean): { boxes: ClearBox[]; sab: number } {
  const [v, setV] = useState<{ boxes: ClearBox[]; sab: number; sig: string }>({ boxes: [], sab: 0, sig: '' })
  useEffect(() => {
    if (!active) return
    const measure = () => {
      const boxes: ClearBox[] = []
      for (const el of document.querySelectorAll('[data-xc-keep-clear]')) {
        if (el.closest('.ask-root, [data-omega-button]')) continue
        if (el.closest('[inert],[aria-hidden="true"]')) continue
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
        // only chrome actually on top at its centre (a classic page over the experience covers it); the Ask's own
        // layers and presence are looked through, since the Ask may be sitting on the very chrome it must clear
        const cx = Math.min(window.innerWidth - 1, Math.max(0, (r.left + r.right) / 2))
        const cy = Math.min(window.innerHeight - 1, Math.max(0, (r.top + r.bottom) / 2))
        const top = (document.elementsFromPoint?.(cx, cy) ?? []).find((t) => !t.closest('.ask-root, .ask-presence-layer, .ask-move-veil'))
        if (top && !el.contains(top) && !top.contains(el)) continue
        boxes.push({ left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) })
      }
      const sab = readSab()
      const sig = `${sab}|${boxes.map((b) => `${b.left},${b.top},${b.right},${b.bottom}`).join(';')}`
      setV((p) => (p.sig === sig ? p : { boxes, sab, sig }))
    }
    measure()
    // at rest nothing moves: measured on entering and leaving it, and on resize, never polled
    const t = still ? 0 : window.setInterval(measure, 700)
    window.addEventListener('resize', measure)
    return () => {
      if (t) window.clearInterval(t)
      window.removeEventListener('resize', measure)
    }
  }, [active, still])
  return active ? v : NO_KEEP
}
const NO_KEEP = { boxes: [] as ClearBox[], sab: 0 }

/** Is the experience's own field (Still's question box, Construct's prompt) on screen and live? */
export function useOwnBoxVisible(selector: string | null, still: boolean): boolean {
  const active = !!selector
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (!active) return
    let io: IntersectionObserver | null = null
    let el: Element | null = null
    let inView = true
    const check = () => {
      const box = document.querySelector(selector!)
      if (box !== el) {
        io?.disconnect()
        el = box
        inView = true
        if (box) {
          io = new IntersectionObserver((es) => {
            inView = es[es.length - 1].isIntersecting
            setVisible(inView && !box.closest('[inert]'))
          })
          io.observe(box)
        }
      }
      setVisible(!!el && inView && !el.closest('[inert]'))
    }
    check()
    // Lazy native fields may mount after an uncovered rest has stopped polling. Observe ownership changes so the
    // receiving field cannot stay hidden behind a stale fallback decision, including inert changes on navigation.
    const mutations = new MutationObserver(check)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] })
    return () => {
      io?.disconnect()
      mutations.disconnect()
    }
  }, [active, selector, still])
  return active ? visible : false
}

/** The native Ask's actual reservation, followed through lazy mounts and size changes without a poll. */
export function useOwnReservation(selector: string | null): { left: number; width: number; room: number } | null {
  const [box, setBox] = useState<{ left: number; width: number; room: number } | null>(null)
  useLayoutEffect(() => {
    if (!selector) return
    let el: Element | null = null
    let observer: ResizeObserver | null = null
    const measure = () => {
      const next = document.querySelector(selector)
      if (next !== el) {
        observer?.disconnect()
        el = next
        observer = next && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
        if (next) observer?.observe(next)
      }
      const r = el?.getBoundingClientRect()
      const value = r && r.width > 0 && r.height > 0 ? { left: r.left, width: r.width, room: Math.max(0, Math.ceil(window.innerHeight - r.top + 12)) } : null
      setBox(prev => prev?.left === value?.left && prev?.width === value?.width && prev?.room === value?.room ? prev : value)
    }
    measure()
    const mutations = new MutationObserver(measure)
    mutations.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); mutations.disconnect(); window.removeEventListener('resize', measure) }
  }, [selector])
  return selector ? box : null
}

/** The Professional card's height, followed by a ResizeObserver (no poll) while `active`. */
export function useCardHeight(box: HTMLElement | null, active: boolean, context: string): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (!active || !box) return
    const measure = () => setHeight(Math.ceil(box.getBoundingClientRect().height))
    const initial = window.requestAnimationFrame(measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(box)
    window.addEventListener('resize', measure)
    return () => { window.cancelAnimationFrame(initial); observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [active, box, context])
  return height
}
