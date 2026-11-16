// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the store and the client */
// Purpose: check the belief-link setting as a person uses it, mounted on the MiniDOM with a stand-in hive: each choice
// or tick is one write of the domains it means, the page then shows the link the hive answered, Some subjects writes
// nothing until a subject is ticked, a refused change says why, a change of who may see the mind reads it again, and
// each reader gets what their rights allow: its owner every choice, an admin only narrowing, anyone else nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { widens } from '../../api/beliefLinkRule'
import { ApiError } from '../../api/client'
import type { Agent, BeliefLink as Link, BeliefLinkDomains } from '../../api/types'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ client: null as any }))
vi.mock('../../store/store', () => {
  const state = () => ({ client: T.client, resyncs: 0 })
  const useHive = Object.assign((select: (s: any) => unknown) => select(state()), { getState: state, subscribe: () => () => undefined, setState: () => undefined })
  return { useHive, hiveBus: { on: () => () => undefined } }
})
vi.mock('../../lib/useAdmin', () => ({ useMe: () => ({ me: { principal: 'user:u_ada' }, admin: false, loaded: true, failed: false }) }))
vi.mock('../../shell/uiVariant', async (original) => ({ ...(await original<object>()), useLook: () => ({ current: { experience: 'classic' } }) }))
import { BeliefLinkSetting } from './BeliefLinkSetting'

// each mount opens real MeTTa spaces: the standard screen cap, its worst measured in api/sim/simTimeouts.test.ts
vi.setConfig({ testTimeout: 20_000 })

const WREN = { id: 'a_wren', name: 'Wren', hue: 140, status: 'awake', kind: 'omega', swarm_id: 's_orchard', owner: 'user:u_ada', visibility: 'public', may_control: true } as Agent
const RIGHTS: Record<'owner' | 'admin', Link['rights']> = {
  owner: { read_beliefs: true, read_setting: true, read_topics: true, narrow: true, widen: true },
  admin: { read_beliefs: true, read_setting: true, read_topics: false, narrow: true, widen: false },
}

/**
 * A stand-in hive keeping one mind's link by the hive's own rules, every write recorded: the reader stands to the mind
 * as its owner, as an admin who may only narrow it, or as another person the hive refuses (403 owner_only).
 */
function hive(start: Partial<Link> = {}, refuse?: ApiError, reader: 'owner' | 'admin' | 'other' = 'owner') {
  const standing = reader === 'other' ? null : { as: reader, rights: RIGHTS[reader] }
  let link: Link = { agent_id: WREN.id, domains: null, default: 'all', default_reason: null, linked: 'all', patterns: ['$stmt'], known_domains: reader === 'owner' ? ['coffee', 'weather'] : null, as: 'owner', rights: RIGHTS.owner, ...standing, ...start }
  const writes: BeliefLinkDomains[] = []
  let reads = 0
  const owner_only = () => new ApiError(403, 'owner_only', 'Only its owner decides who sees its beliefs')
  return {
    writes, reads: () => reads,
    client: {
      beliefLink: async () => {
        reads++
        if (!standing) throw owner_only()
        return structuredClone(link)
      },
      setBeliefLink: async (_id: string, domains: BeliefLinkDomains) => {
        writes.push(domains)
        if (refuse) throw refuse
        if (!standing || (widens(link, domains) && !standing.rights.widen)) throw owner_only()
        const linked = domains === null ? link.default : Array.isArray(domains) && !domains.length ? 'none' : domains
        link = { ...link, domains, linked }
        return structuredClone(link)
      },
    },
  }
}

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }) }
const mount = async (agent: Agent) => { await act(async () => root.render(createElement(BeliefLinkSetting, { agent }))); await flush() }
const text = () => host.textContent
const button = (label: string) => host.findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)[0]
const box = (label: string) => host.findAll((n) => n.tagName === 'LABEL' && n.textContent.includes(label))[0]?.findAll((n) => n.tagName === 'INPUT')[0]
const tick = async (label: string, on: boolean) => { await act(async () => { (reactProps(box(label)!).onChange as (e: unknown) => void)({ target: { checked: on } }) }); await flush() }
const choose = async (label: string) => { await act(async () => press(button(label)!)); await flush() }

beforeEach(async () => {
  const g = globalThis as any
  saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win
  g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host as unknown as Element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.parentNode?.removeChild(host)
  for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v
})

