import { useEffect } from 'react'
import { create } from 'zustand'
import type { HiveClient } from '../../api/client'
import type { CostReservation } from '../../api/moneyWork'
import { startVisiblePoll } from '../../lib/poll'
import { isForbidden } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { canSettle } from './settle'

/** How often the Usage badge re-reads held calls (a modest interval; only while the page is visible). */
export const HELD_POLL_MS = 60_000

/** Held calls waiting on a person (the Usage nav badge). 0 when there are none, or when this viewer cannot see them. */
export const useHeldCalls = create<{ count: number }>(() => ({ count: 0 }))

/** The badge number from a reservations list: the calls a person may settle now (canSettle). */
export const heldCount = (rows: CostReservation[]): number => rows.filter(canSettle).length

/**
 * Poll GET /api/budgets/reservations for the badge, only while the page is visible, only for admins (the route is
 * admin-only), and stop for good on a client without it or on a 403. Returns the stopper. Pure enough to test.
 */
export function watchHeldCalls(
  client: HiveClient,
  admin: () => Promise<boolean>,
  set: (n: number) => void,
  poll: (fn: () => void, ms: number) => () => void = startVisiblePoll,
): () => void {
  if (typeof client.listReservations !== 'function') return () => undefined
  let stop: (() => void) | null = null
  let dead = false
  void admin().then(
    (ok) => {
      if (!ok || dead) return
      stop = poll(() => {
        void client.listReservations!().then(
          (rows) => !dead && set(heldCount(rows)),
          (e: unknown) => {
            if (isForbidden(e)) {
              dead = true
              set(0)
              stop?.()
            }
          },
        )
      }, HELD_POLL_MS)
    },
    () => undefined,
  )
  return () => {
    dead = true
    stop?.()
  }
}

/** Mount once (the navigation does): keeps useHeldCalls current for the current client. */
export function useHeldCallsWatch(): void {
  const client = useHive((s) => s.client)
  useEffect(() => {
    useHeldCalls.setState({ count: 0 })
    if (!client) return
    const admin = async () => {
      if (typeof client.me !== 'function') return false
      const me = await client.me()
      return me.kind === 'password' || me.role === 'admin'
    }
    return watchHeldCalls(client, admin, (count) => useHeldCalls.setState({ count }))
  }, [client])
}
