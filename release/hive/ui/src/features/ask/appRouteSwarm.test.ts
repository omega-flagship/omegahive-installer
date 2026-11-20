// Purpose: an app the Ask opens without a swarm of its own prefers the swarm of the mind the Ask is with, and the app
// page decides whether it opens there (features/programs/pickSwarm.ts), while a route naming its swarm, and any other
// route, goes as it was named. A tester's Open Commons Explorer found no swarm they could use while their mind Taiga's
// panel opened it (20 Nov); Jon asked on #574 for a preference, not a fixed route swarm (20 Nov).
import { beforeEach, describe, expect, it, vi } from 'vitest'

// the page's location, played in node: navigate() moves the hash, as the router does (store/askBoundaries.test.ts)
const loc = { hash: '#/', search: '', pathname: '/' }
const kept = new Map<string, string>()
vi.stubGlobal('window', {
  location: loc,
  matchMedia: () => ({ matches: false }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) },
})
vi.mock('../../lib/router', async (orig) => {
  const real = await orig<typeof import('../../lib/router')>()
  return { ...real, navigate: (r: import('../../lib/router').Route) => void (loc.hash = real.href(r)) }
})

const { href, parse } = await import('../../lib/router')
const { performAct } = await import('./run')
type IntentAct = import('../../lib/intent').IntentAct

type Route = import('../../lib/router').Route
const open = (route: Route) => ({ do: 'route', route, label: 'Commons Explorer' }) as unknown as IntentAct

beforeEach(() => {
  loc.hash = '#/'
})

describe('an app the Ask opens prefers where the mind it is with is, and the app page decides', () => {
  it('a program route with no swarm carries the swarm of the mind the Ask is with as a preference, never as its swarm', async () => {
    await performAct(open({ name: 'program', id: 'commons-explorer' }), { you: 'open commons explorer', experience: 'classic', swarm: 's_taiga' })
    expect(loc.hash).toBe(href({ name: 'program', id: 'commons-explorer', prefer: 's_taiga' }))
    expect(parse(loc.hash)).toEqual({ name: 'program', id: 'commons-explorer', prefer: 's_taiga' })
    expect(parse(loc.hash)).not.toHaveProperty('swarm', 's_taiga')
  })
  it('with no mind to be with, or a route that names its swarm, the route goes as it was named', async () => {
    await performAct(open({ name: 'program', id: 'commons-explorer' }), { you: 'open commons explorer', experience: 'classic' })
    expect(loc.hash).toBe(href({ name: 'program', id: 'commons-explorer' }))
    await performAct(open({ name: 'program', id: 'commons-explorer', swarm: 's_team' }), { you: 'open commons explorer in team', experience: 'classic', swarm: 's_taiga' })
    expect(loc.hash).toBe(href({ name: 'program', id: 'commons-explorer', swarm: 's_team' }))
  })
  it('any other route ignores the mind’s swarm', async () => {
    await performAct({ do: 'route', route: { name: 'goals' }, label: 'Tasks' } as unknown as IntentAct, { you: 'open tasks', experience: 'classic', swarm: 's_taiga' })
    expect(loc.hash).toBe(href({ name: 'goals' }))
  })
})
