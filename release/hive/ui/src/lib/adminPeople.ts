import { useEffect, useState } from 'react'
import type { Person } from '../api/client'
import { useHive } from '../store/store'
import { useMe } from './useAdmin'

/**
 * Everyone signed in to this hive, read while a people box is open: null until it is known (who is signed in, then the
 * first read), [] when the read fails. GET /api/people is admin-only, so a member's box never asks and gets [] at once,
 * the view it had after the 403 before (acceptance-tests#13 N1: each ask was a 403 in the member's recent errors).
 */
export function useAdminPeople(active: boolean): Person[] | null {
  const client = useHive((s) => s.client)
  const { admin, loaded } = useMe()
  const [read, setRead] = useState<Person[] | null>(null)
  useEffect(() => {
    if (!active || !admin || !client?.listPeople) return
    let alive = true
    client.listPeople().then(
      (d) => alive && setRead(d.people),
      () => alive && setRead([]),
    )
    return () => {
      alive = false
    }
  }, [active, admin, client])
  return admin ? read : loaded ? [] : null
}
