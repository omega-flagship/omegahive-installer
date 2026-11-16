import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { isDemoClient } from '../features/showreel/hook'
import { bindEpoch, onIdentityChange } from '../lib/identityEpoch'
import { useIdentityEpoch } from '../lib/epochBound'
import { usePeopleNames } from '../lib/personNames'
import { useMe } from '../lib/useAdmin'
import { useAskStore } from '../store/ask'
import { useHive } from '../store/store'
import type { Swarm } from '../api/types'
import { shown } from '../lib/displayName'
import { byHive, NO_VIEWER, visibleSet, type Viewer } from './visibleSet'
import { homesBefore, privateAppIds, resolvePrivateHomes, type PrivateHomes } from './privateHomes'
export { hiveAliases, hiveLabel } from './hiveNames'

/**
 * Who is looking (scene/visibleSet's Viewer), kept in one place for the map, the Ask context and the swarm lists.
 * Per-person state: it is cleared synchronously on every identity change (lib/identityEpoch), so the next person never
 * sees the previous one's homes, names or hive.
 */
export interface ViewerState {
  viewer: Viewer
  /** display names this viewer may see, by principal (themselves; the hive's people where the hive lists them) */
  names: Readonly<Record<string, string>>
}

export const useViewer = create<ViewerState>()(() => ({ viewer: NO_VIEWER, names: {} }))

onIdentityChange(() => useViewer.setState({ viewer: NO_VIEWER, names: {} }))
const readViewer = () => useViewer.getState().viewer

/**
 * The swarms a private app (Atlas, Truth) works in, as the hive tells this viewer (GET /api/programs/{id}/homes), and
 * whether that is known yet (scene/privateHomes). Until it has resolved, the state says so and the visibility helper
 * fails closed: nothing that could be such a home is shown by name.
 */
function usePrivateHomes(): PrivateHomes {
  const client = useHive((s) => s.client)
  const programs = useHive((s) => s.programs)
  const programsError = useHive((s) => s.programsError)
  const epoch = useIdentityEpoch()
  const ids = useMemo(() => privateAppIds(programs).join('\u0001'), [programs])
  const start = homesBefore(programs, programsError, !!client?.programHomes)
  const [homes, setHomes] = useState<{ epoch: number; key: string; value: PrivateHomes } | null>(null)
  // one retry per identity after a failure: the app list is read again, and the homes with it (nonce in the key)
  const [retry, setRetry] = useState<{ epoch: number; n: number }>({ epoch, n: 0 })
  const nonce = retry.epoch === epoch ? retry.n : 0
  const key = `${ids}|${start.state}|${nonce}`
  useEffect(() => {
    if (start.state !== 'pending' || !ids) return
    const binding = bindEpoch()
    let live = true
    void resolvePrivateHomes(client, ids.split('\u0001')).then((value) => {
      if (live) binding.commit(() => setHomes({ epoch: binding.epoch, key, value }))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers ids and the start state
  }, [client, key, epoch])
  // an answer for an earlier identity, or for other apps, is not this one's: still pending
  const value = homes && homes.epoch === epoch && homes.key === key ? homes.value : start
  useEffect(() => {
    if (value.state !== 'failed' || nonce > 0) return
    const binding = bindEpoch()
    const t = setTimeout(() => {
      if (!binding.current()) return
      void useHive.getState().loadPrograms().catch(() => undefined).finally(() => binding.commit(() => setRetry({ epoch: binding.epoch, n: 1 })))
    }, RETRY_MS)
    return () => clearTimeout(t)
  }, [value.state, nonce, epoch])
  return value
}
/** How long after a failed read the app list (and the homes) are read once more. */
export const RETRY_MS = 4000

/** Keep the viewer current. Mounted once (App). */
export function useViewerSync(): void {
  const client = useHive((s) => s.client)
  const { me, admin } = useMe()
  const people = usePeopleNames()
  const own = useAskStore((s) => s.personal)
  const homes = usePrivateHomes()
  const epoch = useIdentityEpoch()
  useEffect(() => {
    const names: Record<string, string> = {}
    for (const p of people.people ?? []) if (p?.id && p.name?.trim()) names[`user:${p.id}`] = p.name.trim()
    if (me?.principal && me.person?.name?.trim()) names[me.principal] = me.person.name.trim()
    const viewer: Viewer = {
      principal: me?.principal ?? null,
      admin,
      visitor: isDemoClient(client),
      ownMind: own ? { id: own.id, swarm_id: own.swarm_id ?? null } : null,
      privateHomes: homes.ids,
      homesState: homes.state,
    }
    useViewer.setState({ viewer, names })
  }, [client, me, admin, people.people, own, homes, epoch])
}

/**
 * The swarms a list shows (Still's sheets, Professional's Swarms), from the one visibility helper: another person's
 * personal swarm never, a private app's home or a swarm seen only through admin sight never by name (lists leave
 * placeholders out). Grouped by hive: the viewer's own, then the cloud hive, then other people's; by name within each.
 */
export function useShownSwarms(): Swarm[] {
  const swarms = useHive((s) => s.swarms)
  // read through React's own external-store hook (not zustand's binding), as the hive store's selectors are read
  const viewer = useSyncExternalStore(useViewer.subscribe, readViewer, readViewer)
  return useMemo(() => {
    const v = visibleSet(Object.values(swarms), [], viewer, { map: false, keepArchived: true })
    return [...v.swarms].sort(byHive(v, (s) => shown(s.name)))
  }, [swarms, viewer])
}
