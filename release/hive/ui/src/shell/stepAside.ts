// Purpose: what host chrome in a screen corner (the OS clock, the feedback entry beside it) steps aside for, read from
// the page itself: the rest's own screen, or a modal layer.
import { useSyncExternalStore, type RefObject } from 'react'

/**
 * What the clock steps aside for, read from the page itself: the rest ('rest': a `[data-rest]` screen is up, which
 * shows its own big clock), or a modal layer ('modal': an aria-modal dialog, or modal containment made the clock inert,
 * as a nav menu or the phone More sheet does; never visible-but-unreachable). '' when neither. The feedback entry beside
 * the clock (features/feedback/FeedbackHost.tsx) reads the same, and steps aside for a modal layer only.
 */
export function useStepAside(self: RefObject<HTMLElement | null>): '' | 'rest' | 'modal' {
  return useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb)
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'inert', 'data-rest'] })
      return () => mo.disconnect()
    },
    () => (document.querySelector('[data-rest]') ? 'rest' : document.querySelector('[aria-modal="true"]') || self.current?.closest('[inert]') ? 'modal' : ''),
    () => '',
  )
}
