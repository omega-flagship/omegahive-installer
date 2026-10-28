import { useSyncExternalStore } from 'react'
import { useMediaQuery } from '../lib/hooks'

/**
 * Whether the desktop rail shows its labels. Wide screens (1280px and up) open it by default; smaller
 * desktops show icons with labelled tooltips. The toggle remembers the person's choice when storage allows.
 */
export type RailPref = 'open' | 'closed' | null

const KEY = 'omegadots.nav.rail'
/** Where pages start: the rail's left margin, its width and a gap. */
export const RAIL_X = { collapsed: 84, expanded: 236 } as const

function read(): RailPref {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === 'open' || v === 'closed' ? v : null
  } catch {
    return null
  }
}

let pref: RailPref = typeof window === 'undefined' ? null : read()
const subs = new Set<() => void>()

export function setRailPref(next: RailPref): void {
  pref = next
  try {
    if (next) window.localStorage.setItem(KEY, next)
    else window.localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable: remembered for this page only */
  }
  subs.forEach((f) => f())
}

export const railExpanded = (p: RailPref, wide: boolean): boolean => p === 'open' || (p === null && wide)

export function useRailExpanded(): boolean {
  const wide = useMediaQuery('(min-width: 1280px)')
  const p = useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    () => pref,
    () => null,
  )
  return railExpanded(p, wide)
}
