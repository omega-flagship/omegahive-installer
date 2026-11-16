import type { Agent, Swarm } from '../api/types'
import { NO_VIEWER, visibleSet } from './visibleSet'

/**
 * What the star map draws (Platform: the host stops listing other people's personal-mind swarms). A personal-mind
 * swarm is marked by the host's own field, `personal_of` (hive/core/personal.py), never by its name.
 * - No personal-mind swarm is drawn as a planet: neither someone else's nor the person's own.
 * - Minds in a personal swarm, or marked personal, are not drawn, except the person's own mind (GET /api/me/mind),
 *   which is drawn on its own, named "You".
 * The rule lives in the one visibility helper (scene/visibleSet); this is its map view for a viewer known only by
 * their own mind.
 */
export function mapData(swarms: Swarm[], agents: Agent[], own: { id: string; swarm_id?: string | null } | null | undefined): { swarms: Swarm[]; agents: Agent[] } {
  // the personal-mind rule alone (homes taken as known), as its own tests pin it; the page uses the whole helper
  const v = visibleSet(swarms, agents, { ...NO_VIEWER, ownMind: own ?? null, homesState: 'resolved' }, { map: true })
  return { swarms: v.swarms, agents: v.agents }
}
