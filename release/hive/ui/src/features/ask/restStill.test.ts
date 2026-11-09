import { createElement, useEffect } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MiniDocument, MiniNode } from '../../ui/miniDom.testkit'
import { useAskStill, useKeepClear, useOmegaRight, useOwnBoxVisible, useOwnReservation } from './askMeasure'
import { usePhase } from '../../shell/phase'
import { useLookReduced } from '../ink/lookReduced'
import { idleCheckRuns } from '../power/idleCheck'

/**
 * Cosmos weak-device gate (MacBook-Hive, 3 Nov): with no WebGL, at rest, the page still woke ~3.6 times a second.
 * Counted in the browser (the sim, 5 s at rest): the Ask's keep-clear poll (700 ms) and Ω poll (800 ms), the ink
 * layer's look poll (1 s) and RestScreen's idle check (5 s). At rest nothing moves, so none of them runs: each is
 * measured once on entering and leaving rest, and on resize. Counted here: the intervals each starts, awake and at rest.
 */
// readSab's probe leaves with remove(), which the mini DOM has no need for elsewhere
const proto = MiniNode.prototype as unknown as { remove?: () => void; removeChild(n: MiniNode): unknown }
proto.remove ??= function (this: MiniNode) { this.parentNode?.removeChild(this) }
const doc = new MiniDocument()
const glob = globalThis as unknown as Record<string, unknown>
const saved: Record<string, unknown> = {}
const started: number[] = []
const mutations = new Set<() => void>()
const resizes = new Set<() => void>()
let ownVisible = false
let listeners = 0
const handlers = new Map<string, Set<() => void>>()
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'getComputedStyle', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver']) saved[k] = glob[k]
  const win = {
    document: doc, location: { hash: '#/', search: '', pathname: '/' }, innerWidth: 1280, innerHeight: 800,
    addEventListener(type: string, f: () => void) { listeners++; (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(f) },
    removeEventListener(type: string, f: () => void) { listeners--; handlers.get(type)?.delete(f) },
    dispatchEvent() { return true },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setInterval: (f: () => void, ms: number) => { started.push(ms); return setInterval(f, ms) as unknown as number },
    clearInterval: (t: number) => clearInterval(t),
    HTMLIFrameElement: class {},
  }
  Object.assign(glob, { MutationObserver: class { constructor(private callback: () => void) {} observe() { mutations.add(this.callback) } disconnect() { mutations.delete(this.callback) } }, IntersectionObserver: class { observe() {} disconnect() {} } })
  glob.ResizeObserver = class { constructor(private callback: () => void) {} observe() { resizes.add(this.callback) } disconnect() { resizes.delete(this.callback) } }
  doc.defaultView = win as never
  Object.assign(glob, { window: win, document: doc, HTMLIFrameElement: win.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: () => ({ paddingBottom: '0px', visibility: 'visible', opacity: '1' }) })
})
afterAll(() => { for (const [k, v] of Object.entries(saved)) glob[k] = v })

function Probe({ still }: { still: boolean }) {
  useOmegaRight('cosmos|hive', still)
  useKeepClear(true, still)
  const visible = useOwnBoxVisible('.still-question', still)
  useEffect(() => { ownVisible = visible })
  useLookReduced()
  return null
}
const seen: { still: boolean | null } = { still: null }
function StillProbe({ route }: { route: string }) {
  const still = useAskStill(route)
  useEffect(() => { seen.still = still })
  return null
}

async function mount(still: boolean) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(doc.body.appendChild(doc.createElement('div')) as unknown as Element)
  await act(async () => root.render(createElement(Probe, { still })))
  return {
    rerender: (s: boolean) => act(async () => root.render(createElement(Probe, { still: s }))),
    unmount: () => act(async () => root.unmount()),
  }
}

