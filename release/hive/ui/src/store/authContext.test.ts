import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from '../api/client'
import { SimClient } from '../api/sim/SimClient'
import type { Approval } from '../api/types'
import { clientIdentity, readContext } from '../lib/readContext'
import { useHive } from './store'

/**
 * Platform person-session (439efb9) wired into the store: a client that reports credential changes (authContext /
 * onAuthChange) starts a new store session on every one. Synthetic clients only: a SimClient given the two members
 * and a token the test controls (no hive, invented data).
 */

const clients: SimClient[] = []

/** A SimClient that behaves like the live client's credential side: a token, a new handle per change, listeners. */
function authed(seed: number, token: string | null) {
  const sim = new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
  clients.push(sim)
  const events = new Emitter<void>()
  let handle: object = {}
  let current = token
  const connects = vi.spyOn(sim, 'connect')
  Object.assign(sim, {
    needsAuth: () => !current,
    authContext: () => handle,
    onAuthChange: (l: () => void) => events.on(l),
  })
  return {
    client: sim,
    connects,
    /** A credential change: this tab's login (even without a logout first), or another tab's sign-in or sign-out. */
    change(next: string | null) {
      current = next
      handle = {}
      events.emit()
    },
  }
}

function defer<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } })
})
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('store: every sign-in change is a new session', () => {
  it('same-client re-login without a logout: a new identity, and the old identity’s in-flight answer is dropped', async () => {
    const a = authed(21, 'token-a')
    await useHive.getState().init(a.client)
    const before = useHive.getState().session
    const ctxBefore = readContext(a.client, 'x')
    const sample = Object.values(useHive.getState().approvals)[0]
    const late = defer<Approval[]>()
    vi.spyOn(a.client, 'listApprovals').mockImplementationOnce(() => late.promise)
    const pending = useHive.getState().loadApprovals()
    // signed in again on the same client, no logout in between
    a.change('token-b')
    expect(useHive.getState().session).not.toBe(before)
    expect(readContext(a.client, 'x')).not.toBe(ctxBefore)
    late.resolve([{ ...sample, id: 'ap_old_identity', command: 'invented old-identity request' }])
    await pending
    await flush()
    expect(useHive.getState().client).toBe(a.client)
    expect(useHive.getState().approvals.ap_old_identity).toBeUndefined()
  })

  it('the change drops what the store held at once, before the new identity answers', async () => {
    const a = authed(22, 'token-a')
    await useHive.getState().init(a.client)
    const getHive = defer<never>()
    vi.spyOn(a.client, 'getHive').mockImplementation(() => getHive.promise)
    a.change('token-b')
    const s = useHive.getState()
    expect(s.agents).toEqual({})
    expect(s.ready).toBe(false)
  })

  it('cross-tab sign-in while Login shows: the store hydrates exactly once, and only hydrate connects', async () => {
    const a = authed(23, null)
    const getHive = vi.spyOn(a.client, 'getHive')
    await useHive.getState().init(a.client)
    useHive.setState({ connection: 'unauthorized' })
    expect(getHive).not.toHaveBeenCalled()
    expect(useHive.getState().ready).toBe(false)
    // another tab signed in: the storage listener adopts the token (no request, no connect of its own)
    a.change('token-from-other-tab')
    await flush(40)
    await vi.waitFor(() => expect(useHive.getState().ready).toBe(true))
    expect(getHive).toHaveBeenCalledTimes(1)
    expect(a.connects).toHaveBeenCalledTimes(1)
  })

  it('a same-tab sign-in through the client hydrates once (the Login form leaves it to the store)', async () => {
    const a = authed(24, null)
    const getHive = vi.spyOn(a.client, 'getHive')
    await useHive.getState().init(a.client)
    a.change('token-login')
    await vi.waitFor(() => expect(useHive.getState().ready).toBe(true))
    await flush(40)
    expect(getHive).toHaveBeenCalledTimes(1)
  })

  it('cross-tab sign-out: nothing read under the old identity stays, and a late answer for it never lands', async () => {
    const a = authed(25, 'token-a')
    await useHive.getState().init(a.client)
    expect(Object.keys(useHive.getState().agents).length).toBeGreaterThan(0)
    const sample = Object.values(useHive.getState().approvals)[0]
    const late = defer<Approval[]>()
    vi.spyOn(a.client, 'listApprovals').mockImplementationOnce(() => late.promise)
    const getHive = vi.spyOn(a.client, 'getHive')
    const pending = useHive.getState().loadApprovals()
    a.change(null)
    late.resolve([{ ...sample, id: 'ap_after_signout', command: 'invented old-identity request' }])
    await pending
    await flush()
    const s = useHive.getState()
    for (const k of ['approvals', 'goals', 'agents', 'swarms', 'messages'] as const) expect(s[k], k).toEqual({})
    expect(s.hive).toBeNull()
    expect(s.ready).toBe(false)
    // signed out: nothing is read again until a credential is present
    expect(getHive).not.toHaveBeenCalled()
  })

  it('a later init unsubscribes the earlier init’s observer', async () => {
    const a = authed(26, 'token-a')
    const b = authed(27, 'token-b')
    await useHive.getState().init(a.client)
    await useHive.getState().init(b.client)
    const session = useHive.getState().session
    a.change('token-a2')
    expect(useHive.getState().session).toBe(session)
    expect(useHive.getState().client).toBe(b.client)
  })
})

describe('a client without authContext (the sim) is unchanged', () => {
  it('readContext names only the client instance and the parts, as before', () => {
    const sim = new SimClient({ seed: 31, latency: false, autoStart: false, historyDays: 1 })
    clients.push(sim)
    expect(readContext(sim, 'g_1', ['user:x', true])).toBe(JSON.stringify([clientIdentity(sim), 'g_1', ['user:x', true]]))
  })

  it('init and hydrate read once, and the session holds until the next init', async () => {
    const sim = new SimClient({ seed: 32, latency: false, autoStart: false, historyDays: 1 })
    clients.push(sim)
    const getHive = vi.spyOn(sim, 'getHive')
    await useHive.getState().init(sim)
    const session = useHive.getState().session
    expect(useHive.getState().ready).toBe(true)
    expect(getHive).toHaveBeenCalledTimes(1)
    await flush()
    expect(useHive.getState().session).toBe(session)
  })
})
