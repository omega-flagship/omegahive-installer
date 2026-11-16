// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the client and the store */
/** The Code drawer's names for proposal authors (./authorNames), mounted on the MiniDOM with the hive's own shapes: the
 * person's store lists a request helper under its template's name ("foundation.code-helper.v1 6efe", seen on a fresh
 * v0.22 hive), and GET /api/teams/{swarm}/children lists it by child_id. Synthetic data only. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, type MiniNode } from '../../../ui/miniDom.testkit'

const HELPER = 'a_0d7cb74b44c600f14866312ca2fc2d14'
const ANVIL = 'a_' + 'a'.repeat(32)
const STRANGER = 'a_' + 'f'.repeat(32)
const SWARM = 's_1e1010be87df98f0f57cb61403e36a40'
const T = vi.hoisted(() => ({ store: null as any }))
vi.mock('../../../store/store', () => ({ useHive: (select: any) => select(T.store) }))
const { useAuthorNames } = await import('./authorNames')

const AUTHORS = [HELPER, `agent:${ANVIL}`, STRANGER, 'user:p_ada']
function Names({ client }: { client: any }) {
  const name = useAuthorNames(client, AUTHORS)
  return <ul>{AUTHORS.map((a) => <li key={a}>{name(a)}</li>)}</ul>
}

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
const shown = () => host.findAll((n) => n.tagName === 'LI').map((n) => n.textContent)
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }
beforeEach(async () => {
  const g = globalThis as any; saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client'); root = createRoot(host as unknown as Element)
  T.store = {
    agents: { [HELPER]: { id: HELPER, name: 'foundation.code-helper.v1 6efe', swarm_id: SWARM }, [ANVIL]: { id: ANVIL, name: 'Anvil', swarm_id: SWARM } },
    swarms: { [SWARM]: { id: SWARM, name: 'Create · Code' } },
  }
})
afterEach(async () => { await act(async () => root.unmount()); for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v })

describe('the drawer names a proposal’s author as a person reads it', () => {
  it('a request’s helper as its swarm, a standing mind by its name, an unknown mind as “a mind”, a person as before', async () => {
    const teamChildren = vi.fn(async () => ({ children: [{ child_id: HELPER, request_id: 'rq_1', team_id: SWARM, state: 'running' }], next_cursor: null }))
    await act(async () => root.render(<Names client={{ teamChildren }} />))
    await flush()
    expect(shown()).toEqual(['Create · Code', 'Anvil', 'a mind', 'person p_ada'])
    expect(teamChildren).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toMatch(/a_[0-9a-f]{32}|foundation\.code-helper/)
  })
  it('until the swarm’s children are read, or where they can’t be, a known mind is said as its swarm', async () => {
    await act(async () => root.render(<Names client={{ teamChildren: () => new Promise(() => undefined) }} />))
    expect(shown().slice(0, 2)).toEqual(['Create · Code', 'Create · Code'])
    await act(async () => root.render(<Names client={{ teamChildren: async () => Promise.reject(new Error('network')) }} />))
    await flush()
    expect(shown().slice(0, 2)).toEqual(['Create · Code', 'Create · Code'])
    await act(async () => root.render(<Names client={{}} />))
    await flush()
    expect(shown().slice(0, 2)).toEqual(['Create · Code', 'Create · Code'])
  })
})
