import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'
import { IDENTITY_CHANGED_WORDS } from '../../api/client'

/**
 * professional-release r1.1 (stand-in P1): LaunchSwarm MOUNTED (react-dom on ui/miniDom.testkit). A launch is a chain of
 * hive writes: the swarm, its spending limit, each mind and its start, the first task. A sign-in change (or closing the
 * wizard) while ANY of them is in flight stops the launch there: no later write is sent, and the step it stopped at
 * says so honestly. Each await point is tried in turn. The fake client answers success, so this is the per-step
 * binding in LaunchSwarm itself (api/identityChanged.test.ts covers the live client's own refusal). INVENTED data only.
 */

vi.mock('../../ui/Page', () => ({ Page: (p: { children?: unknown }) => createElement('div', { 'data-page': '' }, p.children as never) }))
vi.mock('framer-motion', () => ({
  AnimatePresence: (p: { children?: unknown }) => p.children,
  m: { div: (p: { children?: unknown }) => createElement('div', null, p.children as never), span: () => null },
}))
vi.mock('../../ui/primitives', () => ({
  Button: (p: { children?: unknown; onClick?: () => void; disabled?: boolean }) => createElement('button', { onClick: p.onClick, disabled: p.disabled, 'data-button': '' }, p.children as never),
  Orb: () => null,
  Segmented: () => null,
}))
vi.mock('../../ui/Icon', () => ({ Icon: () => null }))
vi.mock('../../ui/Visibility', () => ({ VisibilityPicker: () => null }))
vi.mock('../keys/KeyPicker', () => ({ KeyPicker: () => null }))
vi.mock('../models/ModelPicker', () => ({ ModelPicker: () => null }))
vi.mock('../roles/RoleSelect', () => ({ RoleSelect: () => null }))
vi.mock('../ask/dirty', () => ({ useUnsaved: () => undefined }))
vi.mock('../../shell/unsavedWork', () => ({ markSaved: () => undefined }))
vi.mock('../../lib/router', async (orig) => ({ ...(await orig<typeof import('../../lib/router')>()), navigate: () => undefined }))

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = {
    document: doc,
    location: { hash: '#/swarms/new', search: '', pathname: '/' },
    history: { state: null, replaceState: () => undefined, pushState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    HTMLIFrameElement: class {},
    innerWidth: 1440,
    innerHeight: 900,
  }
  doc.defaultView = win
  g.HTMLIFrameElement = win.HTMLIFrameElement
  g.window = win
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})

/** A client whose every write waits until the test answers it; `calls` is the order the writes were SENT. */
function fakeClient() {
  const calls: string[] = []
  const waiting: { name: string; answer: () => void }[] = []
  const write = (name: string, value: unknown) => () => new Promise((res) => {
    calls.push(name)
    waiting.push({ name, answer: () => res(value) })
  })
  let n = 0
  const client = {
    createSwarm: write('createSwarm', { id: 's_invented', name: 'Invented' }),
    setBudget: write('setBudget', { ok: true }),
    createAgent: (b: { name: string }) => write(`createAgent:${b.name}`, { id: `a_invented_${++n}`, name: b.name })(),
    agentAction: (id: string) => write(`agentAction:${id}`, { id })(),
    createGoal: write('createGoal', { id: 'g_invented' }),
  }
  return { client, calls, waiting }
}

const text = (n: MiniNode) => n.textContent
const buttons = () => doc.body.findAll((n) => n.tagName === 'BUTTON')
const button = (label: RegExp) => buttons().find((b) => label.test(text(b)))!
const inputs = () => doc.body.findAll((n) => n.tagName === 'INPUT')

async function mountWizard(client: object) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useHive } = await import('../../store/store')
  useHive.setState({ client: client as never, agents: {}, swarms: {}, models: [], roles: [] as never, inits: (useHive.getState().inits ?? 0) + 1 })
  const { default: LaunchSwarm } = await import('./LaunchSwarm')
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host as unknown as Element)
  await act(async () => root.render(createElement(LaunchSwarm)))
  const change = async (input: MiniNode, value: string) => act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value } }) })
  // step 0: a name; then Continue to Minds, Limits (set a limit, so the budget write happens), Launch
  await change(inputs().find((i) => (i.getAttribute('placeholder') ?? '').startsWith('e.g.'))!, 'Invented swarm')
  await act(async () => press(button(/^Continue$/)))
  await act(async () => press(button(/^Continue$/)))
  await change(inputs().find((i) => i.getAttribute('aria-label') === 'Monthly limit in dollars')!, '100')
  await act(async () => press(button(/^Continue$/)))
  return { act, root, host, useHive }
}

