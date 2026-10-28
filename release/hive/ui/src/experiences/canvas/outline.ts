import type { Agent, Approval, Goal, Swarm } from '../sdk'
import { FREE, pendingDecisions } from './layout'

/**
 * The board as a plain, stable tree: decisions, then swarms with their minds and every goal. The board unmounts
 * whatever is off screen; this outline does not, so every entity can be found, opened and acted on by keyboard
 * or screen reader wherever the camera is.
 */

export interface OutlineMind {
  id: string
  key: string
  name: string
  status: Agent['status']
  /** Pending decisions this mind is waiting on. */
  asks: number
  onBoard: boolean
}

export interface OutlineGoal {
  id: string
  key: string
  title: string
  status: Goal['status']
  onBoard: boolean
}

export interface OutlineGroup {
  /** Swarm id, or FREE for minds (and stray goals) with no known swarm. */
  id: string
  key: string
  name: string
  isSwarm: boolean
  minds: OutlineMind[]
  goals: OutlineGoal[]
}

export interface OutlineDecision {
  id: string
  key: string
  agentId: string
  agentName: string | null
  swarmName: string | null
  skill: string
  risk: Approval['risk']
  command: string
  createdAt: string
}

export interface Outline {
  decisions: OutlineDecision[]
  groups: OutlineGroup[]
  /** Total number of entities listed (decisions + swarms + minds + goals). */
  count: number
}

const ACTIVE: Record<string, number> = { stalled: 0, waiting: 1, submitted: 2, claimed: 3, open: 4 }
const goalSort = (a: Goal, b: Goal) =>
  (ACTIVE[a.status] ?? 9) - (ACTIVE[b.status] ?? 9) || b.priority - a.priority || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)

export function buildOutline(
  agents: Record<string, Agent>,
  swarms: Record<string, Swarm>,
  goals: Record<string, Goal>,
  approvals: Record<string, Approval>,
  onBoard: (key: string) => boolean,
): Outline {
  const decisions = pendingDecisions(approvals).map((d): OutlineDecision => {
    const a = agents[d.agent_id]
    const s = a?.swarm_id ? swarms[a.swarm_id] : undefined
    return { id: d.id, key: `decision:${d.id}`, agentId: d.agent_id, agentName: a?.name ?? null, swarmName: s?.name ?? null, skill: d.skill, risk: d.risk, command: d.command, createdAt: d.created_at }
  })
  const asks = new Map<string, number>()
  for (const d of decisions) asks.set(d.agentId, (asks.get(d.agentId) ?? 0) + 1)

  const byGroup = new Map<string, { minds: Agent[]; goals: Goal[] }>()
  const slot = (id: string) => {
    let g = byGroup.get(id)
    if (!g) byGroup.set(id, (g = { minds: [], goals: [] }))
    return g
  }
  for (const id in agents) {
    const a = agents[id]
    slot(a.swarm_id && swarms[a.swarm_id] ? a.swarm_id : FREE).minds.push(a)
  }
  for (const id in goals) {
    const g = goals[id]
    slot(swarms[g.swarm_id] ? g.swarm_id : FREE).goals.push(g)
  }
  const order = Object.values(swarms).sort((a, b) => (byGroup.get(b.id)?.minds.length ?? 0) - (byGroup.get(a.id)?.minds.length ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const groups: OutlineGroup[] = order.map((s) => group(s.id, s.name, true))
  if (byGroup.has(FREE)) groups.push(group(FREE, 'Unassigned', false))

  function group(id: string, name: string, isSwarm: boolean): OutlineGroup {
    const g = byGroup.get(id) ?? { minds: [], goals: [] }
    return {
      id,
      key: `island:${id}`,
      name,
      isSwarm,
      minds: [...g.minds]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((a) => ({ id: a.id, key: `mind:${a.id}`, name: a.name, status: a.status, asks: asks.get(a.id) ?? 0, onBoard: onBoard(`mind:${a.id}`) })),
      goals: [...g.goals].sort(goalSort).map((x) => ({ id: x.id, key: `goal:${x.id}`, title: x.title, status: x.status, onBoard: onBoard(`goal:${x.id}`) })),
    }
  }
  const count = decisions.length + groups.reduce((n, g) => n + (g.isSwarm ? 1 : 0) + g.minds.length + g.goals.length, 0)
  return { decisions, groups, count }
}
