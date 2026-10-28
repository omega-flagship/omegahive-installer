import { beforeEach, describe, expect, it, vi } from 'vitest'

// Surface O: Cosmos opens one system's place exactly where the shared map (experiences/targets.ts) says, and with no
// system focused it asks which one; it never falls back to the generic swarms list (Review B1/B2).
const went: unknown[] = []
vi.mock('../../lib/router', async (orig) => ({ ...(await orig<typeof import('../../lib/router')>()), navigate: (r: unknown) => void went.push(r) }))

const { FEATURES } = await import('../../features/registry')
const { runFeature, targetFor } = await import('./nav')
const { useCosmos } = await import('./state')
const { buildLayout } = await import('./layout')

const f = (id: string) => FEATURES.find((x) => x.id === id)!
const layout = buildLayout({}, {})

beforeEach(() => {
  went.length = 0
  useCosmos.setState({ view: { kind: 'galaxy' }, pickingSwarm: null })
})

describe('Surface O: Cosmos reaches one system’s exact place', () => {
  it.each([
    ['swarms.edit', { name: 'swarm', id: 's_lyra', tab: 'settings' }],
    ['swarms.vocabulary', { name: 'swarm', id: 's_lyra', tab: 'vocab' }],
    ['swarms.connections', { name: 'swarm', id: 's_lyra', tab: 'connections' }],
    ['swarms.services', { name: 'swarm', id: 's_lyra', tab: 'connections' }],
    ['swarms.requests', { name: 'swarm', id: 's_lyra', tab: 'requests' }],
    ['swarms.lifecycle', { name: 'lifecycle', swarm: 's_lyra' }],
  ])('%s at a focused system opens that system’s place', (id, route) => {
    expect(targetFor(f(id))).toEqual({ kind: 'swarm' })
    useCosmos.setState({ view: { kind: 'system', id: 's_lyra' } })
    runFeature(f(id), layout, true)
    expect(went).toEqual([route])
    expect(useCosmos.getState().pickingSwarm).toBeNull()
  })

  it('with no system focused it asks which system, and opens nothing generic', () => {
    for (const id of ['swarms.edit', 'swarms.vocabulary', 'swarms.lifecycle']) {
      useCosmos.setState({ pickingSwarm: null })
      runFeature(f(id), layout, true)
      expect(useCosmos.getState().pickingSwarm?.id).toBe(id)
    }
    expect(went).toEqual([])
  })
})
