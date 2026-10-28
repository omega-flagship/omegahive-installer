import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The first-visit welcome in demo mode: "Watch it run" is a choice inside the dialog (it used to cover the demo card's
// own button), it starts the showreel by the card's path, and it is never offered or played off the demo simulator.
// The dialog's existing choices stay. INVENTED data only; nothing here reaches a hive or a model.

// A server render reads a zustand store through its server snapshot (the initial state); read the live one instead.
vi.mock('zustand', async (orig) => {
  const z = await orig<typeof import('zustand')>()
  const build = (init: never) => {
    const api = z.createStore(init)
    ;(api as { getInitialState: unknown }).getInitialState = api.getState
    return Object.assign((sel?: never) => z.useStore(api, sel as never), api)
  }
  return { ...z, create: ((init?: never) => (init ? build(init) : build)) as never }
})

const store = new Map<string, string>()
vi.stubGlobal('window', {
  location: { hash: '#/me', search: '?sim=1', pathname: '/' },
  matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
})

const { Welcome } = await import('./Intro')
const { useIntro } = await import('./introStore')
const { useHive } = await import('../store/store')
const { useReel, resetReel } = await import('../features/showreel/store')

const demoClient = { mode: 'sim' as const, demo: true }
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}
const welcome = () => renderToStaticMarkup(createElement(Welcome))

beforeEach(() => {
  resetReel()
  useIntro.setState({ welcome: true, tour: null, afterWelcome: null })
})
afterEach(() => resetReel())

describe('the welcome dialog offers the showreel in demo mode only', () => {
  it('demo simulator: a "Watch it run" button in the dialog, beside its existing choices', () => {
    useHive.setState({ client: demoClient as never, session: 's1', inits: 1 })
    const html = welcome()
    expect(html).toMatch(/<button type="button"[^>]*data-welcome-showreel=""[^>]*><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Watch it run<\/button>/)
    expect(html).toContain('Watch the tour')
    expect(html).toContain('Explore on my own')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Simulation.')
  })
  it('a plain simulator or a real hive: no "Watch it run", the same two choices', () => {
    for (const client of [{ mode: 'sim' }, { mode: 'live' }]) {
      useHive.setState({ client: client as never })
      const html = welcome()
      expect(html).not.toContain('Watch it run')
      expect(html).not.toContain('data-welcome-showreel')
      expect(html).toContain('Watch the tour')
      expect(html).toContain('Explore on my own')
      expect(html.includes('Simulation.')).toBe(client.mode === 'sim')
    }
  })
  it('choosing it answers the welcome and starts the showreel (no tour)', async () => {
    useHive.setState({ client: demoClient as never, session: 's1', inits: 1 })
    useIntro.getState().answerWelcome('showreel')
    expect(useIntro.getState().welcome).toBe(false)
    expect(useIntro.getState().tour).toBeNull()
    await settle()
    expect(useReel.getState().reel.status).toBe('playing')
  })
  it('the other choices do not start it, and it never plays off the demo simulator', async () => {
    useHive.setState({ client: demoClient as never, session: 's1', inits: 1 })
    useIntro.getState().answerWelcome('explore')
    await settle()
    expect(useReel.getState().reel.status).toBe('idle')
    useHive.setState({ client: { mode: 'sim' } as never })
    useIntro.getState().answerWelcome('showreel')
    await settle()
    expect(useReel.getState().reel.status).toBe('idle')
  })
})
