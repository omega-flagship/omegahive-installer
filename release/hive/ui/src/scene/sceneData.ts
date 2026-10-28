import type { Agent, Goal, Swarm } from '../api/types'
import type { SceneUniverse } from './engine'
import { hiveLabel } from './hiveNames'
import { visibleSet, type Viewer, type VisibleSet } from './visibleSet'

/**
 * What the hive map is given (HiveScene's push), as one pure step so tests drive exactly what the page draws: the
 * visible set first (scene/visibleSet), then everything else from it alone: the hives, their labels as this viewer may
 * read them, where minds without a swarm gather, how many placeholders, and which task glyphs may orbit whom.
 */
export function mapScene(
  swarms: Swarm[],
  agents: Agent[],
  goals: Goal[],
  state: { viewer: Viewer; names: Readonly<Record<string, string>> },
): { shown: VisibleSet; universe: SceneUniverse; claims: Record<string, string | null> } {
  const shown = visibleSet(swarms, agents, state.viewer, { map: true })
  const hives = new Set([...Object.values(shown.hiveOf), ...(shown.wanderHive ? [shown.wanderHive] : [])])
  const labels: Record<string, string> = {}
  for (const h of [...hives].sort()) labels[h] = hiveLabel(h, state, shown.ownHive)
  // a goal claimed by a mind this viewer is not shown leaves no glyph
  const shownIds = new Set(shown.agents.map((a) => a.id))
  const claims: Record<string, string | null> = {}
  for (const g of goals) claims[g.id] = (g.status === 'claimed' || g.status === 'waiting') && g.claimed_by && shownIds.has(g.claimed_by) ? g.claimed_by : null
  return { shown, universe: { hiveOf: shown.hiveOf, labels, wanderHive: shown.wanderHive, placeholders: shown.placeholders }, claims }
}
