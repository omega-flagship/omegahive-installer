/**
 * Purpose: the rules First Light reads a person's own minds by (ownMinds.ts), each on the smallest hive that shows it:
 * a fresh own hive (the personal mind and the Create foundation's asleep minds) is not one in use; Peter's hive (his
 * personal mind's swarm archived, his work moved to another swarm and used) is; only the person's own minds that can
 * be woken are offered, those used most recently first.
 */
import { describe, expect, it } from 'vitest'
import type { Agent, Swarm } from '../../api/types'
import { ownMinds } from './ownMinds'

const ME = 'user:u_peter'
const mind = (id: string, over: Partial<Agent> = {}): Agent => ({ id, name: id, kind: 'omega', swarm_id: 's_work', model: 'openrouter/anthropic/claude-sonnet-5.5', status: 'asleep', last_active_at: null, owner: ME, ...over } as Agent)
const swarm = (id: string, over: Partial<Swarm> = {}): Swarm => ({ id, name: id, archived_at: null, ...over } as Swarm)
const byId = <T extends { id: string }>(...xs: T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]))

// as GET /api/agents sends them (hive.agent_view): an owner, no personal_of; the personal mind marked is_mine (with_flags)
const personal = mind('a_peter', { name: 'Peter', swarm_id: 's_peter', is_mine: true })
/** what a fresh own hive lists: the personal mind, and the foundation's controller and reviewer, made asleep for its owner */
const fresh = byId(personal, mind('a_code', { name: 'Create · Code controller', swarm_id: 's_create' }), mind('a_review', { name: 'Review controller', swarm_id: 's_create' }))
const freshSwarms = byId(swarm('s_peter'), swarm('s_create'))

describe('a person’s own minds, for First Light', () => {
  it('a fresh own hive is not one in use: its personal mind is open, and the minds the hive made are asleep and unused', () => {
    expect(ownMinds(fresh, freshSwarms, 'a_peter')).toEqual({ archivedSwarm: null, others: [
      { id: 'a_code', name: 'Create · Code controller', model: personal.model, status: 'asleep', used: false },
      { id: 'a_review', name: 'Review controller', model: personal.model, status: 'asleep', used: false },
    ], established: false })
  })

  it('Peter’s hive: his personal swarm is archived (left out of the open list, or marked), and his moved minds were used', () => {
    const agents = byId(personal, mind('a_old', { name: 'Atlas', last_active_at: '2026-11-08T10:00:00Z' }), mind('a_new', { name: 'Beacon', status: 'awake', last_active_at: '2026-11-09T10:00:00Z' }), mind('a_idle', { name: 'Comet' }))
    const absent = ownMinds(agents, byId(swarm('s_work')), 'a_peter')
    expect(absent).toEqual({ archivedSwarm: 's_peter', established: true, others: [
      { id: 'a_new', name: 'Beacon', model: personal.model, status: 'awake', used: true },
      { id: 'a_old', name: 'Atlas', model: personal.model, status: 'asleep', used: true },
      { id: 'a_idle', name: 'Comet', model: personal.model, status: 'asleep', used: false },
    ] })
    expect(ownMinds(agents, byId(swarm('s_work'), swarm('s_peter', { archived_at: '2026-11-09T09:00:00Z' })), 'a_peter')).toEqual(absent)
  })

  it('offers only the person’s own minds that can be woken: not another person’s, an app module, or one in an archived swarm', () => {
    const agents = byId(personal,
      mind('a_theirs', { owner: 'user:u_ana', last_active_at: '2026-11-09T10:00:00Z' }),
      mind('a_module', { kind: 'module', last_active_at: '2026-11-09T10:00:00Z' }),
      mind('a_shelved', { swarm_id: 's_old', last_active_at: '2026-11-09T10:00:00Z' }),
      mind('a_loose', { name: 'Loose', swarm_id: null }),
      mind('a_ana', { name: 'Ana', swarm_id: 's_ana', owner: 'user:u_ana' }))
    const r = ownMinds(agents, byId(swarm('s_peter'), swarm('s_work'), swarm('s_old', { archived_at: '2026-11-01T00:00:00Z' })), 'a_peter')
    expect(r?.others.map((m) => m.id)).toEqual(['a_loose'])
    expect(r?.established).toBe(false) // the used minds are someone else's, a module, or put away
  })

  it('the person’s own personal mind having been awake makes the hive in use, as any of their minds does', () => {
    for (const [over, inUse] of [[{}, false], [{ last_active_at: '2026-11-09T21:00:00Z' }, true], [{ status: 'awake' }, true], [{ status: 'starting' }, true], [{ status: 'error' }, false]] as const)
      expect(ownMinds(byId({ ...personal, ...over } as Agent, mind('a_code', { swarm_id: 's_create' })), freshSwarms, 'a_peter')?.established, JSON.stringify(over)).toBe(inUse)
  })

  it('a mind starting now counts as used; the personal mind is never among the others', () => {
    const r = ownMinds(byId(personal, mind('a_up', { status: 'starting', swarm_id: 's_create' })), freshSwarms, 'a_peter')
    expect(r?.others).toEqual([{ id: 'a_up', name: 'a_up', model: personal.model, status: 'starting', used: true }])
    expect(r?.established).toBe(true)
  })

  it('is not known until the hive store lists the minds and the person’s own personal mind', () => {
    expect(ownMinds(null, freshSwarms, 'a_peter')).toBeNull()
    expect(ownMinds(fresh, null, 'a_peter')).toBeNull()
    const nobody = byId(mind('a_x'))
    expect(ownMinds(nobody, freshSwarms, null)).toBeNull()
    // the personal mind GET /api/me/mind names is preferred; without one, the list's own mark finds it
    expect(ownMinds(fresh, freshSwarms, null)?.others.map((m) => m.id)).toEqual(['a_code', 'a_review'])
  })
})
