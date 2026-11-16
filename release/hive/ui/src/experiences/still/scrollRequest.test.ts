import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useRef } from 'react'
import { MiniDocument, type MiniNode } from '../../ui/miniDom.testkit'
import type { ScrollTo } from './scrollRequest'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * Still's scroll request (useScrollRequest) MOUNTED with fake timers. It lands after the paper settles and the sent
 * words clear; new typing, a refusal (may says no) or a press takes over. It used to drop a request with setState inside
 * the page's effect; new typing is now noticed while rendering and a refusal is dropped from a timer.
 */

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument & { hidden?: boolean }
const winListeners = new Map<string, Set<() => void>>()
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver']) saved[k] = g[k]
  doc = new MiniDocument() as MiniDocument & { hidden?: boolean }
  doc.hidden = false
  g.window = {
    document: doc, HTMLIFrameElement: class {},
    // looked up at each call, so the fake timers installed per test are the ones used
    setTimeout: (f: () => void, ms?: number) => setTimeout(f, ms), clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    addEventListener: (t: string, f: () => void) => { if (!winListeners.has(t)) winListeners.set(t, new Set()); winListeners.get(t)!.add(f) },
    removeEventListener: (t: string, f: () => void) => void winListeners.get(t)?.delete(f),
  }
  g.HTMLIFrameElement = (g.window as { HTMLIFrameElement: unknown }).HTMLIFrameElement
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.ResizeObserver = undefined
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})
beforeEach(() => { vi.useFakeTimers(); winListeners.clear() })
const unmounts: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const u of unmounts.splice(0)) await u()
  vi.useRealTimers()
})

async function mount(opts: { may?: () => boolean } = {}) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useScrollRequest } = await import('./scrollRequest')
  const landed: ScrollTo[] = []
  let ask: (to: ScrollTo, words: string | null) => void = () => undefined
  const Page = ({ words, again }: { words: string; again: string }) => {
    const watch = useRef<HTMLElement>(null)
    ask = useScrollRequest({ askWords: words, watch, may: opts.may ?? (() => true), land: (to) => void landed.push(to), again })
    return createElement('button', { type: 'button' }, 'paper')
  }
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  const render = async (words: string, again = 'hive') => act(async () => root.render(createElement(Page, { words, again })))
  await render('')
  unmounts.push(async () => act(async () => root.unmount()))
  return {
    landed, render,
    ask: async (to: ScrollTo, words: string | null) => act(async () => ask(to, words)),
    wait: async (ms: number) => act(async () => { vi.advanceTimersByTime(ms) }),
    key: async () => act(async () => { for (const f of [...(winListeners.get('keydown') ?? [])]) f() }),
    button: () => container.findAll((n) => n.tagName === 'BUTTON')[0] as MiniNode,
  }
}

describe("Still's scroll request", () => {
  it('lands at the limit when nothing reports the paper settling, once', async () => {
    const m = await mount()
    await m.ask('needs', null)
    await m.wait(1499)
    expect(m.landed).toEqual([])
    await m.wait(1)
    expect(m.landed).toEqual(['needs'])
    await m.wait(5000)
    expect(m.landed).toEqual(['needs'])
  })

  it('after an Ask: waits for the sent words to clear, then lands', async () => {
    const m = await mount()
    await m.render('show me what needs me')
    await m.ask('needs', 'show me what needs me')
    await m.wait(3000)
    expect(m.landed).toEqual([])
    await m.render('')
    await m.wait(1500)
    expect(m.landed).toEqual(['needs'])
  })

  it('new typing takes over: a request sent with other words never lands', async () => {
    const m = await mount()
    await m.render('show me what needs me')
    await m.ask('needs', 'show me what needs me')
    await m.render('actually, remind me')
    await m.render('')
    await m.wait(3000)
    expect(m.landed).toEqual([])
  })

  it('may says no: the request is dropped, and does not land when it later may', async () => {
    let may = false
    const m = await mount({ may: () => may })
    await m.ask('now', null)
    await m.wait(0)
    // the page comes back (its route or phase changes, which re-checks): the dropped request stays dropped
    may = true
    await m.render('', 'hive again')
    await m.wait(3000)
    expect(m.landed).toEqual([])
  })

  it('a key press takes over', async () => {
    const m = await mount()
    await m.ask('learned', null)
    await m.wait(500)
    await m.key()
    await m.wait(3000)
    expect(m.landed).toEqual([])
  })

  it('the Still page uses it, with no setPendingScroll left', () => {
    const src = fs.readFileSync(new URL('./index.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const requestScroll = useScrollRequest\(\{/)
    expect(src).not.toMatch(/setPendingScroll/)
  })
})
