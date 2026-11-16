// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- globals swapped for the mini DOM */
// Purpose: a mounted test of the usage region's one rule a static render cannot show, since it lives in an effect: while a view that covers the look's frame is open (a page, a mind's panel, Still's reading), that view draws the region and the look's frame draws none, and the frame's region comes back once the view closes. FrameUsage is stood in by a marker, so only the rule is under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, type MiniNode } from '../ui/miniDom.testkit'

vi.mock('./FrameUsage', () => ({ default: ({ className }: { className?: string }) => createElement('i', { 'data-region-box': className }) }))
import { UsageRegion } from './UsageRegion'

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
// the region's engine loads lazily: a few turns of the event loop let the stand-in's import settle
const flush = async () => { await act(async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) }) }
const render = async (el: ReactElement) => { await act(async () => root.render(el)); await flush() }
const drawn = () => host.findAll((n) => n.getAttribute('data-region-box') !== null).map((n) => n.getAttribute('data-region-box'))
/** A look's frame with its region, and a covering view over it while `open`. */
const screen = (open: boolean) => createElement(Fragment, null, createElement(UsageRegion, { className: 'frame' }), open && createElement(UsageRegion, { covering: true, className: 'page' }))

beforeEach(async () => {
  const g = globalThis as any
  saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, location: { search: '' } }
  doc.defaultView = win
  g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host as unknown as Element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.parentNode?.removeChild(host)
  for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v
})

describe('one usage region draws at a time', () => {
  it("the look's frame draws its region while nothing covers it", async () => {
    await render(screen(false))
    expect(drawn()).toEqual(['frame'])
  })

  it('a covering view draws its own region and the frame yields to it, and the frame draws again once it closes', async () => {
    await render(screen(true))
    expect(drawn()).toEqual(['page'])
    await render(screen(false))
    expect(drawn()).toEqual(['frame'])
  })
})
