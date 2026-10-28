import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import { useHive, viewIsLive } from '../sdk'
import { current } from './binding'
import { bounded, type Point } from './world'

const typing = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]')
const covered = (root: HTMLElement | null) => !root || !!root.closest('[inert]') || !!document.querySelector('[aria-modal="true"], [data-town-covered="true"]')
const DELTA: Record<string, Point> = { ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 } }

/** Local walking only. Pausing clears both held keys and the path; no stale movement resumes. */
export function useWalking({ ctx, enabled, reduced, root, point, onPoint }: { ctx: string; enabled: boolean; reduced: boolean; root: RefObject<HTMLDivElement | null>; point: Point; onPoint: (p: Point) => void }) {
  const pose = useRef(point)
  const keys = useRef(new Set<string>())
  const path = useRef<Point | null>(null)
  const run = useRef<{ frame: number; last: number }>({ frame: 0, last: 0 })
  const composing = useRef(false)
  const arrival = useRef<(() => void) | null>(null)
  const conducted = useRef(false)
  useEffect(() => { pose.current = point }, [point])
  const stop = useCallback(() => { keys.current.clear(); path.current = null; arrival.current = null; conducted.current = false; cancelAnimationFrame(run.current.frame); run.current = { frame: 0, last: 0 } }, [])

  useEffect(() => {
    if (!enabled) { stop(); return }
    const usable = () => enabled && current(ctx) && viewIsLive(root.current) && document.visibilityState === 'visible' && document.hasFocus() && !composing.current && (conducted.current || !typing(document.activeElement)) && !covered(root.current) && !useHive.getState().paletteOpen && !useHive.getState().stopAllOpen && !useHive.getState().reveal
    const frame = (time: number) => {
      run.current.frame = 0
      if (!usable()) { stop(); return }
      const dt = Math.min(0.04, run.current.last ? (time - run.current.last) / 1000 : 0.016)
      run.current.last = time
      let dx = 0, dy = 0
      keys.current.forEach((key) => { dx += DELTA[key]?.x ?? 0; dy += DELTA[key]?.y ?? 0 })
      if (!dx && !dy && path.current) {
        dx = path.current.x - pose.current.x; dy = path.current.y - pose.current.y
        if (Math.hypot(dx, dy) < 5) { pose.current = path.current; path.current = null; onPoint(pose.current); const arrived = arrival.current; arrival.current = null; conducted.current = false; arrived?.(); return }
      }
      const length = Math.hypot(dx, dy)
      if (length) { pose.current = bounded({ x: pose.current.x + dx / length * 170 * dt, y: pose.current.y + dy / length * 170 * dt }); onPoint(pose.current) }
      if (keys.current.size || path.current) run.current.frame = requestAnimationFrame(frame)
    }
    const start = () => { if (!run.current.frame && usable()) run.current.frame = requestAnimationFrame(frame) }
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey || typing(e.target) || !usable()) { stop(); return }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (!DELTA[key]) return
      // Walking keys belong only to the explicitly focused world; lists, Ask and native pages keep their own keys.
      if (!root.current?.contains(e.target as Node) || !(e.target instanceof Element) || !e.target.closest('[data-town-walk]')) return
      e.preventDefault(); path.current = null; arrival.current = null; conducted.current = false
      if (reduced) { if (!e.repeat) { const d = DELTA[key]; onPoint(bounded({ x: pose.current.x + d.x * 22, y: pose.current.y + d.y * 22 })) }; return }
      keys.current.add(key); start()
    }
    const up = (e: KeyboardEvent) => { keys.current.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); if (!keys.current.size && !path.current) stop() }
    const compose = () => { composing.current = true; stop() }
    const composed = () => { composing.current = false; stop() }
    const focus = (e: FocusEvent) => { if (typing(e.target) || !(e.target instanceof Element) || !e.target.closest('[data-town-walk]')) stop() }
    const observer = new MutationObserver(() => { if (!usable()) stop() })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['inert', 'aria-modal'] })
    const unsubscribe = useHive.subscribe(() => { if (!usable()) stop() })
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', stop)
    document.addEventListener('focusin', focus); document.addEventListener('visibilitychange', stop); document.addEventListener('compositionstart', compose); document.addEventListener('compositionend', composed)
    // Pointer requests use this local entry only while this exact origin is still live.
    const walk = (e: Event) => {
      const detail = (e as CustomEvent<{ point: Point; conductor?: boolean; onArrival?: () => void }>).detail
      if (!detail || !Number.isFinite(detail.point?.x) || !Number.isFinite(detail.point?.y)) { e.preventDefault(); stop(); return }
      conducted.current = detail.conductor === true
      if (!usable()) { e.preventDefault(); stop(); return }
      keys.current.clear(); path.current = bounded(detail.point); arrival.current = detail.onArrival ?? null
      if (reduced) { pose.current = path.current; path.current = null; onPoint(pose.current); const arrived = arrival.current; arrival.current = null; conducted.current = false; arrived?.(); return }
      start()
    }
    root.current?.addEventListener('town-local-walk', walk)
    const element = root.current
    return () => { stop(); unsubscribe(); observer.disconnect(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', stop); document.removeEventListener('focusin', focus); document.removeEventListener('visibilitychange', stop); document.removeEventListener('compositionstart', compose); document.removeEventListener('compositionend', composed); element?.removeEventListener('town-local-walk', walk) }
  }, [ctx, enabled, reduced, root, onPoint, stop])

  const walkTo = useCallback((p: Point, opts: { conductor?: boolean; onArrival?: () => void } = {}) => {
    if (!enabled || !current(ctx) || !root.current) return false
    return root.current.dispatchEvent(new CustomEvent('town-local-walk', { cancelable: true, detail: { point: bounded(p), ...opts } }))
  }, [ctx, enabled, root])
  return useMemo(() => ({ stop, walkTo }), [stop, walkTo])
}
