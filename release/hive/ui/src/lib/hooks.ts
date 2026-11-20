import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/**
 * An element's content width: read once in the layout pass, before the first paint, so a view never draws one frame for
 * the screen's width (Jon's review of #564), then from each ResizeObserver report. Null until it has a width; a width of
 * 0 means the element isn't laid out (hidden, or a test's DOM), which leaves the views on their earlier answer.
 * features/lab/useWidth.ts, forms/commons/hooks.ts and programs/ProgramHost.tsx each keep their own copy of this, reading
 * 0 before measuring.
 */
export function useElementWidth(ref: RefObject<Element | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // a state set in a layout effect renders again before the browser paints
    const first = contentWidth(el)
    if (first > 0) setWidth(first)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number' && w > 0) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

/** An element's content-box width, as ResizeObserver's contentRect gives it: its client width less its padding; 0 when it
 * has no layout. Example: a 640 px wide window with 13 px of padding each side is 614. */
function contentWidth(el: Element): number {
  const w = (el as HTMLElement).clientWidth
  if (typeof w !== 'number' || !(w > 0)) return 0
  const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el)
  const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0
  return Math.round(w - pad)
}

/** The width a page window gives the views inside it (ui/ViewArea measures it), or null outside one. */
export const ViewWidth = createContext<number | null>(null)
/** The width at and above which the hive lays a view out for a desktop. */
export const DESKTOP_MIN = 768
/**
 * Whether a view lays out for a desktop: by the width its page window gives it inside one, else by the screen. The Ask's
 * half size leaves a page about 600 px of a 1440 px screen, where the Tasks board's five desktop columns wrapped a word
 * per line (a tester's report, 20 Nov). Examples: viewIsDesktop(true, 614) is false; viewIsDesktop(true, null) is true.
 */
export const viewIsDesktop = (screen: boolean, width: number | null): boolean => (width === null ? screen : width >= DESKTOP_MIN)
export const useIsDesktop = () => viewIsDesktop(useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`), useContext(ViewWidth))
export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)')
export const useFinePointer = () => useMediaQuery('(hover: hover) and (pointer: fine)')

/** Re-render every `ms` (for relative timestamps). */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

// ---- Escape stack: the most recently opened layer handles Esc first. ----
const escStack: { id: number; fn: () => void }[] = []
let escSeq = 0
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    const top = escStack[escStack.length - 1]
    if (top) {
      e.preventDefault()
      top.fn()
    }
  })
}

export function useEscape(fn: () => void, active = true): void {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  })
  useEffect(() => {
    if (!active) return
    const id = ++escSeq
    escStack.push({ id, fn: () => ref.current() })
    return () => {
      const i = escStack.findIndex((x) => x.id === id)
      if (i >= 0) escStack.splice(i, 1)
    }
  }, [active])
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
}

/**
 * The text on the clipboard, read on a press that asks for it (a Paste button), or null when the browser will not give
 * it: no Clipboard API (a page not served from this computer or over HTTPS), or the person said no. Call it inside the
 * press itself: Safari and Firefox read only during the gesture.
 */
export async function pastedText(): Promise<string | null> {
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    return typeof clipboard?.readText === 'function' ? await clipboard.readText() : null
  } catch {
    return null
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok: boolean
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}
