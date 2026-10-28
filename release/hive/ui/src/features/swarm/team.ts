import type { Agent, Swarm } from '../../api/types'

/** Follow only explicit host relationships. Missing metadata and cycles stay visible. */
export function ancestorPath(swarm: Swarm, swarms: Record<string, Swarm>) {
  const ancestors: Swarm[] = []
  const seen = new Set([swarm.id])
  let current = swarm
  let incomplete = false
  while (current.parent_swarm_id) {
    const parent = swarms[current.parent_swarm_id]
    if (!parent || seen.has(parent.id) || ancestors.length >= 4) {
      incomplete = true
      break
    }
    seen.add(parent.id)
    ancestors.unshift(parent)
    current = parent
  }
  return { ancestors, incomplete }
}

export function teamStructure(swarm: Swarm, agents: Record<string, Agent>, swarms: Record<string, Swarm>) {
  const members = [...new Set(swarm.member_ids)].map((id) => agents[id]).filter((a): a is Agent => !!a && a.swarm_id === swarm.id)
  const coordinator = members.find((a) => a.id === swarm.coordinator_id)
  const workers = members.filter((a) => a.id !== coordinator?.id)
  const children = [...new Set(swarm.child_swarm_ids ?? [])].map((id) => swarms[id]).filter((s): s is Swarm => !!s && s.parent_swarm_id === swarm.id && members.some((a) => a.id === s.parent_mind_id))
  return { coordinator, workers, children }
}
