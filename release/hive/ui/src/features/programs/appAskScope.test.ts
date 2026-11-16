import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import type { AppAskOptions, AppAskState } from '../../lib/appAsk'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * useAppAsk MOUNTED with its controller faked. An app's Ask authority is one scope per document, release and identity:
 * when a new scope starts (here, a new release), nothing the earlier one showed may carry over (its "Ask in this
 * app", its "Checking…", its note). The reset used to be setState at the start of the effect; it is now in the
 * effect's cleanup, which always runs before the next scope's effect, and when the Ask goes unavailable.
 */

const made = vi.hoisted(() => ({ list: [] as { opts: AppAskOptions; revoke: () => Promise<void> }[], asked: [] as string[] }))
vi.mock('../../lib/identityEpoch', async (orig) => ({
  ...(await orig<typeof import('../../lib/identityEpoch')>()),
  askConfirmBound: async (question: string) => { made.asked.push(question); return true },
}))
vi.mock('../../lib/appAsk', async (orig) => {
  const real = await orig<typeof import('../../lib/appAsk')>()
  class AppAskController {
    pending: (() => void) | null = null
    constructor(public opts: AppAskOptions) { made.list.push(this as never) }
    open = async () => undefined
    receive = async () => null
    fence = () => undefined
    dispose = () => undefined
    visibilityChanged = () => undefined
    showCurrent = async () => undefined
    // held open by the test: the scope is "Checking…" until it settles
    revoke = () => new Promise<void>((resolve) => { this.pending = resolve })
  }
  return { ...real, AppAskController }
})

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'MutationObserver']) saved[k] = g[k]
  doc = new MiniDocument()
  g.window = { document: doc, addEventListener: () => undefined, removeEventListener: () => undefined, HTMLIFrameElement: class {}, setTimeout, clearTimeout, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) }
  g.HTMLIFrameElement = (g.window as { HTMLIFrameElement: unknown }).HTMLIFrameElement
  g.MutationObserver = class { observe() {} disconnect() {} }
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})
const unmounts: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const u of unmounts.splice(0)) await u()
  made.list.length = 0
  made.asked.length = 0
})

const fn = () => async () => ({})
const client = Object.fromEntries(['programAskCard', 'programAskConsent', 'programAskRevoke', 'programAskFrame', 'programAskPresence', 'programAskClose', 'programAskOp', 'askPresentation', 'askClaim', 'askHandover'].map((n) => [n, fn()]))
const binding = { epoch: 1, current: () => true, commit: <T,>(f: () => T) => f() }

async function mount() {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useAppAsk } = await import('./AppAsk')
  const frame = { current: null }
  const Host = ({ digest, appName = 'Invented app' }: { digest: string; appName?: string }) => {
    const ask = useAppAsk({
      client: client as never, app: 'invented-app', appName, channel: 'slot-1',
      release: { digest } as never, binding: binding as never, frame, person: true, documentReady: true,
      post: () => undefined, active: () => undefined,
    })
    return createElement('div', null, ask.controls)
  }
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  const render = async (digest: string, appName?: string) => act(async () => root.render(createElement(Host, { digest, appName })))
  await render('sha256:invented-a')
  unmounts.push(async () => act(async () => root.unmount()))
  return {
    act,
    render,
    status: () => container.findAll((n) => n.getAttribute('role') === 'status')[0]?.textContent,
    button: (label: string) => container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)[0] as MiniNode,
  }
}

describe("an app's Ask: a new scope starts clean", () => {
  it('a new release: the earlier scope’s "Ask in this app" does not carry over', async () => {
    const m = await mount()
    expect(made.list).toHaveLength(1)
    await m.act(async () => made.list[0].opts.state({ active: true, reason: null, resumable: [] } satisfies AppAskState))
    expect(m.status()).toBe('Ask in this app')
    await m.render('sha256:invented-b')
    expect(made.list).toHaveLength(2)
    expect(m.status()).toBe('Your Ask')
  })

  it('a new release while the earlier scope is checking: not "Checking…" in the new one', async () => {
    const m = await mount()
    await m.act(async () => press(m.button('Turn off Ask access')))
    expect(m.status()).toBe('Checking…')
    await m.render('sha256:invented-b')
    expect(m.status()).toBe('Your Ask')
    expect(m.button('Turn off Ask access').getAttribute('disabled')).toBeNull()
  })

  it('the reset is in the cleanup, not setState at the start of the effect', () => {
    const src = fs.readFileSync(new URL('./AppAsk.tsx', import.meta.url), 'utf8')
    expect(src).not.toMatch(/let live = true\n\s*setBusy\(false\)/)
    expect(src).toMatch(/setQuestion\(null\); approved\.current = false\n\s*\/\/ what this scope showed goes with it[^\n]*\n\s*setBusy\(false\); setNote\(null\); setState\(initialState\)/)
  })

  it('the controller asks with the latest app name: a rename that is drawn reaches the hand-off question', async () => {
    const m = await mount()
    await m.render('sha256:invented-a', 'Invented app, renamed')
    expect(made.list).toHaveLength(1)
    await m.act(async () => { await made.list[0].opts.confirmHandoff('op_invented') })
    expect(made.asked).toEqual(['Show this Ask in Invented app, renamed? You can return it here at any time.'])
  })

  it('the latest input is written at commit, not while rendering', () => {
    const src = fs.readFileSync(new URL('./AppAsk.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const latest = useRef\(input\)\n\s*useLayoutEffect\(\(\) => \{ latest\.current = input \}\)/)
  })
})

