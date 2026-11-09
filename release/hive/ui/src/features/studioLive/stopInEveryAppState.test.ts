import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * r1.2 (Design o3-inline-stop-unavailable-r1): on an app route the one Stop is in the page's flow. Every state of the app
 * page keeps exactly one Stop while a session has a record (opening, unreadable, unlisted), and none without one.
 * Rendered with react-dom/server (no DOM library here). INVENTED session only.
 */
// SSR reads zustand's initial state; read the live store instead (the closeHome render tests' approach)
vi.mock('zustand', async (orig) => {
  const real = await orig<typeof import('zustand')>()
  type Init = (...a: never[]) => unknown
  const make = (init: Init) => {
    const api = real.createStore(init as never) as { getState: () => unknown }
    const hook = (sel: (s: unknown) => unknown = (s) => s) => sel(api.getState())
    return Object.assign(hook, api)
  }
  return { ...real, create: (init?: Init) => (init ? make(init) : make) }
})
vi.stubGlobal('window', { location: { search: '', hash: '#/program/omegadesign/s_forge' }, addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }), localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } })

const { AppUnavailable } = await import('../programs/ProgramPage')
const { useStudioLive } = await import('./store')
const { readLedger } = await import('./api')

const ledger = readLedger({
  session_id: 'ss_inv', stream_id: 'as_aaaaaaaaaaaaaaaaaaaaaaaa', state: 'active', ask_turn_id: 'op_inv', goal_id: 'g_inv', proposal_artifact_id: 'ar_inv', maker_id: 'a_inv',
  swarm_id: 's_forge', program_id: 'omegadesign', scene_id: 'sim-poster', steps: [], directions: [], budget: { cap: 2, spent: 0.1 }, stop: { state: 'none' }, piece: null,
}, 'ss_inv')!

describe('the one Stop on every app-page state', () => {
  for (const state of ['opening', 'unreadable', 'unlisted'] as const) {
    it(`${state}: exactly one Stop with a session, none without`, () => {
      useStudioLive.setState({ ledger, local: 'receiving' })
      const withSession = renderToStaticMarkup(createElement(AppUnavailable, { state }))
      expect(withSession.match(/data-studio-bar=""/g)?.length).toBe(1)
      expect(withSession.match(/>Stop</g)?.length).toBe(1)
      useStudioLive.setState({ ledger: null, local: null })
      const without = renderToStaticMarkup(createElement(AppUnavailable, { state }))
      expect(without).not.toContain('data-studio-bar')
    })
  }
})

describe('r1.13 (Design phone P2): the compact bar keeps the money whole', () => {
  it('spent of cap is its own unshrinkable part, apart from the step words; after Stop only an unsettled amount shows', () => {
    useStudioLive.setState({ ledger, local: 'receiving' })
    const live = renderToStaticMarkup(createElement(AppUnavailable, { state: 'opening' }))
    expect(live).toMatch(/<span class="sl-bar-money" data-studio-bar-money="">\$0\.10 of \$2\.00<\/span>/)
    expect(live).toMatch(/<span class="sl-bar-text">Create · [^<]*<\/span>/)
    useStudioLive.setState({ ledger, local: 'stopped' })
    const stopped = renderToStaticMarkup(createElement(AppUnavailable, { state: 'opening' }))
    expect(stopped).not.toContain('data-studio-bar-money')
    expect(stopped).toMatch(/Stopped here · /)
    useStudioLive.setState({ ledger: null, local: null })
  })
})
