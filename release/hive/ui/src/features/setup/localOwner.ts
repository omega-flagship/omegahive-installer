import { has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'

/**
 * Whether this hive was installed on one person's own computer (a J1 local-owner hive: /api/auth/methods answers
 * local_owner). There First Light is the onboarding and the setup checklist's steps are legacy, so the checklist is not
 * offered as onboarding. null while the hive has not said; a hive that cannot say is an ordinary one.
 */
export function useLocalOwnerHive(): boolean | null {
  const client = useHive((s) => s.client)
  const methods = useResource(() => (has(client, 'authMethods') ? need(client, 'authMethods')() : Promise.resolve(null)), { isEmpty: () => false })
  return methods.status === 'loading' ? null : methods.data?.local_owner === true
}