/** Launch, and answer each write as it arrives; `at(k)` runs just before the k-th write is answered. */
async function launch(client: ReturnType<typeof fakeClient>, at: (k: number) => Promise<void> | void) {
  const w = await mountWizard(client.client)
  await w.act(async () => press(button(/^Launch /)))
  for (let k = 0; k < 50; k++) {
    await w.act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const next = client.waiting.shift()
    if (!next) break
    await at(k)
    await w.act(async () => { next.answer(); await new Promise((r) => setTimeout(r, 0)) })
  }
  return w
}

let full: string[] = []
beforeEach(async () => {
  doc.body.childNodes.length = 0
})

describe('a launch belongs to the sign-in and the open wizard it began under', () => {
  it('control: with no change every write is sent, in order (swarm, limit, each mind and its start, the task)', async () => {
    const c = fakeClient()
    const w = await launch(c, () => undefined)
    full = [...c.calls]
    expect(full[0]).toBe('createSwarm')
    expect(full[1]).toBe('setBudget')
    expect(full.filter((x) => x.startsWith('createAgent:')).length).toBeGreaterThan(1)
    expect(full.filter((x) => x.startsWith('agentAction:')).length).toBe(full.filter((x) => x.startsWith('createAgent:')).length)
    expect(full.at(-1)).toBe('createGoal')
    expect(text(doc.body)).not.toContain(IDENTITY_CHANGED_WORDS)
    await w.act(async () => w.root.unmount())
  })

  it('a sign-in change while ANY write is in flight: no later write is sent, and the step says it stopped', async () => {
    expect(full.length).toBeGreaterThan(4)
    for (let stopAt = 0; stopAt < full.length; stopAt++) {
      doc.body.childNodes.length = 0
      const c = fakeClient()
      let store: Awaited<ReturnType<typeof mountWizard>>['useHive'] | null = null
      const w = await launch(c, async (k) => {
        if (k === stopAt) {
          store = (await import('../../store/store')).useHive
          store.setState({ inits: store.getState().inits + 1 }) // a new sign-in (identity epoch bumps)
        }
      })
      expect(c.calls, `stopped at write ${stopAt} (${full[stopAt]})`).toEqual(full.slice(0, stopAt + 1))
      expect(text(doc.body), `stop said at ${full[stopAt]}`).toContain(IDENTITY_CHANGED_WORDS)
      // the stop ends the launch: said once, on the step it stopped at, and no later step is even begun
      const steps = doc.body.findAll((n) => n.tagName === 'LI' && n.parentNode?.getAttribute('aria-live') === 'polite')
      const begun = full.slice(0, stopAt + 1).filter((x) => !x.startsWith('agentAction:')).length
      expect(steps.length, `steps shown at ${full[stopAt]}`).toBe(begun)
      expect(steps.filter((li) => text(li).includes(IDENTITY_CHANGED_WORDS)).length).toBe(1)
      expect(text(steps.at(-1)!)).toContain(IDENTITY_CHANGED_WORDS)
      expect(text(doc.body)).not.toMatch(/Open Invented/) // never "launched"
      await w.act(async () => w.root.unmount())
    }
  }, 60_000)

  it('closing the wizard while ANY write is in flight: no later write is sent', async () => {
    expect(full.length).toBeGreaterThan(4)
    for (let stopAt = 0; stopAt < full.length; stopAt++) {
      doc.body.childNodes.length = 0
      const c2 = fakeClient()
      const m = await mountWizard(c2.client)
      await m.act(async () => press(button(/^Launch /)))
      for (let k = 0; k < 50; k++) {
        await m.act(async () => { await new Promise((r) => setTimeout(r, 0)) })
        const next = c2.waiting.shift()
        if (!next) break
        if (k === stopAt) await m.act(async () => m.root.unmount())
        await m.act(async () => { next.answer(); await new Promise((r) => setTimeout(r, 0)) })
      }
      expect(c2.calls, `closed at write ${stopAt} (${full[stopAt]})`).toEqual(full.slice(0, stopAt + 1))
    }
  }, 60_000)
})
