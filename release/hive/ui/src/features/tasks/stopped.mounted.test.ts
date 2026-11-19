// Purpose: verify stopped-task words and acknowledgment presses mounted in every look.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { TaskStop } from '../../api/taskStops'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { stoppedScreen } from './stopped'

const space = ScreensSpace.open()
const LOOKS = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
const receipt: TaskStop = { id: 'receipt-one', goal_id: 'task-one', mind_id: 'mind-one', title: 'Observatory hours',
  status: 'failed', reason: 'The observatory has not published its opening hours.', stopped_at: '2026-11-17T06:00:00Z' }
let container: MiniNode, root: Root, saved: Record<string, unknown>

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

async function mount(look: string, rows: TaskStop[], busy: string | null = null, error = '') {
  const compose = (name: string, facts: Parameters<typeof space.compose>[2]) => space.compose(name, look, facts)
  const { data, facts } = stoppedScreen(rows, compose, busy, error)
  const presses: { name: string; item: ScreenItem }[] = []
  const plan = compose('stopped-tasks', facts)
  await act(async () => root.render(createElement(Screen, { plan, host: { data, onAction: (name, item) => presses.push({ name, item }) } })))
  return { plan, presses, text: container.textContent, buttons: container.findAll((node) => node.tagName === 'BUTTON') }
}

describe('the shared stopped-task screen', () => {
  it.each(LOOKS)('%s shows the request and why it stopped until Got it is pressed', async (look) => {
    const view = await mount(look, [receipt])
    expect(view.text).toContain('Observatory hours')
    expect(view.text).toContain(receipt.reason)
    expect(view.text).toContain('Could not finish')
    expect(view.plan.parts.map((part) => part.order)).toEqual([10])
    expect(view.plan.missing).toEqual([])
    await act(async () => press(view.buttons.find((button) => button.textContent === 'Got it')!))
    expect(view.presses).toEqual([{ name: 'acknowledge', item: { scope: ['receipt-one'] } }])
    expect((await mount(look, [])).text).toBe('')
  })
  it.each(LOOKS)('%s names a stall and retains the reason while acknowledgment is being saved', async (look) => {
    const view = await mount(look, [{ ...receipt, status: 'stalled' }], receipt.id)
    expect(view.text).toContain('Stalled')
    expect(view.text).toContain(receipt.reason)
    expect(reactProps(view.buttons[0]).disabled).toBe(true)
  })
  it.each(LOOKS)('%s keeps the task beside a read or acknowledgment error and offers retry', async (look) => {
    const view = await mount(look, [receipt], null, 'Could not reach the hive.')
    expect(view.text).toContain(receipt.reason)
    expect(view.text).toContain('Could not reach the hive.')
    await act(async () => press(view.buttons.find((button) => button.textContent === 'Try again')!))
    expect(view.presses[0].name).toBe('retry')
  })
  it('reaches every declared condition and satisfies every screen guard', () => {
    expect(space.orders('stopped-tasks')).toEqual([10, 20, 21])
    expect(space.orders('stopped-task')).toEqual([10, 20, 30])
    expect(Object.values(space.guards()).flat()).toEqual([])
  })
})
