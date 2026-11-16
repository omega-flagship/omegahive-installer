import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

/* ================================================================ roving focus (one tab stop for a field of stars) */

export function useRoving(order: string[]) {
  const [activePick, setActive] = useState<string | null>(null)
  const active = activePick && order.includes(activePick) ? activePick : (order[0] ?? null)
  const els = useRef(new Map<string, HTMLElement>())
  const ref = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el)
    else els.current.delete(id)
  }, [])
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const i = active ? order.indexOf(active) : -1
      const to = (j: number) => {
        const id = order[Math.max(0, Math.min(order.length - 1, j))]
        if (!id) return
        e.preventDefault()
        setActive(id)
        els.current.get(id)?.focus()
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to(i + 1)
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to(i - 1)
      else if (e.key === 'Home') to(0)
      else if (e.key === 'End') to(order.length - 1)
    },
    [active, order],
  )
  return { active, setActive, ref, onKeyDown, tabIndex: (id: string) => (id === active ? 0 : -1) }
}

/** The width of an element, kept current. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** Whether a media query matches, kept current. */
export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return m
}
