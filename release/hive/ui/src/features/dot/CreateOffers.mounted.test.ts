// @vitest-environment node
// Purpose: verify where minds' offers to build in Create are drawn and pressed: the Ask's thread reads every mind's open
// offers, each card naming its own mind, and a mind's chat its own; any mind's offer news reloads the Ask's cards and
// only its own a chat's; Start in Create follows the plan it started and opens Create's Make bench, and Not now sets the
// offer aside, also after a sign-in change on a card that stayed mounted.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import type { Root } from 'react-dom/client'
import { Emitter } from '../../api/client'
import { CREATE_APP_ID } from '../../lib/displayName'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import { ScreensSpace } from '../../screens/screenSpace'

type Heard = { type: string; agent_id?: string }
const state = vi.hoisted(() => ({ client: null as Record<string, unknown> | null, heard: new Set<(e: { type: string; agent_id?: string }) => void>(),
  followed: [] as string[], went: [] as unknown[], storeListeners: new Set<() => void>() }))
// the store as the component and lib/identityEpoch read it: a selector hook, and the state and subscription the epoch
// reads at load (each test's client is one identity until a test changes its sign-in and tells the store's listeners)
vi.mock('../../store/store', () => ({
  useHive: Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => ({ client: state.client, session: null, inits: 0 }),
    subscribe: (fn: () => void) => { state.storeListeners.add(fn); return () => { state.storeListeners.delete(fn) } },
  }),
  hiveBus: { on: (fn: (e: Heard) => void) => { state.heard.add(fn); return () => { state.heard.delete(fn) } } },
}))
vi.mock('../../shell/uiVariant', () => ({ useLook: () => ({ current: { experience: 'classic' } }) }))
vi.mock('../../screens/useCompose', () => ({ useCompose: () => (name: string, facts: Parameters<typeof space.compose>[2]) => space.compose(name, 'classic', facts) }))
vi.mock('../createPlan/usePlan', () => ({ followPlan: (id: string) => { state.followed.push(id) } }))
vi.mock('../../lib/router', async (original) => ({ ...(await original<typeof import('../../lib/router')>()), navigate: (to: unknown) => { state.went.push(to) } }))
import { CreateOffers } from './CreateOffers'

const space = ScreensSpace.open()
let container: MiniNode, root: Root, saved: Record<string, unknown>
const offer = (id: string, mind: { id: string; name: string }, sentence: string) =>
  ({ id, mind, sentence, state: 'offered', plan_id: null, created_at: '2026-11-20T09:30:00Z' })
const DOT = { id: 'a_dot', name: 'Dot' }, BUILDER = { id: 'a_builder', name: 'Builder' }
const OFFERS = [offer('cof_1', DOT, 'a tip calculator'), offer('cof_2', BUILDER, 'a blue tip calculator')]
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
const hear = async (e: Heard) => { await act(async () => { for (const fn of [...state.heard]) fn(e) }); await flush() }
const buttons = (label: string) => container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
  state.followed = []; state.went = []
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [key, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[key] = value
})

it('the Ask reads every mind’s offers, each card naming its mind, and a chat its own mind’s; offer news reloads them', async () => {
  const asked: (string | undefined)[] = []
  state.client = { createOffers: async (mind?: string) => { asked.push(mind); return OFFERS.filter((o) => !mind || o.mind.id === mind) } }
  await act(async () => root.render(createElement(Fragment, null, createElement(CreateOffers), createElement(CreateOffers, { agent: DOT }))))
  await flush()
  expect(asked).toEqual([undefined, 'a_dot'])
  expect(container.textContent.match(/Dot can build this in Create: “a tip calculator”/g)).toHaveLength(2)
  expect(container.textContent.match(/Builder can build this in Create: “a blue tip calculator”/g)).toHaveLength(1)
  expect(buttons('Start in Create')).toHaveLength(3)
  // another mind's news reloads the Ask's cards and leaves the chat's alone; its own mind's reloads both
  asked.length = 0
  await hear({ type: 'create.offer', agent_id: 'a_builder' })
  expect(asked).toEqual([undefined])
  await hear({ type: 'create.offer', agent_id: 'a_dot' })
  expect(asked).toEqual([undefined, undefined, 'a_dot'])
  await hear({ type: 'goal.updated' })
  expect(asked).toHaveLength(3)
})

it('Start in Create in the Ask starts that offer, follows its plan and opens Create’s Make bench; Not now sets one aside', async () => {
  const started: string[] = [], dismissed: string[] = []
  let open = OFFERS
  state.client = {
    createOffers: async () => open,
    createOfferStart: async (id: string) => { started.push(id); open = open.filter((o) => o.id !== id); return { offer: { id, state: 'started' }, plan: { plan_id: 'plan_9' } } },
    createOfferDismiss: async (id: string) => { dismissed.push(id); open = open.filter((o) => o.id !== id); return { id, state: 'dismissed' } },
  }
  await act(async () => root.render(createElement(CreateOffers)))
  await flush()
  await act(async () => press(buttons('Start in Create')[1]))
  await flush()
  expect(started).toEqual(['cof_2'])
  expect(state.followed).toEqual(['plan_9'])
  expect(state.went).toEqual([{ name: 'program', id: CREATE_APP_ID, view: 'make' }])
  expect(container.textContent).not.toContain('a blue tip calculator')
  await act(async () => press(buttons('Not now')[0]))
  await flush()
  expect(dismissed).toEqual(['cof_1'])
  expect(container.textContent).not.toContain('can build this in Create')
})

it('a card that stays mounted across a sign-in change reads the new person’s offers, and their Not now still lands', async () => {
  let identity = {}
  const auth = new Emitter<void>()
  const dismissed: string[] = []
  let open = [OFFERS[0]]
  state.client = {
    authContext: () => identity, onAuthChange: (fn: () => void) => auth.on(fn),
    createOffers: async () => open,
    createOfferDismiss: async (id: string) => { dismissed.push(id); open = open.filter((o) => o.id !== id); return { id, state: 'dismissed' } },
  }
  await act(async () => root.render(createElement(CreateOffers)))
  await flush()
  expect(container.textContent).toContain('a tip calculator')
  // another person signs in on the same client: the store tells its listeners, as it does for every sign-in change
  open = [OFFERS[1]]
  await act(async () => { identity = {}; auth.emit(); for (const fn of [...state.storeListeners]) fn() })
  await flush()
  expect(container.textContent).not.toContain('“a tip calculator”')
  expect(container.textContent).toContain('a blue tip calculator')
  await act(async () => press(buttons('Not now')[0]))
  await flush()
  expect(dismissed).toEqual(['cof_2'])
  expect(container.textContent).not.toContain('can build this in Create')
})
