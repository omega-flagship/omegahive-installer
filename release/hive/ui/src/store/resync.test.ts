// Purpose: tests the store's resync count, the readers that hear it (lib/resync.ts) and the roster merge adoptRoster.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveClient } from '../api/live'
import type { Agent, Approval, Message, Swarm } from '../api/types'
import { onStoreResync } from '../lib/resync'
import { adoptRoster } from './reducer'
import { useHive } from './store'

/**
 * Flagship review #111, the parts beside the store's own re-read (reconnect.test.ts): a reconnect counts one resync and
 * every reader outside the store hears it once (lib/resync.ts), never for a new session; and adoptRoster, the pure merge
 * that replaces the minds and swarms with a fresh read while keeping what a live event changed during it.
 * INVENTED data; fetch, storage, window and WebSocket are stand-ins.
 */

const TOKEN_KEY = 'omegadots.hive.token'
const STREAM = 'a1b2c3d4e5f60718'

class FakeSocket {
  static made: FakeSocket[] = []
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  constructor(readonly url: URL) {
    FakeSocket.made.push(this)
  }
  send() {}
  close() {}
  frame(f: object) {
    this.onmessage?.({ data: JSON.stringify(f) })
  }
}

const agent = (id: string, status: Agent['status']) => ({ id, name: id.toUpperCase(), swarm_id: 's1', status, spent_usd: 0, created_at: '2026-11-01T00:00:00Z', model: 'm' }) as unknown as Agent
const approval = (id: string, status: Approval['status']) => ({ id, agent_id: 'a1', skill: 'shell', status, created_at: `2026-11-0${id.length}T00:00:00Z` }) as unknown as Approval
const message = (id: string, at: string) => ({ id, agent_id: 'a1', conversation_id: 'c', direction: 'out', sender: 'agent:a1', text: id, created_at: at }) as unknown as Message

let hive: { at: number; agents: Agent[]; swarms: Swarm[]; approvals: Approval[]; messages: Message[] }
let held: Map<string, { body: unknown; release: () => void; wait: Promise<void> }>
let holdNext: Set<string>
const clients: LiveClient[] = []
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function answer(path: string): unknown {
  if (path === '/api/hive') return { name: 'H', version: '1', agents: hive.agents.length, swarms: 1, awake: 0, beliefs: 0, spent_usd: 0 }
  if (path === '/api/agents') return hive.agents
  if (path === '/api/swarms') return hive.swarms
  if (path === '/api/approvals') return hive.approvals
  if (path === '/api/agents/a1/messages') return hive.messages
  return []   // every other read: empty (invented)
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.made = []
  held = new Map()
  holdNext = new Set()
  hive = {
    at: 1,
    agents: [agent('a1', 'awake'), agent('b1', 'awake')],
    swarms: [{ id: 's1', name: 'S', description: '', member_ids: ['a1', 'b1'], created_at: '2026-11-01T00:00:00Z' } as unknown as Swarm],
    approvals: [approval('p1', 'pending')],
    messages: [message('m1', '2026-11-01T00:00:01Z')],
  }
  const store = new Map([[TOKEN_KEY, 'tok-invented']])
  vi.stubGlobal('window', { location: { href: 'https://hive.invalid/', search: '' }, addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    const make = (body: unknown, at: number) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'hive-stream': `${STREAM} ${at}` } })
    const body = answer(path)   // read now, as the hive would evaluate it
    const readAt = hive.at
    if (!holdNext.has(path)) return make(body, readAt)
    holdNext.delete(path)
    let release!: () => void
    const wait = new Promise<void>((r) => (release = r))
    held.set(path, { body, release, wait })
    await wait
    return make(body, readAt)
  }))
})
afterEach(() => {
  for (const c of clients.splice(0)) {
    c.disconnect()
    c.dispose()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A tab signed in on a real LiveClient, hydrated by the real store, its socket greeted at the hive's position. */
async function signedIn(): Promise<{ c: LiveClient; ws: () => FakeSocket }> {
  const c = new LiveClient('https://hive.invalid')
  clients.push(c)
  await useHive.getState().init(c)
  await settle()
  const ws = () => FakeSocket.made.at(-1)!
  ws().readyState = 1
  ws().onopen?.({})
  ws().frame({ type: 'hello', at: 'now', hive: answer('/api/hive'), stream: { id: STREAM, at: hive.at } })
  await settle()
  return { c, ws }
}

/** The socket drops; `change` happens at the hive meanwhile; the socket comes back and the hive greets it. */
async function gap(ws: () => FakeSocket, change: () => void) {
  const first = ws()
  first.onclose?.({ code: 1006 })
  change()
  await vi.advanceTimersByTimeAsync(20_000)   // the reconnect backoff
  expect(ws()).not.toBe(first)
  ws().readyState = 1
  ws().onopen?.({})
  ws().frame({ type: 'hello', at: 'now', hive: answer('/api/hive'), stream: { id: STREAM, at: hive.at } })
  await settle()
}

describe('after a reconnect, the readers', () => {
  it('a reconnect with nothing changed still reads again, counts one resync, and readers outside the store hear it once', async () => {
    const { ws } = await signedIn()
    let heard = 0
    const off = onStoreResync(() => heard++)
    const reads = vi.mocked(fetch).mock.calls.length
    await gap(ws, () => undefined)
    off()
    expect(heard).toBe(1)
    expect(useHive.getState().resyncs).toBe(1)
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(reads)
  })
})

describe('adoptRoster', () => {
  const none = { agents: new Set<string>(), swarms: new Set<string>(), gone: new Set<string>() }
  const sw = (members: string[]) => ({ id: 's1', name: 'S', description: '', member_ids: members, created_at: 'x' }) as unknown as Swarm
  it('replaces what was held with the read: what went leaves, what came arrives', () => {
    const held = { agents: { a: agent('a', 'awake'), b: agent('b', 'awake') }, swarms: { s1: sw(['a', 'b']) } }
    const out = adoptRoster(held, [agent('a', 'asleep'), agent('c', 'awake')], [sw(['a', 'c'])], none)
    expect(Object.keys(out.agents).sort()).toEqual(['a', 'c'])
    expect(out.agents.a.status).toBe('asleep')
    expect(out.swarms.s1.member_ids).toEqual(['a', 'c'])
  })
  it('keeps the live value of whatever an event touched while the read was out', () => {
    const held = { agents: { a: agent('a', 'error') }, swarms: { s1: sw(['a']) } }
    const touched = { agents: new Set(['a', 'b']), swarms: new Set<string>(), gone: new Set(['b']) }
    const out = adoptRoster(held, [agent('a', 'awake'), agent('b', 'awake')], [sw(['a', 'b'])], touched)
    expect(out.agents.a.status).toBe('error')
    expect(out.agents.b).toBeUndefined()
    expect(out.swarms.s1.member_ids).toEqual(['a'])
  })
})

describe('onStoreResync', () => {
  it('fires on each resync of the same session and never for a new session', async () => {
    const c = new LiveClient('https://hive.invalid')
    clients.push(c)
    await useHive.getState().init(c)
    let heard = 0
    const off = onStoreResync(() => heard++)
    useHive.setState((s) => ({ resyncs: s.resyncs + 1 }))
    expect(heard).toBe(1)
    const other = new LiveClient('https://hive.invalid')
    clients.push(other)
    await useHive.getState().init(other)   // a different client: a new session, resyncs back to 0
    expect(heard).toBe(1)
    off()
  })
})
