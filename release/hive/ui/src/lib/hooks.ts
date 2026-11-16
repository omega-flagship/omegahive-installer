import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

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

export const useIsDesktop = () => useMediaQuery('(min-width: 768px)')
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
