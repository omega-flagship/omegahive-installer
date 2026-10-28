import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Kimi K5: the real useCodeIdentity hook (EditSession.tsx) under the same minimal React stand-in HostConfirm.test.ts
// uses (hook slots kept; effects and their cleanups run; useSyncExternalStore reads its snapshot), with a REAL
// LiveClient over stand-in fetch/storage/window. INVENTED tokens and references; nothing leaves the page.
const R = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[], ei: 0, pending: [] as (() => void)[] }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const slot = (init: () => unknown) => {
    const n = R.i++
    if (!(n in R.slots)) R.slots[n] = init()
    return n
  }
  const m = {
    ...actual,
    useState: (init: unknown) => {
      const n = slot(() => (typeof init === 'function' ? (init as () => unknown)() : init))
      return [R.slots[n], (v: unknown) => { R.slots[n] = typeof v === 'function' ? (v as (p: unknown) => unknown)(R.slots[n]) : v }]
    },
    useRef: (v: unknown) => R.slots[slot(() => ({ current: v }))],
    useCallback: (f: unknown) => f,
    useMemo: (f: () => unknown) => f(),
    useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
    useDebugValue: () => undefined,
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const n = R.ei++
      const prev = R.effects[n]
      if (!prev || !deps || !prev.deps || deps.some((d, k) => !Object.is(d, prev.deps![k])))
        R.pending.push(() => {
          if (typeof prev?.cleanup === 'function') (prev.cleanup as () => void)()
          R.effects[n] = { deps, cleanup: fn() }
        })
    },
  }
  return { ...m, default: m }
})
const H = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  const hook = Object.assign((sel: (s: ReturnType<typeof actual.useHive.getState>) => unknown) => sel({ ...actual.useHive.getState(), client: H.client } as ReturnType<typeof actual.useHive.getState>), actual.useHive)
  return { ...actual, useHive: hook }
})

import type { HiveClient, Me } from '../../api/client'
import { LiveClient } from '../../api/live'
import { useCodeIdentity } from './EditSession'

const TOKEN_KEY = 'omegadots.hive.token'
const REF_A = 'as1_' + 'a'.repeat(64)
const REF_B = 'as1_' + 'b'.repeat(64)

function render<T>(hook: () => T) {
  R.slots = []
  R.effects = []
  const out = { current: undefined as unknown as T }
  const once = () => {
    R.i = 0
    R.ei = 0
    R.pending = []
    out.current = hook()
    R.pending.forEach((f) => f())
  }
  once()
  return { get current() { return out.current }, rerender: once }
}

/** /api/auth/me answers wait until the test releases them, in any order. */
let meCalls: { auth: string | null; answer: (body: Partial<Me>) => void }[] = []
let listeners: ((e: StorageEvent) => void)[] = []
let store: Map<string, string>
const flush = () => new Promise((r) => setTimeout(r, 0))
const me = (principal: string, ref?: unknown) => ({ principal, kind: 'password', role: 'admin', ...(ref === undefined ? {} : { auth_session_ref: ref }) }) as Partial<Me>

