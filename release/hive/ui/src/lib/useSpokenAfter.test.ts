import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument } from '../ui/miniDom.testkit'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * The "N notices waiting." live words of the rest screens (useSpokenAfter) MOUNTED with fake timers. Classic, Construct,
 * Professional and Still each cleared these words with setState inside an effect; the hook keeps their timing and does
 * the clear while rendering.
 */

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  g.window = { document: doc, addEventListener: () => undefined, removeEventListener: () => undefined, HTMLIFrameElement: class {}, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: number) => clearTimeout(t) }
  g.HTMLIFrameElement = (g.window as { HTMLIFrameElement: unknown }).HTMLIFrameElement
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})
beforeEach(() => { vi.useFakeTimers() })
const unmounts: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const u of unmounts.splice(0)) await u()
  vi.useRealTimers()
})

async function mount(text: string | null) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSpokenAfter } = await import('./useSpokenAfter')
  const Live = ({ text }: { text: string | null }) => createElement('p', { 'aria-live': 'polite' }, useSpokenAfter(text))
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  const render = async (t: string | null) => act(async () => root.render(createElement(Live, { text: t })))
  await render(text)
  unmounts.push(async () => act(async () => root.unmount()))
  return {
    render,
    said: () => container.textContent,
    wait: async (ms: number) => act(async () => { vi.advanceTimersByTime(ms) }),
  }
}

describe('words said a moment after they settle', () => {
  it('a text is said after a second, not before', async () => {
    const m = await mount('2 notices waiting.')
    expect(m.said()).toBe('')
    await m.wait(999)
    expect(m.said()).toBe('')
    await m.wait(1)
    expect(m.said()).toBe('2 notices waiting.')
  })

  it('a new count keeps the words already said until it settles; a burst is said once', async () => {
    const m = await mount('2 notices waiting.')
    await m.wait(1000)
    await m.render('3 notices waiting.')
    await m.wait(500)
    await m.render('4 notices waiting.')
    expect(m.said()).toBe('2 notices waiting.')
    await m.wait(999)
    expect(m.said()).toBe('2 notices waiting.')
    await m.wait(1)
    expect(m.said()).toBe('4 notices waiting.')
  })

  it('nothing to say clears the words at once; the same words later are said fresh, after the delay', async () => {
    const m = await mount('2 notices waiting.')
    await m.wait(1000)
    await m.render(null)
    expect(m.said()).toBe('')
    await m.render('2 notices waiting.')
    expect(m.said()).toBe('')
    await m.wait(1000)
    expect(m.said()).toBe('2 notices waiting.')
  })
})

describe('the four rest screens use it', () => {
  for (const look of ['classic', 'construct', 'professional', 'still']) {
    it(`${look}: the words come from useSpokenAfter, with no setState in an effect for them`, () => {
      const src = fs.readFileSync(new URL(`../experiences/${look}/phases.tsx`, import.meta.url), 'utf8')
      expect(src).toMatch(/= useSpokenAfter\(phase === 'rest' && waiting > 0 \? `/)
      expect(src).not.toMatch(/setSpoken(Waiting)?\(/)
    })
  }
})
