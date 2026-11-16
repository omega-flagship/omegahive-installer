import { afterEach, describe, expect, it } from 'vitest'
import { useHive } from '../../store/store'
import { defaultView, routeSwarm } from './context'

/** Audit P2 #9: #/goals and #/boards now open Tasks, and the Ask on Tasks got only the title, no swarm and no tasks. */
const goal = (id: string, swarm_id: string, extra: Record<string, unknown> = {}) => ({ id, swarm_id, title: `Task ${id}`, status: 'open', assignee: null, claimed_by: null, created_by: 'user:operator', ...extra })
const before = useHive.getState()
afterEach(() => useHive.setState(before, true))

describe('the Ask on Tasks', () => {
  it('knows the swarm a Tasks filter is about (its swarm, else its mind’s)', () => {
    useHive.setState({ agents: { a_vega01: { id: 'a_vega01', name: 'Vega', swarm_id: 's_lyra' } } } as never)
    expect(routeSwarm({ name: 'tasks', swarm: 's_kelp' })).toBe('s_kelp')
    expect(routeSwarm({ name: 'tasks', mind: 'a_vega01' })).toBe('s_lyra')
    expect(routeSwarm({ name: 'tasks' })).toBeUndefined()
  })
  it('sends the open tasks the page shows: by swarm, and by mind', () => {
    useHive.setState({
      swarms: { s_lyra: { id: 's_lyra', name: 'Lyra' }, s_kelp: { id: 's_kelp', name: 'Kelp' } },
      agents: { a_vega01: { id: 'a_vega01', name: 'Vega', swarm_id: 's_lyra' } },
      goals: { g1: goal('g1', 's_lyra'), g2: goal('g2', 's_kelp'), g3: goal('g3', 's_lyra', { status: 'done' }), g4: goal('g4', 's_kelp', { assignee: 'a_vega01' }) },
    } as never)
    const all = defaultView({ name: 'tasks' }, 'on Tasks')
    expect(all.summary).toBe('3 open tasks')
    const lyra = defaultView({ name: 'tasks', swarm: 's_lyra' }, 'on Tasks · Lyra')
    expect(lyra.refs).toEqual([{ kind: 'swarm', ref: 's_lyra', label: 'Lyra' }, { kind: 'goal', ref: 'g1', label: 'Task g1' }])
    expect(lyra.summary).toBe('1 open task in Lyra')
    const vega = defaultView({ name: 'tasks', mind: 'a_vega01' }, 'on Tasks')
    expect(vega.refs?.filter((x) => x.kind === 'goal').map((x) => x.ref)).toEqual(['g4'])
    expect(vega.summary).toBe('1 open task for Vega')
  })
})
