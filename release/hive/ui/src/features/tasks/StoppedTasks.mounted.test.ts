// Purpose: verify that both conversation placements read, retain and acknowledge the person's stops.
// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import type { Root } from 'react-dom/client'
import type { HiveClient } from '../../api/client'
import type { TaskStop } from '../../api/taskStops'
import { Emitter } from '../../api/client'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import { ScreensSpace } from '../../screens/screenSpace'

const state = vi.hoisted(() => ({ client: null as Partial<HiveClient> | null, resyncs: 0 }))
vi.mock('../../store/store', () => ({
  useHive: (select: (s: typeof state) => unknown) => select(state),
  hiveBus: { on: () => () => undefined },
}))
vi.mock('../../shell/uiVariant', () => ({ useLook: () => ({ current: { experience: 'classic' } }) }))
vi.mock('../../screens/useCompose', () => ({ useCompose: () => (name: string, facts: Parameters<typeof space.compose>[2]) => space.compose(name, 'classic', facts) }))
import { StoppedTasks } from './StoppedTasks'

const space = ScreensSpace.open()
let container: MiniNode, root: Root, saved: Record<string, unknown>
const first: TaskStop = { id: 'receipt-one', goal_id: 'task-one', mind_id: 'mind-one', title: 'Observatory hours',
  status: 'failed', reason: 'No opening hours were published.', stopped_at: '2026-11-17T06:00:00Z' }
const second: TaskStop = { ...first, id: 'receipt-two', mind_id: 'mind-two', title: 'Telescope manual' }
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }

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
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [key, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[key] = value
})

it('Ask shows every stop, chat shows its own mind, and Got it clears both after the server confirms', async () => {
  let kept = [first, second]
  let accept: (() => void) | undefined
  const acknowledged: string[] = []
  state.client = { listTaskStops: async () => ({ stops: kept }), acknowledgeTaskStop: (id) => {
    acknowledged.push(id)
    return new Promise((resolve) => { accept = () => { kept = kept.filter((stop) => stop.id !== id); resolve({ ok: true }) } })
  } }
  await act(async () => root.render(createElement(Fragment, null, createElement(StoppedTasks), createElement(StoppedTasks, { mind: 'mind-one' }))))
  await flush()
  expect(container.textContent.match(/Observatory hours/g)).toHaveLength(2)
  expect(container.textContent.match(/Telescope manual/g)).toHaveLength(1)
  await act(async () => press(container.findAll((node) => node.tagName === 'BUTTON' && node.textContent === 'Got it')[0]))
  expect(acknowledged).toEqual(['receipt-one'])
  expect(container.textContent.match(/Observatory hours/g)).toHaveLength(2)
  await act(async () => accept!())
  await flush()
  expect(container.textContent).not.toContain('Observatory hours')
  expect(container.textContent).toContain('Telescope manual')
})

it('a refused acknowledgment keeps the receipt and a retry clears the error', async () => {
  state.client = { listTaskStops: async () => ({ stops: [first] }), acknowledgeTaskStop: async () => { throw new Error('Could not save Got it.') } }
  await act(async () => root.render(createElement(StoppedTasks)))
  await flush()
  await act(async () => press(container.findAll((node) => node.tagName === 'BUTTON' && node.textContent === 'Got it')[0]))
  await flush()
  expect(container.textContent).toContain(first.title)
  expect(container.textContent).toContain('Could not save Got it.')
  await act(async () => press(container.findAll((node) => node.tagName === 'BUTTON' && node.textContent === 'Try again')[0]))
  await flush()
  expect(container.textContent).toContain(first.title)
  expect(container.textContent).not.toContain('Could not save Got it.')
})

it('a new sign-in drops the earlier person’s receipt before the new read returns', async () => {
  let identity = {}
  const auth = new Emitter<void>()
  let resolve: ((value: { stops: TaskStop[] }) => void) | undefined
  state.client = { authContext: () => identity, onAuthChange: (fn) => auth.on(fn),
    listTaskStops: async () => ({ stops: [first] }) }
  await act(async () => root.render(createElement(StoppedTasks)))
  await flush()
  expect(container.textContent).toContain(first.title)
  state.client.listTaskStops = () => new Promise((done) => { resolve = done })
  await act(async () => { identity = {}; auth.emit() })
  expect(container.textContent).not.toContain(first.title)
  await act(async () => resolve!({ stops: [] }))
  await flush()
  expect(container.textContent).not.toContain(first.title)
})
