// @vitest-environment node
/**
 * The legacy Getting started list on a hive installed on its owner's own computer, mounted on real ReactDOM (the
 * MiniDOM): there First Light is the onboarding, so the list's pill does not show and #/setup opens First Light. On an
 * ordinary hive an admin still gets the pill. Only the hive's answers are scripted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, MiniNode } from '../../ui/miniDom.testkit'
import { useHive } from '../../store/store'
import { useFlDoor } from '../firstlight/door'
import { SetupNudge } from './SetupChecklist'
import SetupPage from './SetupPage'

const nav = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../../lib/router', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/router')>()), navigate: (...a: unknown[]) => { nav.calls.push(a) } }))

/** An admin on a hive with no provider yet, which says whether it was installed on its owner's computer. */
const hive = (localOwner: boolean) => ({
  me: async () => ({ principal: 'user:u_owner', kind: 'sso', role: 'admin', person: { id: 'u_owner', name: 'Owner', email: 'owner@local.invalid' } }),
  authMethods: async () => ({ password: false, public: false, sso: { enabled: false, provider: 'google', login_url: null }, local_owner: localOwner }),
  listProviders: async () => [],
  listKeys: async () => [],
})

let doc: MiniDocument, root: Root
let saved: Record<string, unknown>
let hiveBefore: ReturnType<typeof useHive.getState>

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, location: { hash: '#/', search: '' }, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }), addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
  nav.calls.length = 0
  useFlDoor.getState().close()
  hiveBefore = useHive.getState()
})
afterEach(async () => {
  await act(async () => root.unmount())
  useFlDoor.getState().close()
  useHive.setState(hiveBefore, true)
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

const settle = async () => {
  for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function mount(localOwner: boolean, which: 'nudge' | 'page') {
  useHive.setState({ client: hive(localOwner) as never, ready: true, agents: { a_one: { id: 'a_one' } } as never })
  await act(async () => root.render(createElement(which === 'nudge' ? SetupNudge : SetupPage)))
  await settle()
}
const text = () => (doc.body as MiniNode).textContent

describe('the legacy Getting started list is not onboarding on a hive installed on its owner’s computer', () => {
  it('an ordinary hive still shows its admin the pill', async () => {
    await mount(false, 'nudge')
    expect(text()).toMatch(/Getting started · \d of \d/)
  })

  it('a local-owner hive shows no pill', async () => {
    await mount(true, 'nudge')
    expect(text()).not.toContain('Getting started')
  })

  it('a local-owner hive’s #/setup opens First Light on the hive instead of the list', async () => {
    await mount(true, 'page')
    expect(useFlDoor.getState().asked).toMatchObject({ mode: 'live' })
    expect(nav.calls).toEqual([[{ name: 'hive' }, { replace: true }]])
    expect(text()).not.toContain('Connect an AI provider')
  })
})
