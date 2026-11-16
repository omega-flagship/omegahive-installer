import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * A room's turn limit stepper (MessagesPage TurnLimit) MOUNTED. Its number follows each step at once, and a new saved
 * value from the hive replaces it. It used to copy the saved value in with setState inside an effect (a wasted render
 * and a lint error); it now adjusts while rendering.
 */

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  g.window = { document: doc, addEventListener: () => undefined, removeEventListener: () => undefined, HTMLIFrameElement: class {} }
  g.HTMLIFrameElement = (g.window as { HTMLIFrameElement: unknown }).HTMLIFrameElement
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})
const unmounts: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const u of unmounts.splice(0)) await u()
})

async function mount(value: number | null) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { TurnLimit } = await import('./MessagesPage')
  const sent: (number | null)[] = []
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  const render = async (v: number | null) =>
    act(async () => root.render(createElement(TurnLimit, { value: v, onChange: (n: number | null) => void sent.push(n) })))
  await render(value)
  unmounts.push(async () => act(async () => root.unmount()))
  const button = (label: string) => container.findAll((n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === label)[0] as MiniNode
  return {
    act,
    sent,
    render,
    shown: () => container.findAll((n) => n.getAttribute('aria-live') === 'polite')[0]?.textContent,
    more: () => button('More replies in a row'),
    limit: () => button('Limit replies in a row'),
  }
}

describe('the turn limit stepper', () => {
  it('is off unless chosen (omega-flagship #75): the switch starts it at 3, and turning it off saves no limit', async () => {
    const m = await mount(null)
    expect(m.shown()).toBeUndefined()
    expect(m.limit().getAttribute('aria-checked')).toBe('false')
    await m.act(async () => press(m.limit()))
    expect(m.shown()).toBe('3')
    await m.act(async () => press(m.limit()))
    expect(m.shown()).toBeUndefined()
    expect(m.sent).toEqual([3, null])
  })

  it('shows a step at once and saves it', async () => {
    const m = await mount(2)
    expect(m.shown()).toBe('2')
    await m.act(async () => press(m.more()))
    expect(m.shown()).toBe('3')
    expect(m.sent).toEqual([3])
  })

  it('a new saved value from the hive replaces the shown one', async () => {
    const m = await mount(2)
    await m.render(5)
    expect(m.shown()).toBe('5')
    await m.act(async () => press(m.more()))
    expect(m.shown()).toBe('6')
    // the same saved value again (the step not saved yet) leaves the step shown
    await m.render(5)
    expect(m.shown()).toBe('6')
    await m.render(0)
    expect(m.shown()).toBe('0')
  })

  it('no setState in an effect', () => {
    const src = fs.readFileSync(new URL('./MessagesPage.tsx', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('export function TurnLimit('), src.indexOf('export function RoomSettings('))
    expect(body).not.toMatch(/useEffect/)
    expect(body).toMatch(/if \(value !== saved\) \{\s*setSaved\(value\)\s*setN\(value\)/)
  })
})
