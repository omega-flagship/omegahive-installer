import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SimClient } from '../../api/sim/SimClient'
import { useHive } from '../../store/store'
import SwarmView from './SwarmView'

/**
 * A swarm's own page while its commons holds no beliefs: the sky says that none is shared yet and what puts one there
 * (swarms.metta, swarm-commons), so a 0 isn't read as the commons not working. The real page, rendered on the
 * simulation's invented swarms; only the store's beliefs and members are changed for each case.
 */

// A server render reads a zustand store through its server snapshot (the initial state); read the live one instead
// (the same shim as forms/readability.test.ts).
vi.mock('zustand', async (orig) => {
  const z = await orig<typeof import('zustand')>()
  const build = (init: never) => {
    const api = z.createStore(init)
    ;(api as { getInitialState: unknown }).getInitialState = api.getState
    return Object.assign((sel?: never) => z.useStore(api, sel as never), api)
  }
  return { ...z, create: ((init?: never) => (init ? build(init) : build)) as never }
})
// The page's info button portals into document.body, which a server render has none of.
vi.mock('../../tour/ViewInfo', () => ({ ViewInfo: () => null }))

let sim: SimClient
beforeAll(async () => {
  vi.stubGlobal('window', { location: { search: '', hash: '#/swarm/s_lyra', pathname: '/' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) })
  sim = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  sim.simSession = 'person'
  await useHive.getState().init(sim)
  await useHive.getState().loadBeliefs('s_lyra')
})
afterAll(() => {
  sim.disconnect()
  vi.unstubAllGlobals()
})

/** The sky of s_lyra's page, with its commons emptied and, when asked, its members gone. */
function sky(opts: { members?: string[] } = {}): string {
  const s = useHive.getState()
  const lyra = s.swarms.s_lyra
  useHive.setState({
    beliefs: { ...s.beliefs, s_lyra: {} },
    beliefsLoaded: { ...s.beliefsLoaded, s_lyra: true },
    swarms: { ...s.swarms, s_lyra: { ...lyra, member_ids: opts.members ?? lyra.member_ids } },
  } as never)
  const html = renderToStaticMarkup(createElement(SwarmView, { id: 's_lyra' }))
  const at = html.indexOf('data-tour="swarm-sky"')
  expect(at, 'the sky frame is drawn').toBeGreaterThan(-1)
  return html.slice(at)
}

describe('a swarm page whose commons holds no beliefs', () => {
  it('with minds: says it has no beliefs to show yet and that one shows once its owner lets the swarm see it', () => {
    expect(Object.keys(useHive.getState().beliefs.s_lyra ?? {}).length, 'the sim seeds s_lyra with beliefs').toBeGreaterThan(0)
    expect(useHive.getState().swarms.s_lyra.member_ids.length).toBeGreaterThan(0)
    const html = sky()
    expect(html).toContain('data-screen-part="swarm-commons.10"')
    expect(html).toContain('No beliefs to show yet')
    expect(html).toContain('A belief shows here once one of its minds holds one its owner lets the swarm see.')
    expect(html).not.toContain('When members publish')
  })
  it('with no minds: says beliefs come from its minds and it has none yet', () => {
    const html = sky({ members: [] })
    expect(html).toContain('data-screen-part="swarm-commons.11"')
    expect(html).toContain('No beliefs yet')
    expect(html).toContain('Beliefs come from a swarm&#x27;s minds, and this one has none yet.')
    expect(html).not.toContain('lets the swarm see')
  })
})
