import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import { MiniDocument, type MiniNode } from '../../ui/miniDom.testkit'
import type { Ledger } from './api'

// Real React DOM mount/effects against the repo's controlled DOM. No layout/focus or browser-CSS claim.
const doc = new MiniDocument()
const win = Object.assign(new EventTarget(), {
  document: doc, location: { hash: '#/', pathname: '/', search: '' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  HTMLIFrameElement: class {},
})
doc.defaultView = win
let Bar: typeof import('./DirectingStudio')['StudioLiveBar']
let live: typeof import('./store')['useStudioLive']
let createRoot: typeof import('react-dom/client')['createRoot']
const roots: import('react-dom/client').Root[] = []
const ledger = (): Ledger => ({
  session_id: 'ss_invented', stream_id: 'stream_invented', state: 'active', reason: null,
  ask_turn_id: 'turn_invented', goal_id: 'goal_invented', proposal_artifact_id: 'proposal_invented',
  maker_id: 'maker_invented', swarm_id: 'swarm_invented', program_id: 'omegadesign', scene_id: null,
  payer: null, model: null, steps: [], directions: [], piece: null, piece_state: null, piece_source: null, mount_epoch: null,
  budget: { cap: 1, spent: 0, held: 0, unknown: 0, step_cap: 0.25, step_spent: 0, step_seconds: 0, monthly: [] },
  stop: { state: 'none', fenced_at: null, in_flight: 0, unknown_usd: 0, cancel_ack: null, maker_released: null,
    stop_failed: false, release_stale: false, message: null, finish_stopping: false },
})
beforeAll(async () => {
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc)
  vi.stubGlobal('HTMLIFrameElement', win.HTMLIFrameElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ StudioLiveBar: Bar } = await import('./DirectingStudio'))
  ;({ useStudioLive: live } = await import('./store'))
  ;({ createRoot } = await import('react-dom/client'))
})
beforeEach(() => { win.location.hash = '#/'; live.setState({ ledger: ledger(), local: 'receiving' }) })
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()) })
  live.setState({ ledger: null })
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBeNull()
})
afterAll(() => vi.unstubAllGlobals())
const nodes = (n: MiniNode): MiniNode[] => [n, ...n.childNodes.flatMap(nodes)]
function bars(ids: string[], program = false) {
  return createElement(Fragment, null,
    createElement(Bar, { key: 'global' }),
    ...ids.map(id => createElement('div', { key: id, className: 'cv-top-chrome' }, createElement(Bar, { inline: true, canvas: true }))),
    program ? createElement(Bar, { key: 'program', inline: true }) : null)
}
async function mounted(ids: string[], program = false) {
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as Element); roots.push(root)
  await act(async () => root.render(bars(ids, program)))
  return { root, container }
}

it('owns the fallback guard only while the actual Canvas inline session bar is mounted', async () => {
  const { root, container } = await mounted([])
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBeNull()
  expect(nodes(container).filter(n => n.getAttribute('data-studio-bar') !== null)).toHaveLength(1)
  await act(async () => root.render(bars(['canvas'])))
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBe('')
  const inline = nodes(container).find(n => n.getAttribute('data-inline') !== null)!
  expect(nodes(inline).filter(n => n.tagName === 'BUTTON').map(n => n.textContent)).toEqual(['Direct', 'Stop'])
  await act(async () => root.render(bars([])))
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBeNull()
  expect(nodes(container).filter(n => n.getAttribute('data-studio-bar') !== null)).toHaveLength(1)
})

it('keeps the guard when one of two actual Canvas owners unmounts, and clears it after the last', async () => {
  const { root } = await mounted(['first', 'second'])
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBe('')
  await act(async () => root.render(bars(['second'])))
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBe('')
  await act(async () => root.render(bars([])))
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBeNull()
})

it('does not suppress another look’s global bar for an ordinary program inline bar', async () => {
  await mounted([], true)
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBeNull()
})

it('withdraws the guard when the live session disappears even if Canvas chrome stays mounted', async () => {
  const { container } = await mounted(['canvas'])
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBe('')
  await act(async () => live.setState({ ledger: null }))
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBeNull()
  expect(nodes(container).filter(n => n.getAttribute('data-studio-bar') !== null)).toHaveLength(0)
  await act(async () => live.setState({ ledger: ledger() }))
  expect(doc.body.getAttribute('data-canvas-inline-bar')).toBe('')
})
