import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument } from '../ui/miniDom.testkit'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * The Ask's own mark (useAskMark) MOUNTED with fake timers: an answer frame makes it speak for 700 ms, then it is idle
 * again. It used to read the clock while rendering to decide that; it now speaks until its timer clears the time.
 */

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']) saved[k] = g[k]
  doc = new MiniDocument()
  g.window = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined,
    setTimeout: (f: () => void, ms?: number) => setTimeout(f, ms), clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t) }
  g.HTMLIFrameElement = (g.window as { HTMLIFrameElement: unknown }).HTMLIFrameElement
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
  // the brand rules MeTTa evaluated (brand/rules.json `ask`), reduced to one look: an answer is shown as speaking
  g.fetch = async () => ({ json: async () => ({ ask: { shows: { brand: { answering: 'speaking' } }, behaves: { brand: {} } } }) })
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
const unmounts: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const u of unmounts.splice(0)) await u()
  vi.useRealTimers()
})

describe("the Ask's mark speaks for a moment after an answer", () => {
  it('speaking on the answer frame, idle 700 ms later', async () => {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useAskMark } = await import('./askMark')
    const { useAskStore } = await import('../store/ask')
    const Mark = () => createElement('p', null, useAskMark('brand', false).presence)
    const container = doc.body.appendChild(doc.createElement('div'))
    const root = createRoot(container as unknown as HTMLElement)
    await act(async () => root.render(createElement(Mark)))
    unmounts.push(async () => act(async () => root.unmount()))
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() })   // the rules load
    expect(container.textContent).toBe('idle')
    await act(async () => {
      useAskStore.setState({ open: 'op_invented', turns: { op_invented: { op: 'op_invented', events: [{ phase: 'answer', seq: 1 }], outcomes: {} } } } as never)
    })
    expect(container.textContent).toBe('speaking')
    await act(async () => { vi.advanceTimersByTime(699) })
    expect(container.textContent).toBe('speaking')
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(container.textContent).toBe('idle')
  })

  it('reads no clock while rendering', () => {
    const src = fs.readFileSync(new URL('./askMark.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/const speaking = speakingUntil > 0\n/)
  })
})
