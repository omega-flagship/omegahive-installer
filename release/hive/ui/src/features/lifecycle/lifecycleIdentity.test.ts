import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'
import { IDENTITY_CHANGED_WORDS } from '../../api/client'

/**
 * professional-release r1.2 (stand-in r1.1 P1): LifecyclePage MOUNTED (react-dom on ui/miniDom.testkit). Issuing a lease
 * is two writes, the lease and then its instructions to the coordinator (a paid message); allowing the coordinator's
 * skills is one write per skill. A sign-in change at any point (while a write is in flight, or in the gap after its
 * answer settles and before the page resumes, past the live client's own check) stops the chain there: no later write
 * is sent, and the page says it stopped. INVENTED data only.
 */
vi.mock('../../ui/Page', () => ({ Page: (p: { children?: unknown }) => createElement('div', { 'data-page': '' }, p.children as never) }))
vi.mock('../../ui/primitives', () => ({
  Button: (p: { children?: unknown; onClick?: () => void; disabled?: boolean }) => createElement('button', { onClick: p.onClick, disabled: p.disabled }, p.children as never),
  EmptyState: (p: { title?: string }) => createElement('div', { 'data-empty': p.title ?? '' }),
}))
// the person says yes at once (the bound confirm still answers "no" on a change: lib/identityEpoch askConfirmBound)
vi.mock('../../ui/confirm', () => ({ askConfirm: async () => true, ConfirmHost: () => null }))
vi.mock('../../lib/router', async (orig) => ({ ...(await orig<typeof import('../../lib/router')>()), navigate: () => undefined }))

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
const doc = new MiniDocument()
// react-dom drives a <select> through `options` (each with value/selected): give the mini document just that
{
  const make = doc.createElement.bind(doc)
  doc.createElement = (tag: string) => {
    const el = make(tag)
    const o = el as unknown as Record<string, unknown>
    if (tag === 'select') Object.defineProperty(o, 'options', { get: () => el.findAll((n) => n.tagName === 'OPTION') })
    if (tag === 'option') { o.selected = false; o.defaultSelected = false; Object.defineProperty(o, 'value', { get: () => el.getAttribute('value') ?? el.textContent, set: (v: string) => el.setAttribute('value', v) }) }
    return el
  }
}
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  const win = { document: doc, location: { hash: '', search: '', pathname: '/' }, history: { state: null, replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), getComputedStyle: () => ({ getPropertyValue: () => '' }), HTMLIFrameElement: class {}, innerWidth: 1440, innerHeight: 900 }
  doc.defaultView = win
  Object.assign(g, { window: win, document: doc, HTMLIFrameElement: win.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true })
})
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50))
  for (const [k, v] of Object.entries(saved)) g[k] = v
})

const SWARM = 's_invented'
const COORD = 'a_invented_coord'
const MEMBER = 'a_invented_member'
type Gate = { name: string; answer: (bumpFirst?: () => void) => void }

/** A client whose writes wait for the test; `sent` is the order writes were SENT. */
function fakeClient() {
  const sent: string[] = []
  const waiting: Gate[] = []
  const write = (name: string, value: unknown) => () => new Promise((res) => {
    sent.push(name)
    // `bumpFirst` runs after the answer settles and before the awaiting page resumes (the stand-in's gap)
    waiting.push({ name, answer: (bumpFirst) => res(Promise.resolve(value).then((v) => { bumpFirst?.(); return v })) })
  })
  const client = {
    listGoals: async () => [{ id: 'g_invented', swarm_id: SWARM, title: 'Invented task', status: 'open', assignee: MEMBER, updated_at: '2026-10-16T00:00:00Z' }],
    listDelegations: async () => [{ coordinator_id: COORD, specialist_id: MEMBER }],
    setDelegation: write('setDelegation', {}),
    createPolicy: (b: { skill: string }) => write(`createPolicy:${b.skill}`, { id: `r_${b.skill}` })(),
    issueLease: write('issueLease', { lease: 'lease_invented' }),
    createGoal: write('createGoal', { id: 'g_new' }),
  }
  return { client, sent, waiting }
}

const text = (n: MiniNode) => n.textContent
const button = (label: RegExp) => doc.body.findAll((n) => n.tagName === 'BUTTON').find((b) => label.test(text(b)))!

