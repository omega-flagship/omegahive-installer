import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { MiniDocument } from '../ui/miniDom.testkit'
import { clockText } from '../shell/clockModel'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * Three states that were set with setState inside an effect, MOUNTED with fake timers: a consent dialog's arming
 * (useArmedAfter), the consent host's controller (heldValue), and the second clock's roll when motion is reduced
 * (OsClock ThenTime). Each is now set from a timer or a store, or worked out while rendering.
 */

const motion = vi.hoisted(() => ({ reduce: false }))
vi.mock('./hooks', async (orig) => ({ ...(await orig<typeof import('./hooks')>()), useReducedMotion: () => motion.reduce }))

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[k] = g[k]
  doc = new MiniDocument()
  g.window = { document: doc, addEventListener: () => undefined, removeEventListener: () => undefined, HTMLIFrameElement: class {}, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) }
  g.HTMLIFrameElement = (g.window as { HTMLIFrameElement: unknown }).HTMLIFrameElement
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.requestAnimationFrame = (f: (t: number) => void) => setTimeout(() => f(performance.now()), 16) as unknown as number
  g.cancelAnimationFrame = (id: number) => clearTimeout(id)
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})
beforeEach(() => { vi.useFakeTimers(); motion.reduce = false })
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
  return {
    text: () => container.textContent,
    render: async (next: ReturnType<typeof createElement>) => act(async () => root.render(next)),
    wait: async (ms: number) => act(async () => { vi.advanceTimersByTime(ms) }),
  }
}

describe('a decision is armed only after its delay', () => {
  it('unarmed when it opens, armed after 450 ms; a newly opened one is unarmed at once; none is unarmed', async () => {
    const { useArmedAfter } = await import('./useArmedAfter')
    const Box = ({ openedAt }: { openedAt: number | null }) => createElement('p', null, useArmedAfter(openedAt) ? 'armed' : 'not armed')
    const m = await mount(createElement(Box, { openedAt: performance.now() }))
    expect(m.text()).toBe('not armed')
    await m.wait(449)
    expect(m.text()).toBe('not armed')
    await m.wait(1)
    expect(m.text()).toBe('armed')
    await m.render(createElement(Box, { openedAt: performance.now() }))
    expect(m.text()).toBe('not armed')
    await m.wait(450)
    expect(m.text()).toBe('armed')
    await m.render(createElement(Box, { openedAt: null }))
    expect(m.text()).toBe('not armed')
  })

  it('the consent dialog uses it (no setArmed)', () => {
    const src = fs.readFileSync(new URL('../features/programs/PersonSwarmConsent.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const armed = useArmedAfter\(openedAt\)/)
    expect(src).not.toMatch(/setArmed\(/)
  })
})

describe('a controller made in an effect, shown by the render', () => {
  it('the render shows what the effect set, and the latest when it is set again', async () => {
    const { heldValue } = await import('./heldValue')
    const Host = ({ name }: { name: string }) => {
      const [held] = useState(() => heldValue<string | null>(null))
      const shown = useSyncExternalStore(held.subscribe, held.get, held.get)
      useLayoutEffect(() => { held.set(`controller for ${name}`) }, [name, held])
      return createElement('p', null, shown ?? 'none yet')
    }
    const m = await mount(createElement(Host, { name: 'a' }))
    expect(m.text()).toBe('controller for a')
    await m.render(createElement(Host, { name: 'b' }))
    expect(m.text()).toBe('controller for b')
  })

  it('the consent host holds its controller that way (no setHost)', () => {
    const src = fs.readFileSync(new URL('../features/programs/PersonSwarmConsent.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const host = useSyncExternalStore\(held\.subscribe, held\.get, held\.get\)/)
    expect(src).toMatch(/held\.set\(\{ scope, controller \}\)/)
    expect(src).not.toMatch(/setHost\(/)
  })
})

describe('the second clock', () => {
  const TO = '2026-06-01T09:30:00Z'
  const target = clockText(new Date(TO), undefined, '24').time

  it('reduced motion: the time jumped to is shown at once, and a new one too', async () => {
    motion.reduce = true
    const { ThenTime } = await import('../shell/OsClock')
    const m = await mount(createElement(ThenTime, { to: TO, cycle: '24' }))
    expect(m.text()).toBe(target)
    await m.render(createElement(ThenTime, { to: '2026-07-01T18:45:00Z', cycle: '24' }))
    expect(m.text()).toBe(clockText(new Date('2026-07-01T18:45:00Z'), undefined, '24').time)
  })

  it('motion reduced in the middle of a roll: the roll stops on the time jumped to, not where it was', async () => {
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    const { ThenTime } = await import('../shell/OsClock')
    const m = await mount(createElement(ThenTime, { to: TO, cycle: '24' }))
    await m.wait(400)
    expect(m.text()).not.toBe(target)
    motion.reduce = true
    await m.render(createElement(ThenTime, { to: TO, cycle: '24' }))
    expect(m.text()).toBe(target)
  })

  it('no time: the words as given', async () => {
    const { ThenTime } = await import('../shell/OsClock')
    const m = await mount(createElement(ThenTime, { to: 'yesterday', cycle: '24' }))
    expect(m.text()).toBe('yesterday')
  })
})
