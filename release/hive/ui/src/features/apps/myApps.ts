/**
 * The apps this person can open (Ask-and-apps contract R1.1 §3), as the shell hands them to every look's awake state.
 * The list is the host's (GET /api/me/apps: discovery-eligible and open-authorized, computed on the server); the client
 * never filters it, only orders pinned first and splits off what the look shows (at most AWAKE_APPS, the rest is "more").
 *
 * Identity (R1.1 #2, lib/identityEpoch): the list, every app's open() and every load belong to the identity they were
 * made under. An identity change clears the list in the change itself; a load that answers after a change, or after a
 * newer load, is dropped; an open() kept from an earlier identity does nothing and says so (false).
 */
import { create } from 'zustand'
import { bindEpoch, guard, onIdentityChange, STALE } from '../../lib/identityEpoch'

/** One row of GET /api/me/apps (hive/core/my_apps.py, release d5c1ae58). */
export interface MyAppRow {
  id: string
  name: string
  icon?: string | null
  placement: 'person' | 'swarm'
  open: { kind: 'person' } | { kind: 'swarm'; swarm_id: string; swarm_name?: string }
  pinned?: boolean
  order?: number
}
export interface MyApp {
  id: string
  name: string
  icon: string | null
  placement: 'person' | 'swarm'
  /** 'mine' for a person app, else the swarm's name */
  where: string
  /** open it, for the identity it was listed for; false (nothing happens) once that identity is gone */
  open(): boolean
}

export const AWAKE_APPS = 8

interface MyAppsState {
  apps: MyApp[]
  loaded: boolean
  error: string | null
}
export const useMyApps = create<MyAppsState>()(() => ({ apps: [], loaded: false, error: null }))

let issued = 0
onIdentityChange(() => {
  issued++
  useMyApps.setState({ apps: [], loaded: false, error: null })
})

/** Pinned first, then the host's order (pure, tested). */
export function orderApps<T extends { pinned?: boolean; order?: number }>(rows: T[]): T[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => Number(!!b.r.pinned) - Number(!!a.r.pinned) || (a.r.order ?? a.i) - (b.r.order ?? b.i) || a.i - b.i).map((x) => x.r)
}

/** What an awake state shows: at most `max`, and how many more the "more" opens (nothing is hidden). */
export function awakeSlice<T>(apps: T[], max = AWAKE_APPS): { shown: T[]; more: number } {
  return { shown: apps.slice(0, max), more: Math.max(0, apps.length - max) }
}

/**
 * Load the list for the current identity. `fetchList` is the host call; `openRow` performs an open (the shell's own
 * route for a person or a swarm app). Returns 'loaded', or 'stale' when the identity changed or a newer load began.
 */
export async function loadMyApps(fetchList: () => Promise<{ apps: MyAppRow[] }>, openRow: (row: MyAppRow) => void): Promise<'loaded' | 'stale'> {
  const binding = bindEpoch()
  const n = ++issued
  let res: { apps: MyAppRow[] } | typeof STALE
  try {
    res = await guard(fetchList(), binding)
  } catch (e) {
    const wrote = binding.commit(() => { if (n === issued) useMyApps.setState({ error: e instanceof Error ? e.message : String(e), loaded: true }) })
    return wrote === STALE || n !== issued ? 'stale' : 'loaded'
  }
  if (res === STALE) return 'stale'
  const list = res
  const wrote = binding.commit(() => {
    if (n !== issued) return STALE
    const apps: MyApp[] = orderApps(list.apps ?? []).map((row) => ({
      id: row.id,
      name: row.name || row.id,
      icon: row.icon ?? null,
      placement: row.placement,
      where: row.open.kind === 'swarm' ? row.open.swarm_name || row.open.swarm_id : 'mine',
      open: () => {
        if (!binding.current()) return false
        openRow(row)
        return true
      },
    }))
    useMyApps.setState({ apps, loaded: true, error: null })
    return 'ok'
  })
  return wrote === STALE ? 'stale' : 'loaded'
}
