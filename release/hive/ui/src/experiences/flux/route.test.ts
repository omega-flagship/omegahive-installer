import { beforeEach, describe, expect, it, vi } from 'vitest'

// Surface O: Flux opens one swarm's place exactly where the shared map (experiences/targets.ts) says, and with no
// swarm open it asks which one; it never falls back to the generic swarms list (Review B1/B2).
const went: unknown[] = []
vi.mock('../../lib/router', async (orig) => ({ ...(await orig<typeof import('../../lib/router')>()), navigate: (r: unknown) => void went.push(r) }))

const { FEATURES } = await import('../../features/registry')
const { runFeature, targetFor, usePickSwarm } = await import('./nav')
type Api = Parameters<typeof runFeature>[1]

const f = (id: string) => FEATURES.find((x) => x.id === id)!
const api = (view: unknown): Api => ({ view, desktop: true, openSheet: () => undefined, home: () => undefined, openDecision: () => undefined }) as unknown as Api

beforeEach(() => {
  went.length = 0
  usePickSwarm.setState({ picking: null })
})

describe('Surface O: Flux reaches one swarm’s exact place', () => {
  it.each([
    ['swarms.edit', { name: 'swarm', id: 's_lyra', tab: 'settings' }],
    ['swarms.vocabulary', { name: 'swarm', id: 's_lyra', tab: 'vocab' }],
    ['swarms.connections', { name: 'swarm', id: 's_lyra', tab: 'connections' }],
    ['swarms.services', { name: 'swarm', id: 's_lyra', tab: 'connections' }],
    ['swarms.requests', { name: 'swarm', id: 's_lyra', tab: 'requests' }],
    ['swarms.lifecycle', { name: 'lifecycle', swarm: 's_lyra' }],
  ])('%s with a swarm open opens that swarm’s place', (id, route) => {
    expect(targetFor(f(id))).toEqual({ kind: 'swarm' })
    runFeature(f(id), api({ kind: 'swarm', id: 's_lyra' }))
    expect(went).toEqual([route])
    expect(usePickSwarm.getState().picking).toBeNull()
  })

  it('with no swarm open it asks which swarm, and opens nothing generic', () => {
    for (const id of ['swarms.edit', 'swarms.requests', 'swarms.lifecycle']) {
      usePickSwarm.setState({ picking: null })
      runFeature(f(id), api({ kind: 'home' }))
      expect(usePickSwarm.getState().picking?.id).toBe(id)
    }
    expect(went).toEqual([])
  })
})
