// @vitest-environment node
/** The key field on real ReactDOM (the MiniDOM): what is typed stays in the field and goes back only with the submit press. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../ui/miniDom.testkit'
import { Screen, type ScreenHost, type ScreenItem } from './Screen'
import { ScreensSpace, SCREEN_SOURCES } from './screenSpace'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const space = ScreensSpace.open([...SCREEN_SOURCES, ['gate', `
(Screen gate "Gate")
(Part gate 10 keyfield ((label "Gate code") (submit "Open") (action open-gate) (cancel "Not now") (cancel_action leave)))
`]])
let container: MiniNode, root: Root
let saved: Record<string, unknown>

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
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

describe('the key field, mounted', () => {
  it('sends the trimmed key with the submit press, never into the page data; Cancel sends its own press', async () => {
    const got: [string, ScreenItem][] = []
    const host: ScreenHost = { data: {}, onAction: (a, it) => got.push([a, it]) }
    await act(async () => root.render(createElement(Screen, { plan: space.compose('gate', 'classic'), host })))
    const input = container.findAll((n) => n.tagName === 'INPUT')[0]
    const form = container.findAll((n) => n.tagName === 'FORM')[0]
    const submit = () => (reactProps(form).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined })
    await act(async () => { submit() })
    expect(got).toEqual([])   // nothing typed: nothing sent
    await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value: '  4-2-7  ' } }) })
    expect(reactProps(input).value).toBe('  4-2-7  ')
    await act(async () => { submit() })
    expect(got).toEqual([['open-gate', { value: '4-2-7' }]])
    expect(host.data).toEqual({})
    const cancel = container.findAll((n) => n.tagName === 'BUTTON').find((b) => b.textContent === 'Not now')
    await act(async () => { press(cancel!) })
    expect(got.at(-1)).toEqual(['leave', {}])
  })
})
