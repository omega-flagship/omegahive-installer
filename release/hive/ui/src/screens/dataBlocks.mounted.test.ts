// @vitest-environment node
// Purpose: tests, on real ReactDOM (the MiniDOM), of what a person does with the figure and chart blocks: Enter in a field sends the form's action (never a composing Enter, never while held), an editor's field takes the focus, a chart column shows its tooltip, a bar row its detail. INVENTED DATA only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, reactProps, type MiniNode } from '../ui/miniDom.testkit'
import { Screen, type ScreenHost } from './Screen'
import { ScreensSpace, SCREEN_SOURCES } from './screenSpace'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const space = ScreensSpace.open([...SCREEN_SOURCES, ['ledger', `
(Screen ledger "Ledger")
(Part ledger 10 fields ((submit save) (items ((field number "Limit in dollars" ledger.draft ((least 0) (focus yes) (waits ledger.saving)))))))
(Part ledger 20 chart ((source days) (series rows) (axis axis) (label "Picked each day")))
(Part ledger 30 bars ((source trees)))
`]])
const DATA = {
  'ledger.draft': '12.50',
  days: [{ id: 'd1', x: 'Mon', at: 'Monday', total: 30, total_words: '30 apples', aria: 'Mon: 30 apples', parts: [{ key: 'north', n: 10, words: '10 north' }, { key: 'south', n: 20, words: '20 south' }] }],
  rows: [{ key: 'north', label: 'North row', color: '#3987e5' }, { key: 'south', label: 'South row', color: '#d95926' }],
  axis: { max: 40, ticks: [{ n: 0, words: '0' }] },
  trees: [{ id: 't1', label: 'Old pippin', value: '80', detail: '3 ladders · 2 pickers', parts: [{ key: 'ripe', n: 80, color: '#199e70' }] }],
}

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

const mount = async (host: ScreenHost) => act(async () => root.render(createElement(Screen, { plan: space.compose('ledger', 'classic'), host })))
const enter = (over: Record<string, unknown> = {}) => ({ key: 'Enter', preventDefault: () => undefined, nativeEvent: {}, target: null, ...over })

describe('figure and chart blocks, mounted', () => {
  it('Enter in a field sends the form’s action, never an input method’s confirming Enter or while the field waits; the editor’s field takes the focus', async () => {
    const got: string[] = []
    await mount({ data: DATA, onAction: (a) => got.push(a) })
    const input = container.findAll((n) => n.tagName === 'INPUT')[0]
    expect(reactProps(input).autoFocus).toBe(true)
    const keyDown = reactProps(input).onKeyDown as (e: unknown) => void
    await act(async () => keyDown(enter({ isComposing: true })))
    expect(got).toEqual([])
    await act(async () => keyDown(enter({ key: 'a' })))
    expect(got).toEqual([])
    await act(async () => keyDown(enter()))
    expect(got).toEqual(['save'])
    await mount({ data: { ...DATA, 'ledger.saving': true }, onAction: (a) => got.push(a) })
    const held = container.findAll((n) => n.tagName === 'INPUT')[0]
    await act(async () => (reactProps(held).onKeyDown as (e: unknown) => void)(enter()))
    expect(got).toEqual(['save'])
  })

  it('a chart column shows its heading, total and each series’ part, largest first, while hovered or focused; a bar row its detail', async () => {
    await mount({ data: DATA })
    expect(container.textContent).not.toContain('Monday')
    const band = container.findAll((n) => n.tagName === 'RECT' && n.getAttribute?.('aria-label') === 'Mon: 30 apples')[0]
    await act(async () => (reactProps(band).onFocus as () => void)())
    expect(container.textContent).toContain('Monday30 apples20 southSouth row10 northNorth row')
    await act(async () => (reactProps(band).onBlur as () => void)())
    const row = container.findAll((n) => n.tagName === 'LI' && n.getAttribute?.('tabindex') === '0')[0]
    expect(container.textContent).not.toContain('3 ladders')
    await act(async () => (reactProps(row).onFocus as () => void)())
    expect(container.textContent).toContain('3 ladders · 2 pickers')
  })
})
