// @vitest-environment node
// Purpose: the Ask's "connect a model first" state (connect.metta, connect.ts; omegahive-feedback#135) mounted on real
// ReactDOM in every look: it says a model is needed, offers the one press that opens You and your keys with the add-key
// form showing, and shows nothing once a model is there.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { onAddKeyRequest, requestAddKey, takeAddKeyRequest } from '../keys/addKeyIntent'
import { connectScreen } from './connect'

const LOOKS = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
const REST = 'Connect a model to start asking. This hive has no model you can use yet.'
const HELD = 'Connect a model first. Your request wasn’t sent. Your words are kept.'
const space = ScreensSpace.open()
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

async function mount(look: string, needs: boolean, held: boolean) {
  const { data, facts } = connectScreen(needs, held)
  const pressed: string[] = []
  const host: ScreenHost = { data, onAction: (a) => void pressed.push(a) }
  const plan = space.compose('ask-connect', look, facts)
  await act(async () => root.render(createElement(Screen, { plan, host })))
  const buttons = container.findAll((n) => n.tagName === 'BUTTON')
  return { plan, pressed, text: container.textContent, button: (label: string) => buttons.find((b) => b.textContent === label) }
}

describe('connect a model first, mounted in every look', () => {
  it.each(LOOKS)('%s: at rest it says a model is needed and offers Add a key', async (look) => {
    const { plan, pressed, text, button } = await mount(look, true, false)
    expect(plan.parts.map((p) => p.order)).toEqual([10, 20])
    expect(text).toContain(REST)
    expect(text).not.toContain(HELD)
    await act(async () => { press(button('Add a key')!) })
    expect(pressed).toEqual(['add-key'])
    expect(plan.missing).toEqual([])
  })
  it.each(LOOKS)('%s: after Enter it says the words were kept and not sent, with the same press', async (look) => {
    const { plan, text, button } = await mount(look, true, true)
    expect(plan.parts.map((p) => p.order)).toEqual([11, 20])
    expect(text).toContain(HELD)
    expect(button('Add a key')).toBeDefined()
    expect(plan.missing).toEqual([])
  })
  it.each(LOOKS)('%s: with a model there is nothing to show', async (look) => {
    const { plan, text, button } = await mount(look, false, false)
    expect(plan.parts).toEqual([])
    expect(text).toBe('')
    expect(button('Add a key')).toBeUndefined()
  })
  it('the words are plain: no internal codes', async () => {
    for (const words of [REST, HELD]) expect(words).not.toMatch(/[a-z]+_[a-z]+|provider|route|\b40[0-9]\b/)
  })
})

describe('the wish to open the add-key form (addKeyIntent)', () => {
  it('is taken once, by the You page when it mounts or at once when it is showing', () => {
    expect(takeAddKeyRequest()).toBe(false)
    requestAddKey()
    expect(takeAddKeyRequest()).toBe(true)
    expect(takeAddKeyRequest()).toBe(false)
    let told = 0
    const off = onAddKeyRequest(() => { told++ })
    requestAddKey()
    expect(told).toBe(1)
    off()
    requestAddKey()
    expect(told).toBe(1)
    expect(takeAddKeyRequest()).toBe(true)
  })
})
