/**
 * The one in-use reading First Light and its nudge act on (finishSetupRule inUseNow, inUseKnown): known only once the hive
 * store lists the person's own minds, and never read as "not in use" before. Invented minds only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent, Swarm } from '../../api/types'
import { useHive } from '../../store/store'
import { inUseKnown, inUseNow } from './finishSetupRule'

const before = useHive.getState()
afterEach(() => useHive.setState(before, true))

// as GET /api/agents and GET /api/swarms list them: the personal mind marked is_mine, owned by its person
const mine = (over: Partial<Agent> = {}) => ({ a_mine: { id: 'a_mine', name: 'Wren', kind: 'omega', swarm_id: 's_mine', model: 'mock/echo', status: 'asleep', last_active_at: null, owner: 'user:u_wren', is_mine: true, ...over } as Agent })
const swarms = { s_mine: { id: 's_mine', name: 'Wren', archived_at: null } as unknown as Swarm }

describe('whether the hive is in use, as the store lists the person’s own minds', () => {
  it('is not known before the store’s first lists, or while they name no personal mind of the person’s', () => {
    useHive.setState({ ready: false, agents: mine(), swarms })
    expect(inUseNow()).toBeNull()
    useHive.setState({ ready: true, agents: {}, swarms })
    expect(inUseNow()).toBeNull()
  })
  it('is known once they do: a fresh personal mind is not in use, one that has been awake is', () => {
    useHive.setState({ ready: true, agents: mine(), swarms })
    expect(inUseNow()).toBe(false)
    useHive.setState({ agents: mine({ last_active_at: '2026-11-09T21:00:00Z' }) })
    expect(inUseNow()).toBe(true)
  })
  it('a wait answers as soon as the store can tell, and nothing once its lifetime has ended', async () => {
    useHive.setState({ ready: false, agents: {}, swarms })
    const known = inUseKnown(() => true)
    useHive.setState({ ready: true }) // read, but the personal mind is not listed yet: still waiting
    useHive.setState({ agents: mine() })
    expect(await known).toBe(false)
    let alive = true
    useHive.setState({ ready: false })
    const ended = inUseKnown(() => alive)
    alive = false
    useHive.setState({ ready: true })
    expect(await ended).toBeNull()
    expect(await inUseKnown(() => true)).toBe(false) // known already: answered at once
  })
})
