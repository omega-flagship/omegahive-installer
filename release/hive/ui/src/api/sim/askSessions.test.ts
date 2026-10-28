import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimAsk } from './ask'
import type { Agent, Goal, Swarm } from '../types'

/**
 * SIM ONLY (j0-fixes r1 item 4/6): every Ask thread is a work session with its own room, as on the host (purpose 'ask'),
 * so the open-threads list and Messages' session titles can be seen in the simulator. INVENTED minds and people.
 */
const agents = [{ id: 'a_vega01', name: 'Vega', status: 'awake', swarm_id: 's_lyra' }] as unknown as Agent[]
const swarms = [{ id: 's_lyra', name: 'Lyra', coordinator_id: 'a_vega01' }] as unknown as Swarm[]
let who = 'user:p_ada'
const host = () => new SimAsk({ emit: () => undefined, later: () => undefined, agents: () => agents, swarms: () => swarms, goals: () => [] as Goal[], principal: () => who })
const body = (text: string) => ({ operation_id: `ask:t:${Math.random().toString(36).slice(2, 10)}`, text, via: 'typed' as const, context: { route: 'hive', experience: 'classic' } })

afterEach(() => {
  vi.unstubAllGlobals()
  who = 'user:p_ada'
})

describe('SimAsk sessions', () => {
  it('a thread made by an Ask is an active ask session with a session room; ending it keeps it, ended', () => {
    const h = host()
    const t = h.ask(body('hello')).thread
    const [s] = h.sessions(false)
    expect(s).toMatchObject({ id: t.id, status: 'active', purpose: 'ask', title: 'Ask thread', owner: 'user:p_ada', mind: { id: 'a_vega01', name: 'Vega' } })
    expect(h.sessionRooms(false)).toEqual([expect.objectContaining({ id: s.room_id, kind: 'session', name: 'Ask thread', topic: 'Session with Vega' })])
    expect(h.endSession(t.id, false)).toMatchObject({ id: t.id, status: 'ended' })
    expect(h.sessions(false).map((x) => x.status)).toEqual(['ended'])
  })
  it('another person sees and ends only their own (an admin sees all)', () => {
    const h = host()
    const t = h.ask(body('hello')).thread
    who = 'user:p_rowan'
    expect(h.sessions(false)).toEqual([])
    expect(h.sessions(true)).toHaveLength(1)
    expect(() => h.endSession(t.id, false)).toThrow()
  })
  it('?simaskthreads=1 seeds invented open threads (two of the person’s, one ended, one of another person’s)', () => {
    vi.stubGlobal('window', { location: { search: '?sim=1&simaskthreads=1' } })
    const h = host()
    const mine = h.sessions(false)
    expect(mine.filter((s) => s.status === 'active')).toHaveLength(2)
    expect(mine.filter((s) => s.status === 'ended')).toHaveLength(1)
    expect(h.sessions(true)).toHaveLength(4)
  })
  it('without the fixture nothing is seeded', () => {
    vi.stubGlobal('window', { location: { search: '?sim=1' } })
    expect(host().sessions(true)).toEqual([])
  })
})
