/**
 * Purpose: a person's own minds as the hive store lists them, read for First Light: whether their personal mind is put
 * away (its swarm archived), which of their other minds First Light can wake instead, and whether the hive is in use:
 * whether any of their own minds, their personal mind included, has ever been awake.
 *
 * Read from GET /api/agents and GET /api/swarms as the hive store holds them (no request of its own):
 * - the person is the owner of their own personal mind (the one GET /api/me/mind names, which the list also marks
 *   `is_mine`), so no other read names them;
 * - an archived swarm is left out of the open swarm list (GET /api/swarms without `archived`), and a swarm the store
 *   learned was archived carries `archived_at`; the person always sees their own private swarm while it is open;
 * - their other minds are the ones they own, other than their personal mind and app modules, in an open swarm or none;
 * - the hive is in use once the personal mind or one of those minds has been awake (it has a `last_active_at`, or is
 *   awake or starting now). One reading decides all three: whether First Light opens by itself, whether its way out is
 *   Close, and whether the Finish setup nudge has anything left to ask. The minds the hive makes for its owner (the
 *   Create foundation's controller and reviewer) are made asleep and stay so until used, so a fresh hive is never read
 *   as one in use. Keys alone are no sign: a newcomer may already have pasted one into First Light.
 */
import type { Agent, Swarm } from '../../api/types'

export interface OwnMind {
  id: string
  name: string
  model: string
  status: string
  /** it has been awake before (or is now) */
  used: boolean
}

export interface OwnMinds {
  /** the personal mind's swarm while it is archived (Restore brings it back), else null */
  archivedSwarm: string | null
  /** the person's other minds that can be woken, those used before first (most recent first), then by name */
  others: OwnMind[]
  /** the hive is in use: the personal mind or one of those minds has been awake */
  established: boolean
}

/** Awake or waking now, or active before (the hive stamps `last_active_at` when a mind wakes): once a mind has been
 *  awake it stays used, so a mind going back to sleep never brings First Light or its nudge back. */
const used = (a: Pick<Agent, 'status' | 'last_active_at'>) => a.status === 'awake' || a.status === 'starting' || !!a.last_active_at

/**
 * The person's own minds, or null while the hive store has not listed them (or lists no personal mind of theirs).
 * `mindId` is their personal mind as GET /api/me/mind names it, preferred over the list's own mark.
 * Time: a + a log a, a = minds listed. Space: a.
 */
export function ownMinds(agents: Record<string, Agent> | null | undefined, swarms: Record<string, Swarm> | null | undefined, mindId: string | null): OwnMinds | null {
  if (!agents || !swarms) return null
  const all = Object.values(agents)
  const personal = (mindId ? agents[mindId] : undefined) ?? all.find((a) => a.is_mine)
  // a personal mind is made owned by its person (hive/core/personal.py ensure); GET /api/agents sends its owner but not
  // its personal_of mark (hive.agent_view)
  const me = personal?.personal_of ?? personal?.owner
  if (!personal || !me) return null
  const open = (swarmId: string | null | undefined) => !swarmId || (!!swarms[swarmId] && !swarms[swarmId].archived_at)
  const others = all
    .filter((a) => a.id !== personal.id && a.owner === me && !a.personal_of && a.kind !== 'module' && open(a.swarm_id))
    .map((a) => ({ mind: { id: a.id, name: a.name, model: a.model, status: a.status, used: used(a) }, at: a.last_active_at ?? '' }))
    .sort((x, y) => Number(y.mind.used) - Number(x.mind.used) || (y.at > x.at ? 1 : y.at < x.at ? -1 : 0) || x.mind.name.localeCompare(y.mind.name))
    .map((x) => x.mind)
  return { archivedSwarm: open(personal.swarm_id) ? null : personal.swarm_id, others, established: used(personal) || others.some((m) => m.used) }
}
