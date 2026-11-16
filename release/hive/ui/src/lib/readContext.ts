/**
 * Surface K1/L1: a read's answer belongs to the identity it was read under. That identity is the client instance it
 * went through, plus whatever else the read depends on (the principal, admin or member, which entity, which saved
 * session). An answer is shown, offered or acted on only while that identity is still the current one; when the
 * identity changes, the old answer is dropped, never kept as a "refresh" of the new one, and a late answer for the old
 * identity can never write.
 *
 * Same-identity refreshes are different: the last answer stays on screen while the next one is read (useResource's
 * `key`), because it is still an answer about the same thing for the same person.
 */

const ids = new WeakMap<object, number>()
let next = 0

/** A stable name for one client instance: two clients never share it, even when both are admins. */
export function clientIdentity(client: object | null | undefined): string {
  if (!client) return 'no-client'
  let id = ids.get(client)
  if (id === undefined) {
    id = ++next
    ids.set(client, id)
  }
  return `client#${id}`
}

/** `undefined` (not read yet) and `null` (could not be read) are different identities and stay different. */
const part = (p: unknown): unknown => (p === undefined ? '\u0000undefined' : p)

/**
 * The client's current sign-in, as a name (Platform person-session, 439efb9): a client that reports credential changes
 * (`authContext`, a local handle replaced on every sign-in, sign-out, re-login without a logout, and another tab's
 * sign-in or sign-out) gets a new name each time. A client without it (the sim) has no sign-in part: `null`.
 * Local invalidation only, never a session or a permission.
 */
export function authIdentity(client: object | null | undefined): string | null {
  const read = (client as { authContext?: () => object } | null | undefined)?.authContext
  if (typeof read !== 'function') return null
  const handle = read.call(client)
  return handle && typeof handle === 'object' ? clientIdentity(handle) : null
}

/**
 * The identity a read is made under, as one comparable string: the client instance, its current sign-in (when the
 * client reports one), and every other part the read depends on (strings, numbers, booleans, null/undefined, or
 * arrays of them). A client without `authContext` reads exactly as before.
 */
export function readContext(client: object | null | undefined, ...parts: unknown[]): string {
  const auth = authIdentity(client)
  const head = auth === null ? [clientIdentity(client)] : [clientIdentity(client), auth]
  return JSON.stringify([...head, ...parts.map((p) => (Array.isArray(p) ? p.map(part) : part(p)))])
}

/** An answer tagged with the identity it was read under. */
export interface Tagged<T> {
  ctx: string
  value: T
}

/** The answer if it was read under `ctx` (the current identity); otherwise nothing: it belongs to someone else. */
export function taggedFor<T>(answer: Tagged<T> | null | undefined, ctx: string): T | null {
  return answer && answer.ctx === ctx ? answer.value : null
}
