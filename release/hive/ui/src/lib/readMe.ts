import { ApiError, type HiveClient, type Me } from '../api/client'

/**
 * Platform person-session (439efb9): `me()` answers ApiError 409 `auth_context_changed` when the sign-in changed while
 * it was reading. Nothing failed: the answer belonged to the earlier sign-in, so it is read again under the new one.
 */
export const isAuthContextChanged = (e: unknown): boolean => e instanceof ApiError && e.status === 409 && e.code === 'auth_context_changed'

/**
 * Who is signed in, read again for as long as the sign-in keeps changing under the read (each retry needs a real
 * credential change during the previous read, so this ends). Any other failure is the caller's, as before.
 */
export function readMe(client: Pick<HiveClient, 'me'>): Promise<Me> {
  if (typeof client.me !== 'function') return Promise.reject(new TypeError('This client cannot say who is signed in'))
  return client.me().catch((e: unknown) => (isAuthContextChanged(e) ? readMe(client) : Promise.reject(e)))
}
