import { useCallback, useSyncExternalStore } from 'react'
import { useMe } from '../lib/useAdmin'
import { EMPTY_PREFS, type NavPrefs, type NavSectionId } from './navItems'

/**
 * Each person's own arrangement of the classic navigation: pins (in order), hidden entries and folded sections.
 * Kept in this browser's localStorage, keyed by the signed-in principal: the hive's /api/me/ui only accepts
 * variant, layout, apps and experience (hive/core/ui_prefs.py check_prefs), so a `nav` field would be refused.
 */
const PREFIX = 'omegadots.nav.prefs.v1:'
const MAX = 40

const clean = (v: unknown): NavPrefs => {
  if (!v || typeof v !== 'object') return EMPTY_PREFS
  const o = v as Record<string, unknown>
  // Goals and Boards became Tasks (Motivations above Tasks): a pin or hide made on either carries over to Tasks
  const renamed = (k: string) => (k === 'goals' || k === 'boards' ? 'tasks' : k)
  const keys = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length < 120).map(renamed))].slice(0, MAX) : [])
  const collapsed: NavPrefs['collapsed'] = {}
  if (o.collapsed && typeof o.collapsed === 'object')
    for (const [k, b] of Object.entries(o.collapsed as Record<string, unknown>)) if (['minds', 'work', 'apps', 'watch', 'admin'].includes(k) && typeof b === 'boolean') collapsed[k as NavSectionId] = b
  return { pinned: keys(o.pinned), hidden: keys(o.hidden), collapsed }
}

// ---------------------------------------------------------------- pure changes (navPrefs.test.ts)

export function togglePin(p: NavPrefs, key: string): NavPrefs {
  return p.pinned.includes(key) ? { ...p, pinned: p.pinned.filter((k) => k !== key) } : { ...p, pinned: [...p.pinned, key], hidden: p.hidden.filter((k) => k !== key) }
}

/** Move a pinned entry up (-1) or down (+1); the keyboard's way to reorder (menu: Move up / Move down). */
export function movePinned(p: NavPrefs, key: string, delta: -1 | 1): NavPrefs {
  const i = p.pinned.indexOf(key)
  const j = i + delta
  if (i < 0 || j < 0 || j >= p.pinned.length) return p
  const pinned = [...p.pinned]
  ;[pinned[i], pinned[j]] = [pinned[j], pinned[i]]
  return { ...p, pinned }
}

/** A drop into Pinned: the entry lands before `before` (or last), pinning it if it was not. */
export function dropPinned(p: NavPrefs, key: string, before: string | null): NavPrefs {
  const pinned = p.pinned.filter((k) => k !== key)
  const at = before ? pinned.indexOf(before) : -1
  pinned.splice(at < 0 ? pinned.length : at, 0, key)
  return { ...p, pinned, hidden: p.hidden.filter((k) => k !== key) }
}

/** Hide an entry from its section (unpinning it), or show it again. */
export function toggleHidden(p: NavPrefs, key: string): NavPrefs {
  return p.hidden.includes(key) ? { ...p, hidden: p.hidden.filter((k) => k !== key) } : { ...p, hidden: [...p.hidden, key], pinned: p.pinned.filter((k) => k !== key) }
}

export const setCollapsed = (p: NavPrefs, id: NavSectionId, collapsed: boolean): NavPrefs => ({ ...p, collapsed: { ...p.collapsed, [id]: collapsed } })

// ---------------------------------------------------------------- storage

const cache = new Map<string, NavPrefs>()
const subs = new Set<() => void>()

export function readNavPrefs(principal: string): NavPrefs {
  const hit = cache.get(principal)
  if (hit) return hit
  let v = EMPTY_PREFS
  try {
    v = clean(JSON.parse(window.localStorage.getItem(PREFIX + principal) ?? 'null'))
  } catch {
    /* unreadable or unavailable: the defaults */
  }
  cache.set(principal, v)
  return v
}

export function writeNavPrefs(principal: string, next: NavPrefs): void {
  cache.set(principal, next)
  try {
    window.localStorage.setItem(PREFIX + principal, JSON.stringify(next))
  } catch {
    /* storage unavailable: remembered for this page only */
  }
  subs.forEach((f) => f())
}

const subscribe = (cb: () => void) => {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}

/** The signed-in person's arrangement and a way to change it. Until the hive says who is signed in, the defaults. */
export function useNavPrefs(): [NavPrefs, (change: (p: NavPrefs) => NavPrefs) => void] {
  const { me, loaded } = useMe()
  // a hive that does not say who is signed in still keeps one arrangement for this browser
  const principal = me?.principal ?? (loaded ? 'this-browser' : null)
  const prefs = useSyncExternalStore(
    subscribe,
    () => (principal ? readNavPrefs(principal) : EMPTY_PREFS),
    () => EMPTY_PREFS,
  )
  const update = useCallback(
    (change: (p: NavPrefs) => NavPrefs) => {
      if (principal) writeNavPrefs(principal, change(readNavPrefs(principal)))
    },
    [principal],
  )
  return [prefs, update]
}
