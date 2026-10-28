import type { Agent, Goal, Swarm } from '../sdk'

/** Structural signatures: change only when the board's shape changes (not on spend, chatter or thinking). */
export function sigAgents(a: Record<string, Agent>): string {
  let s = ''
  for (const id in a) {
    const x = a[id]
    s += `${id}:${x.swarm_id}:${x.status}:${x.name}:${x.hue}|`
  }
  return s
}
export function sigSwarms(w: Record<string, Swarm>): string {
  let s = ''
  for (const id in w) {
    const x = w[id]
    s += `${id}:${x.name}:${x.hue}:${x.coordinator_id}|`
  }
  return s
}
export function sigGoals(g: Record<string, Goal>): string {
  let s = ''
  for (const id in g) {
    const x = g[id]
    s += `${id}:${x.status}:${x.priority}:${x.updated_at}:${x.claimed_by}|`
  }
  return s
}
