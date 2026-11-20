// @vitest-environment node
// Purpose: verify what the folded Ask counts as waiting comes from the very reads the Ask's cards draw: one read of the
// offers and one of the stops however many places use them, a Not now on a card counted at once, offer and goal news
// read once each, and cards that open again shown from the lists the mark kept, with no new read.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import { ScreensSpace } from '../../screens/screenSpace'

type Heard = { type: string; agent_id?: string }
const state = vi.hoisted(() => ({ client: null as Record<string, unknown> | null, resyncs: 0, heard: new Set<(e: { type: string; agent_id?: string }) => void>() }))
// the store as the cards, lib/useResource and lib/identityEpoch read it (each test's client is one identity)
vi.mock('../../store/store', () => ({
  useHive: Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => ({ client: state.client, session: null, inits: 0 }),
    subscribe: () => () => undefined,
  }),
  hiveBus: { on: (fn: (e: Heard) => void) => { state.heard.add(fn); return () => { state.heard.delete(fn) } } },
}))
vi.mock('../../shell/uiVariant', () => ({ useLook: () => ({ current: { experience: 'classic' } }) }))
vi.mock('../../screens/useCompose', () => ({ useCompose: () => (name: string, facts: Parameters<typeof space.compose>[2]) => space.compose(name, 'classic', facts) }))
const { CreateOffers } = await import('../dot/CreateOffers')
const { StoppedTasks } = await import('../tasks/StoppedTasks')
const { useAskWaiting } = await import('./waiting')

const space = ScreensSpace.open()
let container: MiniNode, root: Root, saved: Record<string, unknown>
const counted: { offers: number; stops: number }[] = []
// what the folded Ask's mark sees
function Mark() {
  counted.push(useAskWaiting())
  return null
}
const offer = (id: string, sentence: string) => ({ id, mind: { id: 'a_dot', name: 'Dot' }, sentence, state: 'offered', plan_id: null, created_at: '2026-11-20T09:30:00Z' })
const STOP = { id: 'receipt-one', goal_id: 'task-one', mind_id: 'a_dot', title: 'Observatory hours', status: 'failed', reason: 'No opening hours were published.', stopped_at: '2026-11-17T06:00:00Z' }
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
  counted.length = 0
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [key, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[key] = value
})

it('the mark counts from the cards’ own reads: one of each, a Not now counted at once, news read once, cards reopened unread', async () => {
  const reads = { offers: 0, stops: 0 }
  let open = [offer('cof_1', 'a tip calculator'), offer('cof_2', 'a blue tip calculator')]
  state.client = {
    createOffers: async (mind?: string) => { expect(mind).toBeUndefined(); reads.offers++; return open },
    createOfferDismiss: async (id: string) => { open = open.filter((o) => o.id !== id); return { id, state: 'dismissed' } },
    listTaskStops: async () => { reads.stops++; return { stops: [STOP] } },
  }
  const cards = createElement(Fragment, { key: 'cards' }, createElement(StoppedTasks), createElement(CreateOffers))
  const mark = createElement(Mark, { key: 'mark' })
  await act(async () => root.render(createElement(Fragment, null, cards, mark)))
  await flush()
  expect(reads).toEqual({ offers: 1, stops: 1 })
  expect(counted.at(-1)).toEqual({ offers: 2, stops: 1 })

  // Not now on a card: the mark counts one offer at once, from the same read, with nothing read again
  await act(async () => press(buttons('Not now')[0]))
  await flush()
  expect(counted.at(-1)).toEqual({ offers: 1, stops: 1 })
  expect(reads).toEqual({ offers: 1, stops: 1 })

  // news the cards and the mark both listen for is read once each
  await hear({ type: 'create.offer', agent_id: 'a_dot' })
  await hear({ type: 'goal.updated' })
  expect(reads).toEqual({ offers: 2, stops: 2 })

  // the thread folds (the cards go) and opens again: the mark kept both reads, so the cards show them with no new read
  await act(async () => root.render(createElement(Fragment, null, mark)))
  await flush()
  await act(async () => root.render(createElement(Fragment, null, cards, mark)))
  expect(container.textContent).toContain('Dot can build this in Create: “a blue tip calculator”')
  expect(container.textContent).toContain('Observatory hours')
  await flush()
  expect(reads).toEqual({ offers: 2, stops: 2 })
})
