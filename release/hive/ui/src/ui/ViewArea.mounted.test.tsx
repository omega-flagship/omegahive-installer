// @vitest-environment node
// Purpose: a page window's content area gives the views inside it the width it measures, so a view that asks whether to
// lay out for a desktop answers by that room, not the screen: the half-size Ask leaves a page about 600 px of a 1440 px
// screen, where the Tasks board's five desktop columns wrapped a word per line (a tester's report, 20 Nov).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { MiniDocument, type MiniNode } from './miniDom.testkit'
import { useIsDesktop, viewIsDesktop } from '../lib/hooks'

const g = globalThis as unknown as Record<string, unknown>
const kept: Record<string, unknown> = {}
let report: ((entries: { contentRect: { width: number } }[]) => void) | null = null
let screenWide = true

beforeEach(() => {
  for (const key of ['window', 'document', 'ResizeObserver', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) kept[key] = g[key]
  const doc = new MiniDocument()
  // React's commit asks the window for HTMLIFrameElement (getActiveElementDeep), as in ActionForm.mounted.test.tsx
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined,
    matchMedia: () => ({ matches: screenWide, addEventListener: () => undefined, removeEventListener: () => undefined }) }
  ;(doc as unknown as { defaultView: unknown }).defaultView = win
  g.window = win
  g.HTMLIFrameElement = win.HTMLIFrameElement
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.ResizeObserver = class { constructor(cb: typeof report) { report = cb } observe() {} disconnect() { report = null } }
})
afterEach(() => {
  for (const [k, v] of Object.entries(kept)) g[k] = v
  report = null
  screenWide = true
})

function Probe() {
  return createElement('span', null, useIsDesktop() ? 'desktop' : 'narrow')
}

async function mount() {
  const { ViewArea } = await import('./ViewArea')
  const { createRoot } = await import('react-dom/client')
  const doc = g.document as MiniDocument
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const root = createRoot(container as unknown as Element)
  await act(async () => root.render(createElement(ViewArea, { className: 'area', children: createElement(Probe) })))
  const text = () => (container as MiniNode).textContent
  return { root, text }
}

describe('a page window’s views lay out for the width it gives them', () => {
  it('measures the window before its first paint, so a narrow one never draws a frame laid out for a desktop', async () => {
    // the layout pass reads the window's width; no ResizeObserver report has come yet (Jon's review of #564)
    const proto = Object.getPrototypeOf((g.document as MiniDocument).createElement('div')) as object
    Object.defineProperty(proto, 'clientWidth', { get: () => 614, configurable: true })
    try {
      const { root, text } = await mount()
      expect(text()).toBe('narrow')
      await act(async () => root.unmount())
    } finally {
      delete (proto as { clientWidth?: number }).clientWidth
    }
  })

  it('reads the screen until measured, then the window: narrow beside the half Ask, a desktop when the window is wide', async () => {
    const { root, text } = await mount()
    expect(text()).toBe('desktop')   // the screen's answer until the first report
    await act(async () => report!([{ contentRect: { width: 614 } }]))
    expect(text()).toBe('narrow')
    await act(async () => report!([{ contentRect: { width: 1344 } }]))
    expect(text()).toBe('desktop')
    await act(async () => root.unmount())
    expect(report).toBeNull()        // the observer went with the page
  })

  it('outside a page window a view keeps the screen’s answer', () => {
    expect(viewIsDesktop(true, null)).toBe(true)
    expect(viewIsDesktop(false, null)).toBe(false)
    expect(viewIsDesktop(false, 900)).toBe(true)
    expect(viewIsDesktop(true, 767)).toBe(false)
  })

  it('the Tasks board’s desktop columns keep a readable width and scroll sideways when the window holds fewer', async () => {
    const { COLUMNS_WIDE } = await import('../features/goals/GoalsBoard')
    expect(COLUMNS_WIDE).toContain('auto-cols-[minmax(13rem,1fr)]')
    expect(COLUMNS_WIDE).toContain('grid-flow-col')
    expect(COLUMNS_WIDE).toContain('overflow-x-auto')
  })
})
