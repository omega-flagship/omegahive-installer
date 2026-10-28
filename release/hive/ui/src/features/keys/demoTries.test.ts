import { describe, expect, it } from 'vitest'
import { decide, resolve, type World } from '../../lib/intent'
import { startsShowreel } from '../showreel/words'
import { DEMO_TRIES } from './demoTries'

/**
 * Demo D2: every phrase the demo card suggests reaches the answering mind; none is taken by the fast path's shortcuts.
 * Demo D4: in demo mode the showreel hears the Ask first, and takes exactly one of them ("show me around").
 */
const world: World = {
  minds: [{ id: 'a_vega01', name: 'Vega', awake: true, swarm: 'Lyra' }, { id: 'a_coral5', name: 'Coral', awake: true, swarm: 'Kelp Commons' }],
  swarms: [{ id: 's_lyra', name: 'Lyra' }, { id: 's_kelp', name: 'Kelp Commons' }],
  pending: 0,
  experiences: [{ id: 'classic', name: 'Classic hive' }],
  looks: [],
}

describe('the demo card\u2019s phrases', () => {
  it.each(DEMO_TRIES.map((t) => t.say))('"%s" goes to the mind', (say) => {
    expect(decide(resolve(say, { experience: 'classic' }, world), { orchestrator: true })).toEqual({ kind: 'mind' })
  })
  it('in demo mode, only "show me around" is the showreel’s', () => {
    expect(DEMO_TRIES.filter((t) => startsShowreel(t.say)).map((t) => t.say)).toEqual(['show me around'])
  })
  it('(control) the old phrase "show me what you can do" was taken by Help, which is why it is not suggested', () => {
    expect(decide(resolve('show me what you can do', { experience: 'classic' }, world), { orchestrator: true }).kind).toBe('run')
  })
})
