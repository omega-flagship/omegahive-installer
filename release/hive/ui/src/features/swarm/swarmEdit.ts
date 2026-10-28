/** Pure rules for changing a swarm and its services (mirrors hive.update_swarm, hive.delete_swarm and collab.set_services). */
import type { ConnectionAgreement, Swarm } from '../../api/types'

type Mind = { id: string; swarm_id: string | null }

/**
 * Why `mindId` cannot contain swarm `swarmId` (null when it can): the parent is a mind in another swarm, nesting
 * never cycles, and is at most four levels deep. The hive checks again; this only explains it before asking.
 */
export function parentProblem(swarmId: string, mindId: string, swarms: Record<string, Pick<Swarm, 'parent_mind_id'>>, minds: Record<string, Mind>): string | null {
  const mind = minds[mindId]
  if (!mind || !mind.swarm_id || mind.swarm_id === swarmId) return 'The parent must be a mind in another swarm.'
  let depth = 1
  let at: string | null = mind.swarm_id
  const seen = new Set<string>()
  while (at) {
    if (at === swarmId) return 'That would put this swarm inside itself.'
    if (seen.has(at)) return 'The swarms above it already loop.'
    seen.add(at)
    depth += 1
    if (depth > 4) return 'Swarms nest at most four levels deep.'
    const up: string | null | undefined = swarms[at]?.parent_mind_id
    at = up ? (minds[up]?.swarm_id ?? null) : null
  }
  return null
}

/** The plain-words reason a delete was refused (409 swarm_not_empty carries "...this one has minds, goals"). */
export function notEmptyWords(message: string): string {
  // people read the host's goals as tasks (older hives say "goals")
  const what = /has (.+)$/.exec(message)?.[1]?.replace(/\bgoals\b/g, 'tasks')
  return what
    ? `Only an empty swarm can be deleted, and this one still has ${what}. Move or delete those first, or archive the swarm to put it away with its history.`
    : 'Only an empty swarm can be deleted. Move its minds and tasks elsewhere first, or archive it to put it away with its history.'
}

/** Service kinds as a person types them: trimmed, de-duplicated, sorted. */
export function normKinds(text: string | string[]): string[] {
  const parts = Array.isArray(text) ? text : text.split(/[,\s]+/)
  return [...new Set(parts.map((k) => k.trim()).filter(Boolean))].sort()
}

export interface ServiceGrant {
  connection: ConnectionAgreement
  /** The swarm that may ask. */
  asker: string
  /** The swarm that serves. */
  server: string
  kinds: string[]
}

/** Requests a connection lets one swarm make of another, for those connections touching `swarmId` that are still in force. */
export function serviceGrants(swarmId: string, connections: ConnectionAgreement[]): { toUs: ServiceGrant[]; fromUs: ServiceGrant[] } {
  const toUs: ServiceGrant[] = []
  const fromUs: ServiceGrant[] = []
  for (const c of connections) {
    if (c.status !== 'active' && c.status !== 'paused') continue
    if (c.from_swarm !== swarmId && c.to_swarm !== swarmId) continue
    for (const s of c.scopes) {
      if (s.kind !== 'requests') continue
      const asker = s.direction === 'from->to' ? c.from_swarm : c.to_swarm
      const server = s.direction === 'from->to' ? c.to_swarm : c.from_swarm
      const g = { connection: c, asker, server, kinds: [...s.kinds].sort() }
      if (server === swarmId) toUs.push(g)
      else fromUs.push(g)
    }
  }
  return { toUs, fromUs }
}

/** The archived swarms in a list: the server's (GET /api/swarms?archived=1), updated by this session's own events. */
export function archivedList(fetched: Swarm[] | undefined, inStore: Record<string, Swarm>): Swarm[] {
  const by = new Map<string, Swarm>()
  for (const s of fetched ?? []) if (s.archived_at) by.set(s.id, s)
  // what this session saw since (archived or restored here or elsewhere) wins over the fetched copy
  for (const s of Object.values(inStore)) {
    if (s.archived_at) by.set(s.id, s)
    else by.delete(s.id)
  }
  return [...by.values()].sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? ''))
}
