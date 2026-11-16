import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument } from '../../ui/miniDom.testkit'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * Two of Still's states that were set with setState inside an effect, MOUNTED: its clock (useNow) read again at once
 * when the page is shown again, and its Ask field's "focused" cleared when the field leaves the paper (its input
 * unmounts, which fires no blur). Both now set state from a timer or while rendering.
 */

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument & { hidden?: boolean }
const visibility = new Set<() => void>()
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument() as MiniDocument & { hidden?: boolean }
  doc.hidden = false
  const add = doc.addEventListener.bind(doc), remove = doc.removeEventListener.bind(doc)
  doc.addEventListener = (t: string, f: (e: unknown) => void) => { if (t === 'visibilitychange') visibility.add(f as () => void); add(t, f) }
  doc.removeEventListener = (t: string, f: (e: unknown) => void) => { if (t === 'visibilitychange') visibility.delete(f as () => void); remove(t, f) }
  g.window = { document: doc, location: { hash: '' }, addEventListener: () => undefined, removeEventListener: () => undefined, HTMLIFrameElement: class {} }
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

async function mount(el: ReturnType<typeof createElement>) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => root.render(el))
  unmounts.push(async () => act(async () => root.unmount()))
  return { act, container, render: async (next: ReturnType<typeof createElement>) => act(async () => root.render(next)) }
}

describe("Still's clock", () => {
  it('shown again after a while: the time is read again at once, not a tick later', async () => {
    const { useNow } = await import('./shared')
    const Clock = () => createElement('p', null, new Date(useNow(20_000)).toISOString())
    const m = await mount(createElement(Clock))
    await m.act(async () => { vi.advanceTimersByTime(0) })
    expect(m.container.textContent).toBe('2026-11-10T12:00:00.000Z')
    doc.hidden = true
    await m.act(async () => { for (const f of [...visibility]) f() })
    vi.setSystemTime(new Date('2026-11-10T12:05:00Z'))
    doc.hidden = false
    await m.act(async () => { for (const f of [...visibility]) f() })
    await m.act(async () => { vi.advanceTimersByTime(0) })
    expect(m.container.textContent).toBe('2026-11-10T12:05:00.000Z')
  })
})

describe('a field that exists only on the paper', () => {
  it('leaving the paper clears focused, so coming back is not taken as focused', async () => {
    const { useFocusedWhile } = await import('../../lib/useFocusedWhile')
    let set: (f: boolean) => void = () => undefined
    const Field = ({ present }: { present: boolean }) => {
      const [focused, setFocused] = useFocusedWhile(present)
      set = setFocused
      return createElement('p', null, focused ? 'focused' : 'not focused')
    }
    const m = await mount(createElement(Field, { present: true }))
    await m.act(async () => set(true))
    expect(m.container.textContent).toBe('focused')
    await m.render(createElement(Field, { present: false }))
    expect(m.container.textContent).toBe('not focused')
    await m.render(createElement(Field, { present: true }))
    expect(m.container.textContent).toBe('not focused')
  })

  it("Still's Ask uses it, and its effect only stops the voice", () => {
    const src = fs.readFileSync(new URL('./Ask.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const \[focused, setFocused\] = useFocusedWhile\(onPaper\)/)
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!onPaper\) stopVoice\(\)\s*\}, \[onPaper\]\)/)
    expect(src).toMatch(/const stopVoice = useEffectEvent\(\(\) => v\.stop\(\)\)/)
  })
})
