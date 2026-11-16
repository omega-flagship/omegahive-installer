import { useEffect, useRef } from 'react'
import type { ConnectionAgreement } from '../../api/types'
import { hiveBus } from '../../store/store'

/**
 * connection.updated (audit drift, Surface missing-UI batch 1): the host sends a connection's new state on pause,
 * resume, revoke, renew and expiry, to anyone who sees both swarms (visibility.py "scoped"). A swarm's lists take it
 * at once instead of at the next poll. Pure: a connection that does not touch this swarm leaves the list as it was.
 */
export function mergeConnection(list: ConnectionAgreement[] | undefined, c: ConnectionAgreement, swarmId: string): ConnectionAgreement[] | undefined {
  if (!list || (c.from_swarm !== swarmId && c.to_swarm !== swarmId)) return list
  return list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [c, ...list]
}

/** Apply connection.updated to a swarm's loaded connection list (a list still loading reads it anyway). */
export function useConnectionUpdates(swarmId: string, list: { data: ConnectionAgreement[] | undefined; mutate: (fn: (d: ConnectionAgreement[] | undefined) => ConnectionAgreement[]) => void }): void {
  const cur = useRef(list)
  useEffect(() => {
    cur.current = list
  })
  useEffect(
    () =>
      hiveBus.on((e) => {
        if (e.type !== 'connection.updated' || !cur.current.data) return
        const next = mergeConnection(cur.current.data, e.connection, swarmId)
        if (next && next !== cur.current.data) cur.current.mutate(() => next)
      }),
    [swarmId],
  )
}
