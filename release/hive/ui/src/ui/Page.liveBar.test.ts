import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, MiniNode } from './miniDom.testkit'
import type { Ledger } from '../features/studioLive/api'
import { StudioLiveBar } from '../features/studioLive/DirectingStudio'
import { useStudioLive } from '../features/studioLive/store'
import { Page } from './Page'

/**
 * The production Page, StudioLiveBar, hooks and React layout effects are mounted.
 * Only the motion host is controlled so its real Page callbacks can be driven.
 * No fake React dispatcher, CSS layout, native pointer or browser claim.
 */
const motion = vi.hoisted(() => ({
  callbacks: null as null | { start: (definition: unknown) => void; complete: (definition: unknown) => void },
}))
vi.mock('framer-motion', async (orig) => {
  const real = await orig<typeof import('framer-motion')>()
  const React = await import('react')
  const Section = (props: Record<string, unknown>) => {
    const { initial, animate, exit, transition, onAnimationStart, onAnimationComplete, ...dom } = props
    motion.callbacks = {
      start: onAnimationStart as (definition: unknown) => void,
      complete: onAnimationComplete as (definition: unknown) => void,
    }
    return React.createElement('section', dom as import('react').HTMLAttributes<HTMLElement>)
  }
  return { ...real, m: new Proxy(real.m, {
    get: (target, key, receiver) => key === 'section' ? Section : Reflect.get(target, key, receiver),
  }) }
})

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
let reduced = false

beforeEach(async () => {
  saved = useStudioLive.getState()
  useStudioLive.setState({ ledger, local: 'receiving', moneyDrift: false })
  doc = new MiniDocument()
  reduced = false
  motion.callbacks = null
  const win = {
    document: doc, location: { hash: '#/lab', pathname: '/', search: '' },
    HTMLElement: MiniNode, HTMLIFrameElement: class {}, Node: MiniNode,
    navigator: { userAgent: 'bounded-mini-dom-page-motion-fixture' },
    addEventListener: () => undefined, removeEventListener: () => undefined,
    matchMedia: () => ({ matches: reduced, addEventListener: () => undefined, removeEventListener: () => undefined }),
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

const rows = () => container.findAll((n) => n.getAttribute('data-inline-owner') === 'page')
const buttons = (row: MiniNode) => row.findAll((n) => n.tagName === 'BUTTON' && ['Direct', 'Stop'].includes(n.textContent))
function expectDormant() {
  const row = rows()[0]
  expect(rows()).toHaveLength(1) // still reserves its flow height
  expect(row.style.visibility).toBe('hidden')
  expect(row.style.pointerEvents).toBe('none')
  expect(row.getAttribute('aria-hidden')).toBe('true')
  expect(row.hasAttribute('inert')).toBe(true)
  expect(row.hasAttribute('data-page-inline-registered')).toBe(false)
  expect(buttons(row)).toHaveLength(2)
  expect(buttons(row).every((n) => n.hasAttribute('disabled'))).toBe(true)
  expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
}
function expectRegistered() {
  const row = rows()[0]
  expect(row.hasAttribute('data-page-inline-registered')).toBe(true)
  expect(row.hasAttribute('data-inline-ready')).toBe(true)
  expect(row.getAttribute('aria-hidden')).not.toBe('true')
  expect(row.hasAttribute('inert')).toBe(false)
  expect(row.style.visibility).not.toBe('hidden')
  expect(buttons(row).every((n) => !n.hasAttribute('disabled'))).toBe(true)
  expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(true)
}
async function mount(enter = true) {
  await act(async () => {
    root!.render(createElement(Fragment, null,
      createElement(StudioLiveBar),
      createElement(Page, { title: 'Lab', label: 'Lab', enter, children: null }),
    ))
  })
}
const incoming = { opacity: 1, y: 0, scale: 1 }
const outgoing = { opacity: 0, y: 16, transition: { duration: 0.18 } }
async function start(definition: unknown) { await act(async () => { motion.callbacks!.start(definition) }) }
async function complete(definition: unknown) { await act(async () => { motion.callbacks!.complete(definition) }) }

describe('actual Page motion wiring and one active Stop owner', () => {
  it('keeps entrance controls dormant until the actual Page completion callback registers the row', async () => {
    await mount()
    expectDormant()
    await start(incoming)
    expectDormant()
    await complete(incoming)
    expectRegistered()
  })
  it('makes the row inactive at exit start, even while the Page starts at opacity1, then releases on unmount', async () => {
    await mount()
    await start(incoming)
    await complete(incoming)
    expectRegistered()
    await start(outgoing)
    expectDormant()
    await complete(outgoing)
    expectDormant()
    await act(async () => { root!.unmount() })
    root = null
    expect(doc.body.hasAttribute('data-page-inline-bar')).toBe(false)
  })
  it('does not activate an interrupted entrance when its old completion arrives after exit start', async () => {
    await mount()
    await start(incoming)
    await start(outgoing)
    await complete(incoming)
    expectDormant()
    await complete(outgoing)
    expectDormant()
  })
  it('accepts immediate reduced-motion completion without a separate start callback', async () => {
    reduced = true
    await mount()
    expectDormant()
    await complete(incoming)
    expectRegistered()
  })
  it('registers an already-visible enter=false Page without depending on motion callbacks', async () => {
    await mount(false)
    expectRegistered()
  })
})
