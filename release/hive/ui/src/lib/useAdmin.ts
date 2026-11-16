import type { Me } from '../api/client'
import { useHive } from '../store/store'
import { readMe } from './readMe'
import { need, useResource } from './useResource'

/** An admin session: the hive password (the operator) or a person with the admin role, as the hive's admin() check. */
export const isAdminMe = (me: Pick<Me, 'kind' | 'role'> | null | undefined): boolean => !!me && (me.kind === 'password' || me.role === 'admin')

/**
 * Who is signed in: `me` (undefined while loading or where the hive does not say), whether they are an admin, and
 * whether the read failed (`failed`: so a view can say its labels are degraded, not correct; followups-r5).
 */
export function useMe(): { me: Me | undefined; admin: boolean; loaded: boolean; failed: boolean } {
  const client = useHive((s) => s.client)
  // a sign-in that changed mid-read is read again under the new one, never shown as a failure (readMe)
  const res = useResource(() => readMe({ me: need(client, 'me') }), { isEmpty: () => false })
  return { me: res.data, admin: isAdminMe(res.data), loaded: res.status !== 'loading', failed: res.status === 'error' }
}

/**
 * Whether this person's navigation shows admin-only entries (rail, More sheet, palette, `g` shortcuts): only once the
 * hive has said an admin is signed in. While /me loads, when it fails, or when the hive does not say, the member's view:
 * the one place that decides it, so no surface can show a member an admin entry while the answer is pending.
 */
export const adminViewOf = ({ me, loaded }: { me: Pick<Me, 'kind' | 'role'> | null | undefined; loaded: boolean }): boolean => loaded && isAdminMe(me)

/** The navigation's admin view for the signed-in person (adminViewOf), and who they are. */
export function useAdminView(): { me: Me | undefined; loaded: boolean; adminView: boolean } {
  const { me, loaded } = useMe()
  return { me, loaded, adminView: adminViewOf({ me, loaded }) }
}
