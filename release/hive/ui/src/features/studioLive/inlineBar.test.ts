import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment, StrictMode } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, MiniNode } from '../../ui/miniDom.testkit'
import type { Ledger } from './api'
import { StudioLiveBar } from './DirectingStudio'
import { acquirePageInlineBar } from './pageInlineBar'
import { useStudioLive } from './store'
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const css = fs.readFileSync(new URL('./studioLive.css', import.meta.url), 'utf8')

/**
 * Real React component/effects/cleanups and the real Zustand/router hooks, with
 * INVENTED ledger DATA and the existing bounded Node MiniDOM. No host requests,
 * browser launcher, hook mock, fake timers or CSS layout engine. Attribute/tree
 * assertions plus the standalone CSS selector contract cover the no-:has guard;
 * actual visibility, geometry and Safari remain fresh browser qualifications.
 */
const ledger: Ledger = {
  session_id: 'ss_inline_guard_fixture', stream_id: null, state: 'active', reason: null,
  ask_turn_id: 'at_inline_guard_fixture', goal_id: 'g_inline_guard_fixture',
  proposal_artifact_id: 'ar_inline_guard_fixture', maker_id: 'a_inline_guard_fixture',
  swarm_id: 's_inline_guard_fixture', program_id: 'omegadesign', scene_id: null,
  payer: 'invented', model: 'invented', steps: [], directions: [],
  budget: { cap: 1, spent: 0, held: 0, unknown: 0, step_cap: 0.1,
    step_spent: 0, step_seconds: 60, monthly: [] },
  stop: { state: 'none', fenced_at: null, in_flight: 0, unknown_usd: 0,
    cancel_ack: null, maker_released: false, stop_failed: false,
    release_stale: false, message: null, finish_stopping: false },
  piece: null, piece_state: null, piece_source: null, mount_epoch: null,
}
type LiveState = ReturnType<typeof useStudioLive.getState>
let saved: LiveState
let doc: MiniDocument
let container: MiniNode
let root: Root | null
let location: { hash: string; pathname: string; search: string }
let listeners: Map<string, Set<() => void>>

beforeEach(async () => {
  saved = useStudioLive.getState()
  useStudioLive.setState({ ledger, local: 'receiving', moneyDrift: false })
  doc = new MiniDocument()
  location = { hash: '#/', pathname: '/', search: '' }
  listeners = new Map()
  const win = {
    document: doc, location,
    HTMLElement: MiniNode, HTMLIFrameElement: class {}, Node: MiniNode,
    navigator: { userAgent: 'bounded-mini-dom-fixture' },
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn) },
  }
  doc.defaultView = win
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('HTMLElement', MiniNode)
  vi.stubGlobal('HTMLIFrameElement', win.HTMLIFrameElement)
  vi.stubGlobal('Node', MiniNode)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = doc.body.appendChild(doc.createElement('div'))
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as HTMLElement)
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  useStudioLive.setState(saved, true)
  vi.unstubAllGlobals()
})

async function render(inlineRows = 0, strict = false) {
  const bars = createElement(Fragment, null,
    createElement(StudioLiveBar, { key: 'global' }),
    ...Array.from({ length: inlineRows }, (_, i) => createElement('div',
      { key: `canvas-${i}`, className: 'cv-top-chrome' },
      createElement(StudioLiveBar, { inline: true, canvas: true }))),
  )
  await act(async () => { root!.render(strict ? createElement(StrictMode, null, bars) : bars) })
}
const bars = () => container.findAll((node) =>
  (node.getAttribute('class') ?? '').split(/\s+/).includes('sl-bar'))
const globalBars = () => bars().filter((node) => !node.hasAttribute('data-inline'))
const inlineBars = () => bars().filter((node) => node.hasAttribute('data-inline'))
async function route(hash: string) {
  await act(async () => {
    location.hash = hash
    for (const notify of [...(listeners.get('hashchange') ?? [])]) notify()
  })
}

describe('Canvas inline bar body guard, actual React lifecycle (no :has dependency)', () => {
  it('leaves the global bar rendered and its body hide selector inactive without an inline row', async () => {
    await render()
    expect(globalBars()).toHaveLength(1)
    expect(inlineBars()).toHaveLength(0)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(false)
    // A separate rule parses without :has; no unsupported selector is grouped
    // with the attribute fallback. MiniDOM does not pretend to compute layout.
    expect(css).toContain('body[data-canvas-inline-bar] .sl-bar:not([data-inline]) { display: none; }')
    expect(css).not.toContain(':has(')
  })

  it('sets the marker after the actual Canvas row mounts and clears it when that row unmounts', async () => {
    await render(1)
    expect(inlineBars()).toHaveLength(1)
    expect(doc.body.getAttribute('data-canvas-inline-bar')).toBe('')
    await render()
    expect(inlineBars()).toHaveLength(0)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(false)
    expect(globalBars()).toHaveLength(1)
  })

  it('never claims an inline row for an absent ledger and cleans up when its rendered row disappears', async () => {
    await act(async () => { useStudioLive.setState({ ledger: null }) })
    await render(1)
    expect(bars()).toHaveLength(0)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(false)
    await act(async () => { useStudioLive.setState({ ledger }) })
    expect(inlineBars()).toHaveLength(1)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(true)
    await act(async () => { useStudioLive.setState({ ledger: null }) })
    expect(bars()).toHaveLength(0)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(false)
  })

  it('clears Canvas ownership on route change and never assigns it to a program inline bar', async () => {
    await render(1)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(true)
    await route('#/program/omegadesign')
    expect(inlineBars()).toHaveLength(1)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(false)
    await render()
    await route('#/')
    expect(globalBars()).toHaveLength(1)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(false)
  })

  it('retains another mounted Canvas owner and clears the last one, including StrictMode cleanup', async () => {
    await render(2, true)
    expect(inlineBars()).toHaveLength(2)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(true)
    await render(1, true)
    expect(inlineBars()).toHaveLength(1)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(true)
    await act(async () => { root!.unmount() })
    root = null
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(false)
  })
})

