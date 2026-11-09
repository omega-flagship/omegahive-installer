import type { Agent, Swarm } from '../../api/types'
import { shown } from '../../lib/displayName'
import { money } from '../../lib/format'
import type { ScreenFacts, ScreenPlan } from '../../screens/screenSpace'

/**
 * What the Swarms screens are told (swarms.metta): the values they draw, bound by path, and this moment's facts (counts
 * and flags) from which MeTTa composes them. Each swarm is composed as its own small screen, and the swarms screen
 * stacks them. Pure: composing is handed in.
 */
export type Compose = (screen: string, facts: ScreenFacts) => ScreenPlan
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** One card of the stack: the swarm's id, the screen MeTTa composed for it, and the values that screen draws. */
export interface SwarmItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }

export interface SwarmsInput {
  swarms: Record<string, Swarm>
  agents: Record<string, Agent>
  /** each swarm's commons: its beliefs by id */
  beliefs: Record<string, Record<string, unknown> | undefined>
}
/** Who is looking and what this hive offers: an admin or not, whether archived swarms can be restored, sim costs. */
export interface SwarmsContext { admin: boolean; canRestore: boolean; sim: boolean }

/** The swarms on the list: not archived, oldest first. */
export const liveSwarms = (swarms: Record<string, Swarm>): Swarm[] =>
  Object.values(swarms).filter((s) => !s.archived_at).sort((a, b) => a.created_at.localeCompare(b.created_at))
/** Minds in no swarm, or in one this hive no longer has. */
export const wanderersOf = (agents: Record<string, Agent>, swarms: Record<string, Swarm>): Agent[] =>
  Object.values(agents).filter((a) => !a.swarm_id || !swarms[a.swarm_id])

export function swarmItem(s: Swarm, input: SwarmsInput, sim: boolean, compose: Compose): SwarmItem {
  const members = s.member_ids.map((id) => input.agents[id]).filter((a): a is Agent => Boolean(a))
  const awake = members.filter((a) => a.status === 'awake').length
  const spend = members.reduce((n, a) => n + a.spent_usd, 0)
  const beliefs = Object.keys(input.beliefs[s.id] ?? {}).length
  const description = shown(s.description)
  const services = s.services ?? []
  return {
    id: s.id,
    plan: compose('swarms-swarm', {
      counts: { 'swarm.services': services.length },
      flags: { 'swarm.described': description !== '', 'swarm.services_known': s.services !== undefined, sim },
    }),
    data: {
      'swarm.name': shown(s.name),
      'swarm.description': description,
      'swarm.hue': s.hue,
      'swarm.minds': members.map((a) => ({ id: a.id, hue: a.hue, status: a.status })),
      'swarm.minds_n': members.length,
      'swarm.minds_word': members.length === 1 ? 'mind' : 'minds',
      'swarm.awake_n': awake,
      'swarm.beliefs_n': beliefs,
      'swarm.beliefs_word': beliefs === 1 ? 'belief' : 'beliefs',
      'swarm.spend': money(spend),
      'swarm.services_text': services.join(', '),
    },
  }
}

/** The swarms screen: every live swarm as its own card, archived swarms (admins), and minds in no swarm. */
export function swarmsScreen(input: SwarmsInput, ctx: SwarmsContext, compose: Compose): Composed {
  const live = liveSwarms(input.swarms)
  const wanderers = wanderersOf(input.agents, input.swarms).map((a) => ({ id: a.id, name: shown(a.name), hue: a.hue, status: a.status }))
  return {
    data: { 'swarms.rows': live.map((s) => swarmItem(s, input, ctx.sim, compose)), wanderers },
    facts: {
      counts: { 'swarms.live': live.length, wanderers: wanderers.length },
      flags: { 'viewer.admin': ctx.admin, 'can.restore': ctx.canRestore },
    },
  }
}
