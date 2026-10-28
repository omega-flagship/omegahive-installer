import { ApiError } from '../api/client'
import { GRANT_SCOPE_WORDS } from '../api/relayedError'

export { GRANT_SCOPE_WORDS }

/** The hive refused a change made with read-only code access (403 grant_scope, platform bfbb100). */
export const isGrantScope = (e: unknown): boolean => e instanceof ApiError && e.status === 403 && e.code === 'grant_scope'