/**
 * Real StudioLiveBar/React layout effects, not a CSS-string mirror.
 * MiniDOM proves ownership/fallback only: it has no layout or hit-test engine.
 * Mobile Close, Stop and Direct require the separate actual browser acceptance.
 */
async function renderPageRows(readiness: boolean[], strict = false) {
  const rows = createElement(Fragment, null,
    createElement(StudioLiveBar, { key: 'global' }),
    ...readiness.map((ready, i) => createElement('section',
      { key: 'page-' + i, className: 'xc-page' },
      createElement(StudioLiveBar, { inline: true, pageOwned: true, inlineReady: ready }))),
  )
  await act(async () => { root!.render(strict ? createElement(StrictMode, null, rows) : rows) })
}
const registeredPageRows = () => inlineBars().filter((row) => row.hasAttribute('data-page-inline-registered'))

describe('shared Page committed inline Stop ownership, actual React lifecycle', () => {
  it('registers an actual ready row before suppressing fallback', async () => {
    await route('#/lab')
    const original = doc.body.setAttribute.bind(doc.body)
    let suppressionWrites = 0
    const marker = vi.spyOn(doc.body, 'setAttribute').mockImplementation((name, value) => {
      if (name === 'data-page-inline-bar') {
        suppressionWrites++
        expect(registeredPageRows()).toHaveLength(1)
        expect(doc.body.contains(registeredPageRows()[0])).toBe(true)
      }
      original(name, value)
    })
    try {
      await renderPageRows([false])
      expect(inlineBars()).toHaveLength(1) // row already reserves flow height
      expect(inlineBars()[0].style.visibility).toBe('hidden')
      expect(inlineBars()[0].getAttribute('aria-hidden')).toBe('true')
      expect(inlineBars()[0].hasAttribute('inert')).toBe(true)
      expect(registeredPageRows()).toHaveLength(0)
      expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
      expect(globalBars()).toHaveLength(1)
      await renderPageRows([true])
      expect(suppressionWrites).toBe(1)
      expect(registeredPageRows()).toHaveLength(1)
      expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(true)
    } finally { marker.mockRestore() }
  })

  it('restores fallback before an outgoing row fades, and acquires again only when ready', async () => {
    await route('#/lab')
    await renderPageRows([true])
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(true)
    await renderPageRows([false])
    expect(inlineBars()).toHaveLength(1)
    expect(registeredPageRows()).toHaveLength(0)
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
    expect(globalBars()).toHaveLength(1)
    await renderPageRows([true])
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(true)
    await renderPageRows([])
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
    expect(globalBars()).toHaveLength(1)
  })

  it('never owns suppression without a ledger and releases it when the actual row disappears', async () => {
    await route('#/lab')
    await act(async () => { useStudioLive.setState({ ledger: null }) })
    await renderPageRows([true])
    expect(bars()).toHaveLength(0)
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
    await act(async () => { useStudioLive.setState({ ledger }) })
    expect(registeredPageRows()).toHaveLength(1)
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(true)
    await act(async () => { useStudioLive.setState({ ledger: null }) })
    expect(bars()).toHaveLength(0)
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
  })

  it('retains another Page owner through StrictMode cleanup and releases the last owner', async () => {
    await route('#/lab')
    await renderPageRows([true, true], true)
    expect(registeredPageRows()).toHaveLength(2)
    await renderPageRows([true], true)
    expect(registeredPageRows()).toHaveLength(1)
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(true)
    await act(async () => { root!.unmount() })
    root = null
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
  })

  it('never labels an outgoing shared Page as Canvas Home ownership', async () => {
    await route('#/lab')
    await renderPageRows([true])
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(true)
    await route('#/')
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
    expect(doc.body.hasAttribute('data-canvas-inline-bar')).toBe(false)
    expect(inlineBars()).toHaveLength(0)
    expect(globalBars()).toHaveLength(1)
  })

  it('rejects detached rows and reference-counts idempotent leases on an attached row', () => {
    const row = doc.createElement('div')
    row.setAttribute('data-studio-bar', '')
    row.setAttribute('data-inline', '')
    row.setAttribute('data-inline-owner', 'page')
    expect(acquirePageInlineBar(doc.body as unknown as HTMLElement, row as unknown as HTMLElement)).toBeUndefined()
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
    doc.body.appendChild(row)
    expect(acquirePageInlineBar(doc.body as unknown as HTMLElement, row as unknown as HTMLElement)).toBeUndefined()
    row.setAttribute('data-inline-ready', '')
    const first = acquirePageInlineBar(doc.body as unknown as HTMLElement, row as unknown as HTMLElement)!
    const second = acquirePageInlineBar(doc.body as unknown as HTMLElement, row as unknown as HTMLElement)!
    first()
    first()
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(true)
    expect(row.hasAttribute('data-page-inline-registered')).toBe(true)
    second()
    expect(row.hasAttribute('data-page-inline-registered')).toBe(false)
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
    doc.body.removeChild(row)
  })
})
