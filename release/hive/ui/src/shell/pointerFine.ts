import { useSyncExternalStore } from 'react'

/**
 * Whether the primary pointer is fine (a mouse or a trackpad), kept live as it changes (a tablet docked or undocked).
 * Navigation entries are draggable only then: an HTML5 drag on a touch screen (Windows touch, hybrid laptops) takes the
 * pointer stream the long-press needs. Touch and keyboard reorder Pinned with the menu's Move up / Move down.
 */
export const POINTER_FINE = '(pointer: fine)'

type MatchMedia = (query: string) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>

export function pointerFineStore(matchMedia: MatchMedia | undefined) {
  const q = matchMedia?.(POINTER_FINE)
  return {
    get: (): boolean => !!q?.matches,
    subscribe: (cb: () => void) => {
      q?.addEventListener('change', cb)
      return () => q?.removeEventListener('change', cb)
    },
  }
}

let store: ReturnType<typeof pointerFineStore> | undefined

export function usePointerFine(): boolean {
  store ??= pointerFineStore(typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? (s) => window.matchMedia(s) : undefined)
  return useSyncExternalStore(store.subscribe, store.get, () => false)
}
