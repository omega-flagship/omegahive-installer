// @vitest-environment node
// Purpose: the hive's logs in the feedback area on real ReactDOM (the MiniDOM), in every look: MeTTa composes the area
// (feedback.metta), Screen draws it, a press on Show the logs gathers them through the store, the next drawing shows them
// whole, and Save the logs saves exactly that text; nothing is saved before its press.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { HiveClient } from '../../api/client'
import type { FeedbackContext, FeedbackLogs } from '../../api/types'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'

const saved: { name: string; blob: Blob }[] = []
vi.mock('../../lib/download', () => ({ downloadBlob: vi.fn((name: string, blob: Blob) => saved.push({ name, blob })) }))

const { Screen } = await import('../../screens/Screen')
const { ScreensSpace } = await import('../../screens/screenSpace')
const { feedbackScreen } = await import('./data')
const { closeFeedback, openFeedback, reportOf, saveLogs, showLogs, useFeedback } = await import('./store')

// the first look composes the whole area cold: its own measured cap (api/sim/simTimeouts.test.ts MEASURED)
vi.setConfig({ testTimeout: 40_000 })

const space = ScreensSpace.open()
const LOOKS = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
const CTX: FeedbackContext = { version: 'Mac v0.33 (build 691e651a12)', which: 'own hive, Mac install', system: 'Mac', errors: [], to: { kind: 'none' } }
const LOGS: FeedbackLogs = {
  version: 'Mac v0.33 (build 691e651a12)', which: 'own hive, Mac install', system: 'Mac', scope: 'person', errors: [], log: [],
  requests: [{ at: '2026-11-17T01:23:40.000Z', method: 'POST', route: '/api/ask', status: 429, ms: 61, count: 2, who: 'you' }],
}
const client = { feedback: vi.fn(async () => CTX), feedbackLogs: vi.fn(async () => LOGS) } as unknown as HiveClient

let container: MiniNode, root: Root
let kept: Record<string, unknown>

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  kept = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) kept[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined,
    location: { hash: '#/settings' }, innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1 }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' })
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
  saved.length = 0
})
afterEach(async () => {
  await act(async () => root.unmount())
  closeFeedback()
  vi.unstubAllGlobals()
  for (const [k, v] of Object.entries(kept)) (globalThis as Record<string, unknown>)[k] = v
})

/** The area as FeedbackHost draws it: the store's state, data.ts's facts, MeTTa's composition for the look, Screen. */
async function draw(look: string) {
  const s = useFeedback.getState()
  const { data, facts } = feedbackScreen(s, reportOf(s, []), { share: false }, 0, [])
  const onAction = (action: string) => {
    if (action === 'logs-show') void showLogs(client)
    else if (action === 'logs-save') saveLogs()
  }
  await act(async () => root.render(createElement(Screen, { plan: space.compose('feedback', look, facts), host: { data, onAction } })))
}
const button = (label: string) => container.findAll((n) => n.tagName === 'BUTTON').find((b) => b.textContent === label)

describe("the hive's logs, mounted in every look", () => {
  it.each(LOOKS)('%s: Show gathers them, the area shows them whole, and Save saves that text', async (look) => {
    openFeedback(client, look)
    await draw(look)
    expect(button('Save the logs')).toBeUndefined()
    await act(async () => { press(button('Show the logs')!) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const logs = useFeedback.getState().logs
    expect(logs).toMatchObject({ shown: true, scope: 'person' })
    await draw(look)
    expect(container.findAll((n) => n.tagName === 'PRE').map((n) => n.textContent)).toContain(logs.text)
    expect(saved).toEqual([])
    await act(async () => { press(button('Save the logs')!) })
    expect(saved.map((s) => s.name)).toEqual([logs.file])
    expect(await saved[0].blob.text()).toBe(logs.text + '\n')
  })
})
