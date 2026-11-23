// @vitest-environment node
// Purpose: prove the ask-go-ahead screen (goAhead.metta, goAhead.ts) mounted on real ReactDOM in every look: the
// question in Jon's words with Go ahead and Stop, each press coming back, its buttons waiting while the answer is in
// flight, what became of the answer said, every part reachable, and every look drawing each part with a block it has.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { AskRow } from '../../store/ask'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { goAheadScreen } from './goAhead'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const LOOKS = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
type Question = NonNullable<AskRow['goAhead']>
const ASKED: Question = { spentUsd: 1.2, limitUsd: 1 }
const space = ScreensSpace.open()
const seen = new Set<number>()
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

async function mount(look: string, q: Question) {
  const { data, facts, busy } = goAheadScreen(q)
  const pressed: string[] = []
  const host: ScreenHost = { data, busy, onAction: (a) => void pressed.push(a) }
  const plan = space.compose('ask-go-ahead', look, facts)
  for (const p of plan.parts) seen.add(p.order)
  await act(async () => root.render(createElement(Screen, { plan, host })))
  const button = (label: string) => container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)[0]
  return { plan, pressed, text: container.textContent, button, find: (role: string) => container.findAll((n) => n.getAttribute('role') === role) }
}

describe('the go-ahead question, mounted in every look', () => {
  it.each(LOOKS)('%s: Jon’s words with Go ahead and Stop, said as it appears, each press coming back', async (look) => {
    const { plan, pressed, text, button, find } = await mount(look, ASKED)
    expect(plan.parts.map((p) => p.order)).toEqual([10])
    expect(text).toContain('This one looks expensive (about $1.20 so far). Go ahead?')
    const [dialog] = find('alertdialog')
    expect(dialog.getAttribute('aria-label')).toBe('This one looks expensive')
    for (const label of ['Go ahead', 'Stop']) expect(button(label).getAttribute('disabled'), label).toBeNull()
    await act(async () => press(button('Go ahead')))
    await act(async () => press(button('Stop')))
    expect(pressed).toEqual(['go-ahead', 'go-stop'])
    expect(plan.missing).toEqual([])
  })

  it.each(LOOKS)('%s: while the answer is in flight, both buttons wait', async (look) => {
    const { plan, button } = await mount(look, { ...ASKED, state: 'sending' })
    expect(plan.parts.map((p) => p.order)).toEqual([10])
    for (const label of ['Go ahead', 'Stop']) expect(button(label).getAttribute('disabled'), label).not.toBeNull()
  })

  it.each(LOOKS)('%s: a spend the hive did not give is never invented: the question without a figure', async (look) => {
    const { plan, text } = await mount(look, { spentUsd: null, limitUsd: null })
    expect(plan.parts.map((p) => p.order)).toEqual([11])
    expect(text).toContain('This one looks expensive. Go ahead?')
    expect(text).not.toContain('$')
    expect(plan.missing).toEqual([])
  })

  it.each(LOOKS)('%s: what became of the answer, each in its own words', async (look) => {
    const went = await mount(look, { ...ASKED, state: 'went' })
    expect(went.plan.parts.map((p) => p.order)).toEqual([20])
    expect(went.text).toBe('Going ahead. It won’t ask again for this one.')
    expect((await mount(look, { ...ASKED, state: 'stopping' })).text).toBe('Stopping.')
    const failed = await mount(look, { ...ASKED, state: 'failed', error: 'Could not reach the hive. Check the connection and try again.' })
    // not sent: the question stands, so the person may answer again, with why under it
    expect(failed.plan.parts.map((p) => p.order)).toEqual([10, 22])
    expect(failed.text).toContain('Your answer didn’t reach the hive: Could not reach the hive. Check the connection and try again.')
    expect(failed.button('Go ahead').getAttribute('disabled')).toBeNull()
    const gone = await mount(look, { ...ASKED, state: 'gone' })
    expect(gone.plan.parts.map((p) => p.order)).toEqual([23])
    expect(gone.text).toBe('It isn’t waiting for your answer any more.')
    expect(gone.plan.missing).toEqual([])
  })

  it('every part of the screen can be reached, and the guards stay clean', () => {
    expect([...seen].sort((a, b) => a - b)).toEqual(space.orders('ask-go-ahead'))
    expect(Object.values(space.guards()).flat()).toEqual([])
  })
})
