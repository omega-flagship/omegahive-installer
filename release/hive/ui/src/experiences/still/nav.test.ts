import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../features/registry'
import { NATIVE } from '../coverage'
import { STILL_NATIVE } from './features'
import { CONSEQUENTIAL, understand, type World } from './intent'
import { NAV_FEATURES } from './nav'

const w: World = {
  minds: [{ id: 'ag_vega000001', name: 'Vega', awake: true, swarm: 'Forge' }],
  swarms: [{ id: 'sw_forge00001', name: 'Forge' }],
  pending: 1,
}
const opens = (q: string) => understand(q, w).flatMap((s) => (s.act?.do === 'feature' ? [s.act.id] : []))

describe('Still: the intent field reaches every hive feature', () => {
  it('NAV_FEATURES is the whole registry', () => {
    expect([...NAV_FEATURES].sort()).toEqual(FEATURES.map((f) => f.id).sort())
  })
  it.each(FEATURES.map((f) => [f.label, f.id]))('typing “%s” offers %s', (label, id) => {
    expect(opens(label)).toContain(id)
  })
  it.each([
    ['show usage', 'money.usage'],
    ['people', 'people.manage'],
    ['files', 'work.assets'],
    ['settle calls', 'decide.reservations'],
    ['move a mind', 'minds.move'],
    ['decision history', 'decide.history'],
    ['show me the policy rules', 'decide.rules'],
    ['live activity', 'watch.activity'],
    ['create a mind', 'minds.create'],
    ['beliefs', 'swarms.beliefs'],
    ['goals', 'work.goals'],
    ['everything', 'hive.help'],
  ])('“%s” → %s', (q, id) => {
    expect(opens(q)[0]).toBe(id)
  })
})

describe('Still: start a swarm', () => {
  it.each(['start a swarm', 'new swarm called OmegaTruth', 'make a private swarm for OmegaTruth', 'create a swarm', 'Start a new private swarm'])('%s → launch preview, top suggestion', (q) => {
    const s = understand(q, w)[0]
    expect(s.key).toBe('launch')
    expect(s.act).toMatchObject({ do: 'feature', id: 'swarms.launch' })
    expect(s.parts.map((p) => p.t).join('')).toMatch(/Private/)
  })
  it('keeps the name', () => {
    expect(understand('new swarm called OmegaTruth', w)[0].act).toMatchObject({ name: 'OmegaTruth' })
    expect(understand('make a private swarm for OmegaTruth', w)[0].parts.map((p) => p.t).join('')).toContain('private swarm')
  })
  it('swarms.launch and minds.create are in NAV_FEATURES', () => {
    expect(NAV_FEATURES).toContain('swarms.launch')
    expect(NAV_FEATURES).toContain('minds.create')
  })
})

describe('Still: feature suggestions never change anything by themselves', () => {
  it('feature acts are not consequential, and names still lead', () => {
    expect(CONSEQUENTIAL.has('feature')).toBe(false)
    expect(understand('Vega, show usage', w)[0].act).toMatchObject({ do: 'send', mind: { id: 'ag_vega000001' } })
  })
  it('the coverage line says exactly what is native here', () => {
    expect([...NATIVE.still].sort()).toEqual([...STILL_NATIVE].sort())
  })
})