async function mount(client: object) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useHive } = await import('../../store/store')
  const messages: string[] = []
  const toasts: { title: string; body?: string }[] = []
  useHive.setState({
    client: client as never,
    swarms: { [SWARM]: { id: SWARM, name: 'Invented swarm', description: '', hue: 1, coordinator_id: COORD, member_ids: [COORD, MEMBER], created_at: '2026-10-01T00:00:00Z' } } as never,
    agents: { [COORD]: { id: COORD, name: 'Coord', kind: 'omega', swarm_id: SWARM }, [MEMBER]: { id: MEMBER, name: 'Member', kind: 'omega', swarm_id: SWARM } } as never,
    policy: [] as never,
    loadPolicy: (async () => undefined) as never,
    sendMessage: (async (_id: string, t: string) => { messages.push(t) }) as never,
    toast: ((t: { title: string; body?: string }) => { toasts.push(t) }) as never,
  })
  const { default: LifecyclePage } = await import('./LifecyclePage')
  doc.body.childNodes.length = 0
  const host = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(host as unknown as Element)
  await act(async () => root.render(createElement(LifecyclePage, { swarmId: SWARM })))
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const bump = () => useHive.setState({ inits: useHive.getState().inits + 1 }) // a new sign-in (identity epoch)
  return { act, root, messages, toasts, settle, bump }
}

async function chooseLease(m: Awaited<ReturnType<typeof mount>>) {
  const selects = doc.body.findAll((n) => n.tagName === 'SELECT')
  const member = selects.find((s) => s.findAll((o) => o.tagName === 'OPTION').some((o) => o.getAttribute('value') === MEMBER) && !s.findAll((o) => o.tagName === 'OPTION').some((o) => o.getAttribute('value') === COORD))!
  await m.act(async () => { (reactProps(member).onChange as (e: unknown) => void)({ target: { value: MEMBER } }) })
  const taskSel = doc.body.findAll((n) => n.tagName === 'SELECT').find((s) => s.findAll((o) => o.tagName === 'OPTION').some((o) => o.getAttribute('value') === 'g_invented'))!
  await m.act(async () => { (reactProps(taskSel).onChange as (e: unknown) => void)({ target: { value: 'g_invented' } }) })
}

beforeEach(() => { doc.body.childNodes.length = 0 })

describe('issuing a lease belongs to the sign-in that issued it', () => {
  it('control: the lease, then its instructions to the coordinator', async () => {
    const c = fakeClient(); const m = await mount(c.client)
    await chooseLease(m)
    await m.act(async () => press(button(/^Issue lease$/)))
    await m.settle()
    c.waiting.shift()!.answer(); await m.settle()
    expect(c.sent).toEqual(['issueLease'])
    expect(m.messages).toHaveLength(1)
    expect(m.messages[0]).toContain('lease_invented')
    await m.act(async () => m.root.unmount())
  })
  it('a sign-in change while the lease is in flight: no message is sent, and the page says it stopped', async () => {
    const c = fakeClient(); const m = await mount(c.client)
    await chooseLease(m)
    await m.act(async () => press(button(/^Issue lease$/)))
    await m.settle()
    m.bump()
    c.waiting.shift()!.answer(); await m.settle()
    expect(m.messages).toEqual([])
    expect(m.toasts.map((t) => t.body)).toContain(IDENTITY_CHANGED_WORDS)
    await m.act(async () => m.root.unmount())
  })
  it("the stand-in's gap: the lease's answer settles, THEN the sign-in changes, before the page resumes: no message", async () => {
    const c = fakeClient(); const m = await mount(c.client)
    await chooseLease(m)
    await m.act(async () => press(button(/^Issue lease$/)))
    await m.settle()
    c.waiting.shift()!.answer(m.bump); await m.settle()
    expect(m.messages).toEqual([])
    await m.act(async () => m.root.unmount())
  })
  it('the page closed while the lease is in flight: no message', async () => {
    const c = fakeClient(); const m = await mount(c.client)
    await chooseLease(m)
    await m.act(async () => press(button(/^Issue lease$/)))
    await m.settle()
    await m.act(async () => m.root.unmount())
    c.waiting.shift()!.answer(); await new Promise((r) => setTimeout(r, 0))
    expect(m.messages).toEqual([])
  })
})

describe("allowing the coordinator's skills: one rule per skill, each under the sign-in that asked", () => {
  it('control: every missing skill is allowed, in order', async () => {
    const c = fakeClient(); const m = await mount(c.client)
    await m.act(async () => press(button(/^Allow \d+ skills?$/)))
    for (let i = 0; i < 10 && c.waiting.length; i++) { c.waiting.shift()!.answer(); await m.settle() }
    expect(c.sent.filter((x) => x.startsWith('createPolicy:'))).toHaveLength(5)
    await m.act(async () => m.root.unmount())
  })
  for (const at of [0, 2]) {
    it(`a sign-in change while rule ${at + 1} is in flight: no later rule is sent`, async () => {
      const c = fakeClient(); const m = await mount(c.client)
      await m.act(async () => press(button(/^Allow \d+ skills?$/)))
      for (let i = 0; i < 10 && c.waiting.length; i++) {
        await m.settle()
        if (i === at) m.bump()
        c.waiting.shift()!.answer(); await m.settle()
      }
      expect(c.sent.filter((x) => x.startsWith('createPolicy:'))).toHaveLength(at + 1)
      expect(m.toasts.map((t) => t.body)).toContain(IDENTITY_CHANGED_WORDS)
      await m.act(async () => m.root.unmount())
    })
  }
})
