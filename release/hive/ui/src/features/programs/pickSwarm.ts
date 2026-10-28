import type { Agent, Swarm } from '../../api/types'
import { namesPrivate } from '../../lib/askMemory/beliefs'

/** A swarm whose coordinator is awake: a request made there is answered without anyone waking a mind first. */
export function coordinatorAwake(swarm: Swarm | undefined, agents: Record<string, Agent>): boolean {
  const c = swarm?.coordinator_id ? agents[swarm.coordinator_id] : undefined
  return c?.status === 'awake'
}

/** The coordinator of a swarm when it is set and not awake (asleep, stopped, starting, in error): the page says so. */
export function sleepingCoordinator(swarm: Swarm | undefined, agents: Record<string, Agent>): Agent | null {
  const c = swarm?.coordinator_id ? agents[swarm.coordinator_id] : undefined
  return c && c.status !== 'awake' ? c : null
}

/**
 * A private destination, never chosen automatically: a swarm that names a private app (Atlas, OmegaTruth, Truth) in
 * its id, name or description (the app-wide fence, lib/askMemory namesPrivate, as the host's names_private), or a
 * swarm kept private. A person may still open one by choosing it.
 */
export function privateSwarm(s: Pick<Swarm, 'id' | 'name' | 'description' | 'visibility'>): boolean {
  return s.visibility === 'private' || namesPrivate(s.id) || namesPrivate(s.name) || namesPrivate(s.description ?? '')
}

/**
 * The swarms an app may be opened in automatically (r2.2, Root on live 6e937bd: Tools opened to "no usable swarm"
 * while its home Arena worked). The Ask's `eligible` list is where the Ask may route (a coordinator it can talk to,
 * core/ask.py eligible_swarms), not where an app may be used, and stays the Ask's. An app view needs only that the
 * person sees the swarm (core/app.py program_view), and the host's homes are already limited to the swarms the person
 * sees (GET /api/programs/{id}/homes). So: exactly the homes the host returned. No homes known (no route, failed,
 * pending): null, and nothing is opened automatically. The non-private guard is applied by pickProgramSwarm on every
 * automatic choice; nothing here grants access.
 */
export function appUsable(homes: { swarm_id: string }[] | null): ReadonlySet<string> | null {
  return homes ? new Set(homes.map((h) => h.swarm_id)) : null
}

/**
 * Which swarm an app opens in when the route names none. Never the swarm that sorts first by name (demo audit P1
 * #2/#3), and never one the person cannot use or a private one (stand-in r1 P1).
 * - `usable`: the swarms the app may open in for this person (appUsable: the host's homes, which it limits to swarms
 *   the person sees, plus the swarms they participate in). Null (not known): nothing is chosen; the chooser shows.
 * - The remembered swarm, then the person's default swarm, are honoured when the person may use them, they are not
 *   private (stand-in r2 P1: a private swarm opens only by the person choosing it, in the chooser or a link they
 *   followed), and, with `homes` known, the app works there.
 * - Otherwise only a usable, non-private swarm in use is chosen automatically:
 *   `homes` known: the first such home with an awake coordinator, else the first such home;
 *   `homes` null (a host without the route): such a swarm, an awake coordinator first, then the most awake minds.
 * - Nothing qualifies: null, never a guess.
 */
export function pickProgramSwarm(opts: {
  swarms: Record<string, Swarm>
  agents: Record<string, Agent>
  homes: { swarm_id: string }[] | null
  usable: ReadonlySet<string> | null
  remembered: string | null
  defaultSwarm: string | null
}): string | null {
  const { swarms, agents, homes, usable, remembered, defaultSwarm } = opts
  if (!usable) return null
  const canUse = (id: string | null | undefined): id is string => !!id && !!swarms[id] && !swarms[id].archived_at && usable.has(id)
  const automatic = (id: string) => canUse(id) && !privateSwarm(swarms[id])
  const homeIds = homes ? homes.map((h) => h.swarm_id) : null
  for (const chosen of [remembered, defaultSwarm]) if (canUse(chosen) && !privateSwarm(swarms[chosen]) && (!homeIds || homeIds.includes(chosen))) return chosen
  if (homeIds) {
    const ids = homeIds.filter(automatic)
    return ids.find((id) => coordinatorAwake(swarms[id], agents)) ?? ids[0] ?? null
  }
  const awakeMinds = (s: Swarm) => Object.values(agents).filter((a) => a.swarm_id === s.id && a.status === 'awake').length
  const ranked = Object.keys(swarms)
    .filter(automatic)
    .map((id) => swarms[id])
    .map((s) => ({ s, coord: coordinatorAwake(s, agents) ? 1 : 0, awake: awakeMinds(s) }))
    .sort((a, b) => b.coord - a.coord || b.awake - a.awake || a.s.name.localeCompare(b.s.name))
  return ranked[0]?.s.id ?? null
}

/**
 * The page's routing for an app with no swarm in its route (ProgramPage), pure. `pick`: undefined while the homes are
 * still being asked or the lookup failed (the page says so), a swarm id to open, or null for the chooser. `choices`:
 * what the chooser offers, never a private or archived swarm: the homes the host returned, or with no homes route,
 * the person's swarms (nothing opens by itself then).
 */
export function appRouting(o: {
  swarms: Record<string, Swarm>
  agents: Record<string, Agent>
  homesState: { kind: 'pending' | 'failed' | 'absent' } | { kind: 'known'; homes: { swarm_id: string }[] }
  remembered: string | null
  defaultSwarm: string | null
}): { pick: string | null | undefined; choices: Swarm[] } {
  const { swarms, agents, homesState, remembered, defaultSwarm } = o
  if (homesState.kind === 'pending' || homesState.kind === 'failed') return { pick: undefined, choices: [] }
  const homes = homesState.kind === 'known' ? homesState.homes : null
  const usable = appUsable(homes)
  const pick = homes ? pickProgramSwarm({ swarms, agents, homes, usable, remembered, defaultSwarm }) : null
  const choices = pick !== null ? [] : Object.values(swarms)
    .filter((s) => !s.archived_at && !privateSwarm(s) && (usable ? usable.has(s.id) : true))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { pick, choices }
}