beforeEach(() => {
  meCalls = []
  listeners = []
  store = new Map([[TOKEN_KEY, 'tok-a-invented']])
  vi.stubGlobal('window', {
    location: { href: 'https://hive.invalid/', search: '' },
    addEventListener: (type: string, l: (e: StorageEvent) => void) => type === 'storage' && listeners.push(l),
    removeEventListener: () => undefined,
  })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  })
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => new Promise<Response>((res) => {
    if (!String(url).endsWith('/api/auth/me')) throw new Error(`unexpected ${url}`)
    meCalls.push({ auth: (init.headers as Record<string, string>).Authorization ?? null, answer: (b) => res(new Response(JSON.stringify(b), { status: 200 })) })
  })))
})
afterEach(() => {
  H.client = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function otherTabSets(token: string | null) {
  if (token === null) store.delete(TOKEN_KEY)
  else store.set(TOKEN_KEY, token)
  for (const l of listeners) l({ key: TOKEN_KEY, newValue: token } as StorageEvent)
}

describe('useCodeIdentity (Kimi K5)', () => {
  it('a token flip emits, withholds the old identity at once and binds the new session after a new me()', async () => {
    const live = new LiveClient('https://hive.invalid')
    H.client = live
    let emits = 0
    live.onAuthChange(() => emits++)
    const h = render(() => useCodeIdentity())
    expect(h.current).toBeUndefined() // pending: no identity yet
    meCalls[0].answer(me('user:operator', REF_A))
    await flush()
    h.rerender()
    expect(h.current).toEqual({ client: live, context: live.authContext(), principal: 'user:operator', personSession: REF_A })

    otherTabSets('tok-b-invented')
    expect(emits).toBe(1)
    h.rerender() // the subscription's re-render: a new context
    expect(h.current).toBeUndefined() // the old session's identity is never shown for the new context
    expect(meCalls).toHaveLength(2)
    expect(meCalls[1].auth).toBe('Bearer tok-b-invented')
    meCalls[1].answer(me('user:operator', REF_B))
    await flush()
    h.rerender()
    expect(h.current?.personSession).toBe(REF_B)
  })

  it('a stale in-flight me() is dropped: the answer for the old credential never becomes the identity', async () => {
    const live = new LiveClient('https://hive.invalid')
    H.client = live
    const h = render(() => useCodeIdentity())
    otherTabSets('tok-b-invented') // before the first answer arrives
    h.rerender()
    meCalls[1].answer(me('user:operator', REF_B)) // the new answer may even arrive first
    meCalls[0].answer(me('user:operator', REF_A)) // the stale answer arrives last
    await flush()
    h.rerender()
    expect(h.current?.personSession).toBe(REF_B)
    expect((h.current as { context?: object } | undefined)?.context).toBe(live.authContext())
  })

  it('the hook fences by context itself, even for a client whose me() does not', async () => {
    let ctx = {}
    const subs = new Set<() => void>()
    let answer!: (m: Partial<Me>) => void
    const fake = {
      me: () => new Promise<Me>((r) => { answer = r as (m: Partial<Me>) => void }),
      authContext: () => ctx,
      onAuthChange: (l: () => void) => { subs.add(l); return () => subs.delete(l) },
    } as unknown as HiveClient
    H.client = fake
    const h = render(() => useCodeIdentity())
    const stale = answer
    ctx = {}
    subs.forEach((l) => l())
    stale(me('user:operator', REF_A)) // resolves after the context changed: must be ignored
    await flush()
    h.rerender()
    expect(h.current).toBeUndefined()
    answer(me('user:operator', REF_B))
    await flush()
    h.rerender()
    expect(h.current?.personSession).toBe(REF_B)
  })

  it.each([
    ['wrong prefix', 'as2_' + 'a'.repeat(64)],
    ['upper-case hex', 'as1_' + 'A'.repeat(64)],
    ['too short', 'as1_' + 'a'.repeat(63)],
    ['too long', 'as1_' + 'a'.repeat(65)],
    ['not hex', 'as1_' + 'g'.repeat(64)],
    ['a number', 12345],
    ['missing', undefined],
  ])('a malformed ref (%s) gives personSession null, principal kept', async (_label, ref) => {
    const live = new LiveClient('https://hive.invalid')
    H.client = live
    const h = render(() => useCodeIdentity())
    meCalls[0].answer(me('user:operator', ref))
    await flush()
    h.rerender()
    expect(h.current?.principal).toBe('user:operator')
    expect(h.current?.personSession).toBeNull()
  })

  it('without the change observer there is no personSession, even with a well-formed ref', async () => {
    const fake = { me: async () => me('user:operator', REF_A) as Me } as unknown as HiveClient
    H.client = fake
    const h = render(() => useCodeIdentity())
    await flush()
    h.rerender()
    expect(h.current).toMatchObject({ principal: 'user:operator', personSession: null })
  })

  it('signed out in another tab: identity is withheld, then null once me() is refused', async () => {
    const live = new LiveClient('https://hive.invalid')
    H.client = live
    const h = render(() => useCodeIdentity())
    meCalls[0].answer(me('user:operator', REF_A))
    await flush()
    h.rerender()
    expect(h.current?.personSession).toBe(REF_A)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'log in first' } }), { status: 401 })))
    otherTabSets(null)
    h.rerender()
    expect(h.current).toBeUndefined()
    await flush()
    h.rerender()
    expect(h.current).toMatchObject({ principal: null, personSession: null })
  })
})
