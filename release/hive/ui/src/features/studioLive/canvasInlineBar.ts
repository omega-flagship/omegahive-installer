import { useLayoutEffect } from 'react'

// An actual mounted Canvas row owns the fallback guard. More than one row can coexist during a transition.
const owners = new WeakMap<HTMLElement, Set<symbol>>()
export function useCanvasInlineBar(present: boolean) {
  useLayoutEffect(() => {
    if (!present || typeof document === 'undefined') return
    const body = document.body
    const token = Symbol('Canvas live bar')
    const mounted = owners.get(body) ?? new Set<symbol>()
    owners.set(body, mounted)
    mounted.add(token)
    body.setAttribute('data-canvas-inline-bar', '')
    return () => {
      mounted.delete(token)
      if (!mounted.size) { owners.delete(body); body.removeAttribute('data-canvas-inline-bar') }
    }
  }, [present])
}