describe('at rest nothing polls', () => {
  it('awake: the Ask polls its two measures; at rest: no interval at all, then they resume on waking', async () => {
    vi.useFakeTimers()
    started.length = 0
    const awake = await mount(false)
    expect(started.sort()).toEqual([700, 800])          // the ink layer never polls (it follows look changes)
    started.length = 0
    await awake.rerender(true)                               // the shell rests
    await vi.advanceTimersByTimeAsync(5000)
    expect(started).toEqual([])
    await awake.rerender(false)                              // waking measures again and polls again
    expect(started.sort()).toEqual([700, 800])
    await awake.unmount()
    vi.useRealTimers()
  })

  it('mounted at rest: nothing polls, and resize is still followed', async () => {
    started.length = 0
    const before = listeners
    const rest = await mount(true)
    expect(started).toEqual([])
    expect(listeners - before).toBe(2)                       // Ω and keep-clear follow resize, so nothing is missed
    await rest.unmount()
    expect(listeners).toBe(before)
  })

  it('awake, a resize (the phone keyboard opening) is measured at once, as well as on the poll', async () => {
    const awake = await mount(false)
    expect(handlers.get('resize')?.size).toBe(2)
    for (const f of handlers.get('resize') ?? []) f()        // throws if a measure can't run on resize
    await awake.unmount()
  })

  it('a late native mount and inert ownership changes are observed at rest without polling', async () => {
    const { act } = await import('react')
    const query = doc.querySelector
    let present = false, inert = false
    const box = { closest: () => inert ? {} : null }
    doc.querySelector = ((selector: string) => selector === '.still-question' && present ? box : null) as typeof doc.querySelector
    const before = mutations.size
    try {
      const rest = await mount(true)
      expect(ownVisible).toBe(false)
      present = true
      await act(async () => { for (const changed of mutations) changed() })
      expect(ownVisible).toBe(true)
      inert = true
      await act(async () => { for (const changed of mutations) changed() })
      expect(ownVisible).toBe(false)
      await rest.unmount()
      expect(mutations.size).toBe(before)
    } finally { doc.querySelector = query }
  })

  it('the native Ask reservation follows a lazy mount and growing choices at rest, with no poll and complete cleanup', async () => {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const query = doc.querySelector
    let present = false, top = 700
    const box = { getBoundingClientRect: () => ({ left: 100, top, width: 1080, height: 792 - top }) }
    doc.querySelector = ((selector: string) => selector === '.native-ask' && present ? box : null) as typeof doc.querySelector
    let reservation: ReturnType<typeof useOwnReservation> = null
    function Native() { const value = useOwnReservation('.native-ask'); useEffect(() => { reservation = value }); return null }
    const before = { mutations: mutations.size, resizes: resizes.size, listeners }
    const root = createRoot(doc.body.appendChild(doc.createElement('div')) as unknown as Element)
    started.length = 0
    try {
      await act(async () => root.render(createElement(Native)))
      expect(reservation).toBeNull()
      present = true
      await act(async () => { for (const changed of mutations) changed() })
      expect(reservation).toEqual({ left: 100, width: 1080, room: 112 })
      top = 620 // choices join the prompt's real layout and make its reservation taller
      await act(async () => { for (const changed of resizes) changed() })
      expect(reservation).toEqual({ left: 100, width: 1080, room: 192 })
      expect(started).toEqual([])
    } finally { await act(async () => root.unmount()); doc.querySelector = query }
    expect({ mutations: mutations.size, resizes: resizes.size, listeners }).toEqual(before)
  })

  it('still means: the page is hidden, or a phased experience rests with nothing over it', async () => {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const show = async (route: string) => {
      const root = createRoot(doc.body.appendChild(doc.createElement('div')) as unknown as Element)
      await act(async () => root.render(createElement(StillProbe, { route })))
      await act(async () => root.unmount())
      return seen.still
    }
    const d = doc as unknown as { hidden: boolean }
    d.hidden = false
    usePhase.setState({ phased: true, phase: 'awake' } as never)
    expect(await show('hive')).toBe(false)
    usePhase.setState({ phased: true, phase: 'rest' } as never)
    expect(await show('hive')).toBe(true)
    expect(await show('settings')).toBe(false)               // a page over the rest is used, so it is measured
    usePhase.setState({ phased: true, phase: 'awake' } as never)
    d.hidden = true
    expect(await show('hive')).toBe(true)
    d.hidden = false
  })

  it('RestScreen’s idle check runs only while awake: never at this screen’s rest or a phased experience’s', () => {
    const on = { allowed: true, minutes: 5, resting: false, phaseRest: false }
    expect(idleCheckRuns(on)).toBe(true)
    expect(idleCheckRuns({ ...on, phaseRest: true })).toBe(false)
    expect(idleCheckRuns({ ...on, resting: true })).toBe(false)
    expect(idleCheckRuns({ ...on, minutes: 0 })).toBe(false)
    expect(idleCheckRuns({ ...on, allowed: false })).toBe(false)
  })
})
