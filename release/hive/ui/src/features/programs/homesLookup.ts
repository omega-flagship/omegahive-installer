import { ApiError, type HiveClient } from '../../api/client'

/**
 * Where an app works, as far as this page knows (root finding on demo P1 r1: a failed lookup is not an absence).
 * - `pending`: still asking.
 * - `known`: the host answered; `homes` may be empty, which is the host saying the app is set up nowhere one can see.
 * - `absent`: this host has no homes route (the client lacks it, or GET /homes answers 404/405/501). The page then
 *   picks with no homes, under the same person-eligibility and private-destination guards.
 * - `failed`: the lookup was refused or could not be read. Nothing is guessed and no destination is widened: the page
 *   says it could not check and offers to try again.
 */
export type HomesState =
  | { kind: 'pending' }
  | { kind: 'known'; homes: { swarm_id: string; why: string }[] }
  | { kind: 'absent' }
  | { kind: 'failed'; denied: boolean }

const ROUTE_ABSENT = new Set([404, 405, 501])

/**
 * Ask the host where app `id` works and report the state once (the body of ProgramPage's homes effect). Returns the
 * cancel function: a reply that arrives after it (a new identity, client or app) is dropped.
 */
export function lookupHomes(client: Pick<HiveClient, 'programHomes'> | null | undefined, id: string, report: (s: HomesState) => void): () => void {
  let live = true
  if (!client?.programHomes) {
    queueMicrotask(() => live && report({ kind: 'absent' }))
    return () => { live = false }
  }
  void client.programHomes(id).then(
    (r) => live && report(Array.isArray(r?.homes) ? { kind: 'known', homes: r.homes } : { kind: 'failed', denied: false }),
    (e: unknown) => {
      if (!live) return
      if (e instanceof ApiError && ROUTE_ABSENT.has(e.status)) report({ kind: 'absent' })
      else report({ kind: 'failed', denied: e instanceof ApiError && (e.status === 401 || e.status === 403) })
    },
  )
  return () => { live = false }
}

/**
 * What the swarm picker gets from the state: `undefined` = do not pick (still asking, or the lookup failed), `null` =
 * no homes route (pick under the guards alone), else the host's homes.
 */
export function homesForPick(s: HomesState): { swarm_id: string; why: string }[] | null | undefined {
  return s.kind === 'known' ? s.homes : s.kind === 'absent' ? null : undefined
}
