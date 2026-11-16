import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument } from '../ui/miniDom.testkit'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * The Ask's "waking" line (useAskField) MOUNTED through useShownAfter with fake timers: a wake reads as preparing for its
 * first 400 ms, then as waking; a new wake starts over, and a finished one is not waking. It used to be set with
 * setState inside an effect.
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
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T12:00:00Z')) })
const unmounts: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const u of unmounts.splice(0)) await u()
  vi.useRealTimers()
})

async function mount(since: number | null) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useShownAfter } = await import('./useShownAfter')
  const Wake = ({ since }: { since: number | null }) => createElement('p', null, useShownAfter(since, 400) ? 'waking' : 'preparing')
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  const render = async (s: number | null) => act(async () => root.render(createElement(Wake, { since: s })))
  await render(since)
  unmounts.push(async () => act(async () => root.unmount()))
  return { render, text: () => container.textContent, wait: async (ms: number) => act(async () => { vi.advanceTimersByTime(ms) }) }
}

describe('waking is shown after 400 ms of a wake', () => {
  it('preparing first, waking at 400 ms; a new wake starts over; none is not waking', async () => {
    const m = await mount(Date.now())
    expect(m.text()).toBe('preparing')
    await m.wait(399)
    expect(m.text()).toBe('preparing')
    await m.wait(1)
    expect(m.text()).toBe('waking')
    await m.render(Date.now())
    expect(m.text()).toBe('preparing')
    await m.wait(400)
    expect(m.text()).toBe('waking')
    await m.render(null)
    expect(m.text()).toBe('preparing')
  })

  it('a wake that started long ago is waking on the next tick', async () => {
    const m = await mount(Date.now() - 5000)
    await m.wait(0)
    expect(m.text()).toBe('waking')
  })

  it('the Ask field uses it', () => {
    const src = fs.readFileSync(new URL('../features/ask/useAskField.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/const wakeVisible = useShownAfter\(wake\?\.phase === 'waking' \? wake\.since : null, 400\)/)
    expect(src).not.toMatch(/setWakeClock/)
  })
})
