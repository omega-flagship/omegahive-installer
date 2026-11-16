import { isPrivateApp } from '../features/ask/view'

/**
 * Which swarms are a private app's homes (Atlas, Truth), and whether that is known (stand-in hive-scale r1 P1-1). The
 * visibility helper fails CLOSED on anything but 'resolved': while it is 'pending' nothing that could be such a home is
 * shown at all; once it has 'failed' such objects are at most an unattributed placeholder, never named.
 * - 'pending': the app list is not read yet, or a home read is still in flight;
 * - 'failed': the app list could not be read (any refusal, 403 included), or any private app's home read was refused,
 *   failed, or answered with anything but a list of non-empty swarm ids (one malformed entry fails the whole read);
 * - 'resolved': every private app's homes were read (or this viewer is offered no private app).
 */
export type HomesState = 'pending' | 'failed' | 'resolved'
export interface PrivateHomes {
  state: HomesState
  ids: ReadonlySet<string>
}

const NONE: ReadonlySet<string> = new Set()

/** The private apps among the apps the hive lists for this viewer (decoded and cased as view.ts isPrivateApp). */
export function privateAppIds(programs: readonly { id: string }[] | null | undefined): string[] {
  return (programs ?? []).map((p) => p.id).filter((id) => isPrivateApp(id)).sort()
}

/** What is known before any home read: pending, failed, or resolved with no private app to ask about. */
export function homesBefore(programs: readonly { id: string }[] | null | undefined, programsError: string | null | undefined, canReadHomes: boolean): PrivateHomes {
  if (!programs) return { state: programsError ? 'failed' : 'pending', ids: NONE }
  const ids = privateAppIds(programs)
  if (!ids.length) return { state: 'resolved', ids: NONE }
  return { state: canReadHomes ? 'pending' : 'failed', ids: NONE }
}

/** Read every private app's homes. Any refusal or failure, or an answer that does not fit: 'failed' (fail closed). */
export async function resolvePrivateHomes(
  client: { programHomes?: (id: string) => Promise<{ homes?: { swarm_id?: unknown }[] } | null | undefined> } | null | undefined,
  appIds: readonly string[],
): Promise<PrivateHomes> {
  if (!client?.programHomes) return { state: 'failed', ids: NONE }
  const rs = await Promise.allSettled(appIds.map((id) => client.programHomes!(id)))
  const out = new Set<string>()
  for (const r of rs) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value?.homes)) return { state: 'failed', ids: NONE }
    // every entry must name a swarm; one malformed entry makes the whole read unknown (stand-in r1.1 P1)
    for (const h of r.value.homes) {
      const id = (h as { swarm_id?: unknown } | null)?.swarm_id
      if (typeof id !== 'string' || !id.trim()) return { state: 'failed', ids: NONE }
      out.add(id)
    }
  }
  return { state: 'resolved', ids: out }
}
