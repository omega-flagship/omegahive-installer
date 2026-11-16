// Purpose: tests that after a reconnect the store holds what the hive holds now (the real LiveClient and store).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveClient } from '../api/live'
import type { Agent, Approval, Message, Swarm } from '../api/types'
import { useHive } from './store'

/**
 * Flagship review #111: after the events socket comes back from a gap, the UI shows no state the gap left stale. The
 * REAL LiveClient and the REAL store against a stand-in hive: its socket drops, the hive changes while it is down
 * (a mind deleted, one asleep, one born, an approval decided, another asked, a message said), the socket reconnects,
 * and the store holds what the hive holds now. A live event that lands while the re-read is out stays (it is newer).
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

describe('after a reconnect', () => {
  it('the store holds what the hive holds now, not what it held before the gap', async () => {
    const { ws } = await signedIn()
    await useHive.getState().loadMessages('a1')   // a chat this session opened
    useHive.getState().apply({ type: 'agent.thinking', at: 'now', agent_id: 'a1', phase: 'thinking' } as never)
    expect(Object.keys(useHive.getState().agents).sort()).toEqual(['a1', 'b1'])

    await gap(ws, () => {
      hive.at = 7
      hive.agents = [agent('a1', 'asleep'), agent('c1', 'awake')]
      hive.swarms = [{ ...hive.swarms[0], member_ids: ['a1', 'c1'] }]
      hive.approvals = [approval('p1', 'approved'), approval('p22', 'pending')]
      hive.messages = [...hive.messages, message('m2', '2026-11-01T00:00:09Z')]
    })

    const s = useHive.getState()
    expect(Object.keys(s.agents).sort()).toEqual(['a1', 'c1'])     // b1 went during the gap, c1 came
    expect(s.agents.a1.status).toBe('asleep')
    expect(s.swarms.s1.member_ids).toEqual(['a1', 'c1'])
    expect(s.approvals.p1.status).toBe('approved')
    expect(s.approvals.p22.status).toBe('pending')
    expect(s.messages.a1.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(s.thinking).toEqual({})                                  // only the stream says it; it says it again
  })

  it('a live event that lands while the re-read is out wins over the read', async () => {
    const { ws } = await signedIn()
    holdNext.add('/api/agents')
    await gap(ws, () => {
      hive.at = 3
      hive.agents = [agent('a1', 'awake'), agent('b1', 'awake'), agent('c1', 'awake')]
      hive.swarms = [{ ...hive.swarms[0], member_ids: ['a1', 'b1', 'c1'] }]
    })
    const out = held.get('/api/agents')!
    expect(out).toBeDefined()   // the re-read is out, read as c1 awake and b1 present
    ws().frame({ type: 'agent.updated', at: 'now', agent: agent('c1', 'error') })
    ws().frame({ type: 'agent.deleted', at: 'now', agent_id: 'b1' })
    out.release()
    await settle()
    const s = useHive.getState()
    expect(s.agents.c1.status).toBe('error')
    expect(s.agents.b1).toBeUndefined()
    expect(s.swarms.s1.member_ids).toEqual(['a1', 'c1'])
  })

})
