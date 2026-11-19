// @vitest-environment node
// Purpose: the mind-refused screen (refused.metta, refused.ts) mounted on real ReactDOM in every look: a refusal of the
// mind's own model calls shows the hive's sentence, when it tries again, and the presses that help for its remedy;
// with none kept, nothing shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { MindRefusal } from '../../api/types'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { refusedScreen } from './refused'
import professionalIndex from '../../experiences/professional/index.tsx?raw'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const LOOKS = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
const NOW = Date.parse('2026-11-17T06:56:00.000Z')
const NO_CREDIT = 'OpenRouter says the account that pays for this mind has no credit left. Add credit there, or choose a free model or another key for this mind.'
const BUSY = 'OpenRouter is taking no more calls to google/gemma-4-31b-it:free for now, so this mind tries again in 30 seconds. Choose another model to go on sooner.'
const refusal = (over: Partial<MindRefusal>): MindRefusal => ({
  code: 'provider_no_credit', say: NO_CREDIT, remedy: 'credit', count: 3, since: '2026-11-17T06:50:00.000Z',
  retry_at: '2026-11-17T07:00:00.000Z', ...over,
})
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

async function mount(look: string, kept: MindRefusal | null) {
  const { data, facts } = refusedScreen({ refused: kept }, NOW)
  const pressed: string[] = []
  const host: ScreenHost = { data, onAction: (a) => void pressed.push(a) }
  const plan = space.compose('mind-refused', look, facts)
  await act(async () => root.render(createElement(Screen, { plan, host })))
  const buttons = container.findAll((n) => n.tagName === 'BUTTON')
  return { plan, pressed, text: container.textContent, button: (label: string) => buttons.find((b) => b.textContent === label) }
}

describe('why a mind is quiet, mounted in every look', () => {
  it.each(LOOKS)('%s: an empty account says so and offers a key or another model', async (look) => {
    const { plan, pressed, text, button } = await mount(look, refusal({}))
    expect(plan.parts.map((p) => p.order)).toEqual([11, 12, 20, 21])
    expect(plan.parts.find((p) => p.order === 11)?.props.tone).toBe('bad')
    expect(text).toContain(NO_CREDIT)
    expect(text).toContain('3 calls in a row were refused. It tries again in about 4 minutes, or as soon as someone writes to it.')
    await act(async () => { press(button('Your keys')!) })
    await act(async () => { press(button('Choose a model')!) })
    expect(pressed).toEqual(['open-keys', 'choose-model'])
    expect(plan.missing).toEqual([])
  })
  it.each(LOOKS)('%s: a wait reads as a warning and offers only another model', async (look) => {
    const { plan, text, button } = await mount(look, refusal({ code: 'provider_busy', say: BUSY, remedy: 'wait', count: 1, retry_at: '2026-11-17T06:56:30.000Z' }))
    expect(plan.parts.map((p) => p.order)).toEqual([10, 12, 21])
    expect(plan.parts.find((p) => p.order === 10)?.props.tone).toBe('warn')
    expect(text).toContain(BUSY)
    expect(text).toContain('It tries again in 30 seconds, or as soon as someone writes to it.')
    expect(button('Your keys')).toBeUndefined()
    expect(button('Choose a model')).toBeDefined()
  })
  it.each(LOOKS)('%s: a refused key offers your keys and another model', async (look) => {
    const { plan } = await mount(look, refusal({ code: 'provider_key_refused', remedy: 'key', say: 'OpenRouter refused the key that pays for this mind.' }))
    expect(plan.parts.map((p) => p.order)).toEqual([11, 12, 20, 21])
  })
  it.each(LOOKS)('%s: a model it can’t use offers another model only, and the hive’s own rule names no time', async (look) => {
    // the hive's own refusals hold no call, so the hive sends no retry_at: the line says only how many in a row
    const held = refusal({ code: 'free_model_unreconciled', remedy: 'model', say: 'openrouter/google/gemma-4-31b-it:free is paused.', retry_at: null })
    const { plan, text } = await mount(look, held)
    expect(plan.parts.map((p) => p.order)).toEqual([11, 12, 21])
    expect(text).toContain('3 calls in a row were refused.')
    expect(text).not.toContain('tries again')
    // one call refused and no time to name: no line at all
    expect((await mount(look, { ...held, count: 1 })).plan.parts.map((p) => p.order)).toEqual([11, 21])
  })
  it('with no refusal kept, or one in a shape the page doesn’t know, nothing shows', async () => {
    expect((await mount('classic', null)).plan.parts).toEqual([])
    expect((await mount('classic', refusal({ remedy: 'pray' as MindRefusal['remedy'] }))).plan.parts).toEqual([])
    expect((await mount('classic', refusal({ say: '' }))).plan.parts).toEqual([])
  })
  it('the time has come: it tries now', () => {
    expect(refusedScreen({ refused: refusal({ count: 1, retry_at: '2026-11-17T06:55:00.000Z' }) }, NOW).data['refused.when'])
      .toBe('It tries again now, or as soon as someone writes to it.')
  })
  it('Professional draws a mind’s chat itself, and the notice sits above its conversation there too', () => {
    // the lens's case at a27f2f8e: Professional's mind view renders Conversation directly, not the Dot panel, so the
    // notice is mounted in that chat card as well; the looks above show the screen draws in Professional
    const card = professionalIndex.slice(professionalIndex.indexOf('pr-chat-card'))
    expect(card.indexOf('<RefusedNotice agent={activeMind}')).toBeGreaterThan(-1)
    expect(card.indexOf('<RefusedNotice agent={activeMind}')).toBeLessThan(card.indexOf('<Conversation key='))
  })
  it('the guards stay clean', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
  })
})