describe('who sees a mind’s beliefs, as its owner changes it', () => {
  it('a choice is one write, and the page shows what the hive answered', async () => {
    const h = hive(); T.client = h.client
    await mount(WREN)
    expect(text()).toContain('Its swarm sees every belief it holds')
    await choose('Only you')
    expect(h.writes).toEqual([[]])
    expect(text()).toContain('Only you see its beliefs. Its swarm sees none of them.')
    await choose('Default: every belief')
    expect(h.writes).toEqual([[], null])
    expect(text()).toContain('Its swarm sees every belief it holds')
  })

  it('Some subjects writes nothing until a subject is ticked, and unticking the last links none', async () => {
    const h = hive(); T.client = h.client
    await mount(WREN)
    await choose('Some subjects')
    expect(h.writes).toEqual([])
    expect(text()).toContain('Subjects its swarm sees')
    await tick('coffee', true)
    expect(h.writes).toEqual([['coffee']])
    expect(text()).toContain('Its swarm sees its beliefs about coffee, and none of the others.')
    await tick('weather', true)
    await tick('coffee', false)
    expect(h.writes).toEqual([['coffee'], ['coffee', 'weather'], ['weather']])
    await tick('weather', false)
    expect(h.writes.at(-1)).toEqual([])
    expect(text()).toContain('Only you see its beliefs')
  })

  it('a refused change says why and changes nothing on the page', async () => {
    const h = hive({}, new ApiError(403, 'forbidden', 'Only its owner or an admin decides who sees its beliefs')); T.client = h.client
    await mount(WREN)
    await choose('Every belief')
    expect(h.writes).toEqual(['all'])
    expect(text()).toContain('Could not change who sees its beliefs: Only its owner or an admin decides who sees its beliefs')
    expect(text()).toContain('Its swarm sees every belief it holds')
  })

  it('a change of who may see the mind reads its link again, since its default moves with it', async () => {
    const h = hive(); T.client = h.client
    await mount(WREN)
    const before = h.reads()
    await mount({ ...WREN, visibility: 'private' })
    expect(h.reads()).toBe(before + 1)
  })

  it("another person's change, which reaches this page as the mind's view, reads the link again", async () => {
    const h = hive(); T.client = h.client
    await mount({ ...WREN, belief_link: null })
    const before = h.reads()
    await mount({ ...WREN, belief_link: ['coffee'] })
    expect(h.reads()).toBe(before + 1)
    await mount({ ...WREN, belief_link: ['coffee'] })   // the same setting again reads nothing
    expect(h.reads()).toBe(before + 1)
  })

  it('its owner is offered every choice, wider and narrower', async () => {
    const h = hive({ domains: [], linked: 'none' }); T.client = h.client
    await mount(WREN)
    for (const choice of ['Default: every belief', 'Every belief', 'Some subjects', 'Only you']) expect(button(choice)).toBeDefined()
    await choose('Every belief')
    expect(h.writes).toEqual(['all'])
    expect(text()).toContain('Its swarm sees every belief it holds')
  })

  it('an admin who does not own it is offered only narrowing (Jon on #360): untick a linked subject, or link none', async () => {
    const h = hive({ domains: ['coffee', 'weather'], linked: ['coffee', 'weather'] }, undefined, 'admin'); T.client = h.client
    await mount({ ...WREN, owner: 'user:u_rowan' })
    expect(text()).toContain('Only its owner can let its swarm see more of its beliefs. You can narrow it.')
    for (const widening of ['Every belief', 'Some subjects', 'Default: every belief']) expect(button(widening)).toBeUndefined()
    await tick('weather', false)
    expect(h.writes).toEqual([['coffee']])
    expect(text()).toContain('Its swarm sees its beliefs about coffee, and none of the others.')
    expect(box('weather')).toBeUndefined()   // a subject no longer linked is not offered back: that would widen it
    await choose('Link none of its beliefs')
    expect(h.writes).toEqual([['coffee'], []])
    expect(text()).toContain('Only its owner sees its beliefs. Its swarm sees none of them.')
    expect(button('Link none of its beliefs')).toBeUndefined()
  })

  it('another person who sees the mind, whom the hive refuses, is shown nothing', async () => {
    const h = hive({}, undefined, 'other'); T.client = h.client
    await mount({ ...WREN, owner: 'user:u_rowan' })
    expect(h.reads()).toBe(1)
    expect(text()).toBe('')
  })

  it('a hive without links, or a mind hidden from this person, shows nothing', async () => {
    T.client = { beliefLink: async () => { throw new ApiError(404, 'not_found', 'No such agent') } }
    await mount(WREN)
    expect(text()).toBe('')
    T.client = {}
    await mount(WREN)
    expect(text()).toBe('')
  })
})
