import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument } from '../../ui/miniDom.testkit'
import { useAuto } from './auto'
import { DemoHost } from './demo'
import { setFlScreen, stepOf, useFirstLight, type FlScreen } from './store'

/**
 * followups-r8 (stand-in FL-R2 P2): the journey's own timer (useAuto, mounted) does not move a guest on while they are
 * asking their host for more: the last guest step would take the card, and its controls, away mid-choice. Juno and
 * Hazel are invented (the demo host); nothing is sent anywhere.
 */
const screen: FlScreen = { act: () => undefined, gallery: () => undefined, galleryOpen: () => false, savedLook: () => 'classic||', savedLookName: () => 'Classic', deviceOnly: () => false }
const g = () => useFirstLight.getState()
const at = () => stepOf(g().run)?.id

const glob = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
const doc = new MiniDocument()
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = glob[k]
  const win = { document: doc, location: { hash: '#/', search: '', pathname: '/' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, HTMLIFrameElement: class {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
  doc.defaultView = win
  Object.assign(glob, { window: win, document: doc, HTMLIFrameElement: win.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true })
  setFlScreen(screen)
})
afterAll(() => {
  setFlScreen(null)
  for (const [k, v] of Object.entries(saved)) glob[k] = v
})
let unmount: () => void = () => undefined
afterEach(() => {
  unmount()
  g().stop()
  vi.useRealTimers()
})

function Auto() {
  useAuto(useFirstLight((s) => s.run))
  return null
}
async function mount() {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(doc.body.appendChild(doc.createElement('div')) as unknown as Element)
  await act(async () => root.render(createElement(Auto)))
  unmount = () => act(() => root.unmount())
  return act
}

describe('the guest’s request holds the journey’s timer', () => {
  it('at 3.3g (the last guest step) the amounts open: no move however long; closed: it moves on after the time to read', async () => {
    await g().start({ mode: 'demo', persona: 'juno', host: new DemoHost('juno'), step: '3.3g', paused: true })
    expect(at()).toBe('3.3g')
    vi.useFakeTimers()
    const act = await mount()
    await act(async () => g().askChoosing(true))
    await act(async () => g().toggle()) // play
    expect(g().run!.status).toBe('playing')
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(at()).toBe('3.3g') // held: the card and its controls stay
    await act(async () => g().askChoosing(false))
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(at()).toBe('3.3g') // the full time to read again, not the rest of the old one
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(at()).not.toBe('3.3g')
  })
  it('a request on its way holds too; once answered, the step moves on after its time', async () => {
    await g().start({ mode: 'demo', persona: 'juno', host: new DemoHost('juno'), step: '3.2g', paused: true })
    expect(at()).toBe('3.2g')
    const host = g().run!.host
    let answer: () => void = () => undefined
    const real = host.askForMore.bind(host)
    host.askForMore = (a: number) => new Promise((res) => { answer = () => res(real(a)) })
    vi.useFakeTimers()
    const act = await mount()
    await act(async () => g().askChoosing(true))
    let asking: Promise<void> = Promise.resolve()
    await act(async () => { asking = g().askForMore(10) })
    await act(async () => g().toggle())
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(at()).toBe('3.2g')
    expect(g().run!.ask.busy).toBe(true)
    await act(async () => { answer(); await asking })
    expect(g().run!.ask.sent).toEqual({ amount: 10 })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(at()).not.toBe('3.2g')
  })
  it('without a request, a guest step moves on by itself as before', async () => {
    await g().start({ mode: 'demo', persona: 'juno', host: new DemoHost('juno'), step: '3.2g', paused: true })
    vi.useFakeTimers()
    const act = await mount()
    await act(async () => g().toggle())
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(at()).not.toBe('3.2g')
  })
})
