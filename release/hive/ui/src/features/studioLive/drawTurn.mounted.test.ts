import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Create's Draw live R2 (Dot FIX-FIRST on df846351), MOUNTED: the real Ask field hook (the repo's controlled React
 * stand-in, as j0Target.mounted / enterHandlers / dualP2), the real hive and Ask stores, and a synthetic host whose answers
 * this test releases by hand. Covers: typed words win over history; the turn is the one the Ask's receipt names, never a
 * same-text turn of another person or thread; a stalled send gives up on time; leaving cancels; a second press joins
 * the first (one request). INVENTED minds and swarms; nothing leaves.
 */
const R = vi.hoisted(() => ({ own: null as null | { slots: unknown[]; effects: ({ deps?: unknown[]; cleanup?: unknown } | undefined)[]; dirty: boolean }, i: 0, ei: 0, pending: [] as (() => void)[], ids: 0 }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((d, k) => !Object.is(d, b[k]))
  const slot = (init: () => unknown) => {
    const own = R.own!, n = R.i++
    if (!(n in own.slots)) own.slots[n] = init()
    return n
  }
  const memo = (f: () => unknown, deps?: unknown[]) => {
    const own = R.own!, n = slot(() => ({ deps: undefined, value: undefined, fresh: true }))
    const s = own.slots[n] as { deps?: unknown[]; value: unknown; fresh: boolean }
    if (s.fresh || changed(deps, s.deps)) own.slots[n] = { deps, value: f(), fresh: false }
    return (own.slots[n] as { value: unknown }).value
  }
  const effect = (fn: () => unknown, deps?: unknown[]) => {
    const own = R.own!, n = R.ei++, prev = own.effects[n]
    if (!prev || changed(deps, prev.deps)) R.pending.push(() => {
      if (typeof prev?.cleanup === 'function') (prev.cleanup as () => void)()
      own.effects[n] = { deps, cleanup: fn() }
    })
  }
  const m = { ...actual,
    useState: (init: unknown) => {
      const own = R.own!, n = slot(() => typeof init === 'function' ? (init as () => unknown)() : init)
      return [own.slots[n], (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(own.slots[n]) : v
        if (!Object.is(next, own.slots[n])) { own.slots[n] = next; own.dirty = true }
      }]
    },
    useRef: (v: unknown) => R.own!.slots[slot(() => ({ current: v }))],
    useCallback: (f: unknown, deps?: unknown[]) => memo(() => f, deps), useMemo: memo,
    useId: () => R.own!.slots[slot(() => `:enter${++R.ids}:`)],
    useSyncExternalStore: (subscribe: (changed: () => void) => () => void, get: () => unknown) => {
      const own = R.own!, n = slot(() => ({ get, value: get() }))
      const snapshot = own.slots[n] as { get: () => unknown; value: unknown }
      snapshot.get = get; snapshot.value = get()
      effect(() => {
        const changed = () => {
          const next = snapshot.get()
          if (!Object.is(snapshot.value, next)) { snapshot.value = next; own.dirty = true }
        }
        const off = subscribe(changed)
        changed()
        return off
      }, [subscribe])
      return snapshot.value
    }, useDebugValue: () => undefined,
    useContext: (c: { _currentValue?: unknown }) => c._currentValue, useEffect: effect, useLayoutEffect: effect,
  }
  return { ...m, default: m }
})
// External Zustand's React binding is outside the stand-in's module graph: bridge only its hook (the dualP2 pattern)
async function bridged<S>(store: { getState: () => S; subscribe: (l: () => void) => () => void }) {
  const { useSyncExternalStore } = await import('react')
  return Object.assign((sel?: (s: S) => unknown) => {
    const read = () => (sel ? sel(store.getState()) : store.getState())
    return useSyncExternalStore(store.subscribe, read, read)
  }, store)
}
vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  return { ...actual, useHive: await bridged(actual.useHive) }
})
vi.mock('../../store/ask', async () => {
  const actual = await vi.importActual<typeof import('../../store/ask')>('../../store/ask')
  return { ...actual, useAskStore: await bridged(actual.useAskStore) }
})

const win = { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, getComputedStyle: () => ({}) }
const doc = { documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) }
vi.stubGlobal('window', win)
vi.stubGlobal('document', doc)
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
vi.stubGlobal('navigator', { userAgent: '', language: 'en-GB' })


const { useHive } = await import('../../store/store')
const { useAskStore } = await import('../../store/ask')
const { useAskField } = await import('../ask/useAskField')
const { recordDrawTurn, DRAW_ASK_BUSY, DRAW_ASK_SLOW, DRAW_NEEDS_WORDS } = await import('./store')
type AskBody = import('../../api/ask').AskBody
type HiveClient = import('../../api/client').HiveClient

interface Mounted { readonly tree: unknown; settle(): void; unmount(): void }
function mount(component: () => unknown): Mounted {
  const own = { slots: [] as unknown[], effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[], dirty: true }
  let tree: unknown
  const render = () => {
    own.dirty = false; R.own = own; R.i = R.ei = 0; R.pending = []
    tree = component()
    const pending = R.pending; R.pending = []; pending.forEach((f) => f())
  }
  const settle = () => { for (let i = 0; own.dirty && i < 20; i++) render(); expect(own.dirty, 'settled').toBe(false) }
  const out = { get tree() { return tree }, settle, unmount: () => own.effects.forEach((e) => typeof e?.cleanup === 'function' && (e.cleanup as () => void)()) }
  mounted.push(out); settle(); return out
}
let mounted: Mounted[] = []
const flush = async () => { for (let k = 0; k < 30; k++) await Promise.resolve() }


const C = { id: 'a_own', name: 'Ember', swarm_id: 's_own', status: 'awake' }
const eligible = [{ id: 's_own', name: 'Your mind', orchestrator: { id: C.id, name: C.name } }]
let posts: AskBody[] = []
/** each request waits until the test answers it (answer()), or forever (a stalled send) */
let waiting: { body: AskBody; release: () => void }[] = []
let n = 0
function host(): HiveClient {
  const view = (b: AskBody) => ({ operation_id: b.operation_id, turn_id: `t_${b.operation_id}`, thread: { id: 'th_own', mind: { id: C.id, name: C.name }, budget_usd: 5, spent_usd: 0 }, state: 'accepted' as const, events: [], more: false })
  return {
    mode: 'live',
    ask: vi.fn((b: AskBody) => { posts.push(structuredClone(b)); return new Promise((res) => waiting.push({ body: b, release: () => res(view(b)) })) }),
    askTurn: vi.fn(async () => { throw new Error('not read in this test') }),
    askSettings: vi.fn(async () => useAskStore.getState().settings),
  } as unknown as HiveClient
}
const answer = async () => { const w = waiting.shift()!; w.release(); await flush() }
beforeEach(() => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  posts = []; waiting = []
  useHive.setState({
    client: host(), session: `draw-${++n}`, inits: 2000 + n,
    swarms: { s_own: { id: 's_own', name: 'Your mind', description: '', hue: 0, member_ids: [], created_at: '', coordinator_id: C.id } } as never,
    agents: { a_own: C } as never,
    programs: [{ id: 'omegadesign', name: 'Create' }] as never,
  })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_invented')
  useAskStore.setState({ settings: { swarm_id: 's_own', thread_budget_usd: 5, eligible }, personal: C as never })
})
afterEach(() => {
  mounted.reverse().forEach((m) => m.unmount())
  mounted = []
  useAskStore.getState().reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const field = () => { const m = mount(() => useAskField({ experience: 'classic' })); return { m, type: (w: string) => { (m.tree as ReturnType<typeof useAskField>).change(w); m.settle() } } }
/** an earlier request on this page, answered and finished */
async function history(words: string) {
  const p = useAskStore.getState().send(words, { route: 'programs/omegadesign', experience: 'classic', program: 'omegadesign', swarm_id: 's_own' })
  await flush(); await answer(); await p
  useAskStore.setState({ open: null })
}

describe('Draw live from the mounted Ask field', () => {
  it('typed words win over an earlier turn: "a boat" is asked and becomes the drawing, not the earlier "a fox"', async () => {
    await history('a fox')
    const f = field(); f.type('a boat')
    const r = recordDrawTurn({ alive: () => true })
    await flush(); await answer()
    const got = await r
    expect('turn' in got && got.turn.title).toBe('a boat')
    expect(posts).toHaveLength(2)
    expect('turn' in got && got.turn.operation_id).toBe(posts[1].operation_id)
  })

  it('an empty Ask uses the turn already recorded; nothing new is asked', async () => {
    await history('a fox')
    field()
    const got = await recordDrawTurn({ alive: () => true })
    expect('turn' in got && got.turn.title).toBe('a fox')
    expect(posts).toHaveLength(1)
  })

  it('nothing typed and nothing recorded: says what to do, asks nothing', async () => {
    field()
    expect(await recordDrawTurn({ alive: () => true })).toEqual({ reason: DRAW_NEEDS_WORDS })
    expect(posts).toHaveLength(0)
  })

  it('an identity change while the request is in flight cancels it; a same-text turn of the new person never satisfies it', async () => {
    const f = field(); f.type('a fox')
    const r = recordDrawTurn({ alive: () => true })
    await flush()
    useHive.setState({ session: 'someone-else' })          // a different person on this page
    useAskStore.getState().bind('someone-else', 'user:p_other')
    await answer()
    expect(await r).toEqual({ cancelled: true })
  })

  it('another person pressing while an earlier press is still pending gets their own request, not the earlier one', async () => {
    const f = field(); f.type('a fox')
    const first = recordDrawTurn({ alive: () => true })
    await flush()
    useHive.setState({ session: 'someone-else' })
    useAskStore.getState().bind('someone-else', 'user:p_other')
    expect(await first).toEqual({ cancelled: true })        // at once, on the identity change
    const g = field(); g.type('a boat')
    const second = recordDrawTurn({ alive: () => true })
    expect(second).not.toBe(first)
  })

  it('a new Ask thread while in flight cancels it', async () => {
    const f = field(); f.type('a fox')
    const r = recordDrawTurn({ alive: () => true })
    await flush()
    useAskStore.getState().reset()
    expect(await r).toEqual({ cancelled: true })
  })

  it('a stalled send gives up on time (the deadline starts before sending); nothing is drawn', async () => {
    const f = field(); f.type('a fox')
    const got = await recordDrawTurn({ alive: () => true, timeoutMs: 40 })
    expect(got).toEqual({ reason: DRAW_ASK_SLOW })
    expect(posts).toHaveLength(1)                          // sent once, never answered
  })

  it('leaving the page cancels, and a late answer opens nothing', async () => {
    const f = field(); f.type('a fox')
    const ctl = new AbortController()
    const r = recordDrawTurn({ alive: () => true, signal: ctl.signal })
    await flush()
    ctl.abort()
    expect(await r).toEqual({ cancelled: true })
    await answer()                                         // the late answer
    expect(posts).toHaveLength(1)
  })

  it('the page gone (alive false) cancels at the next change', async () => {
    const f = field(); f.type('a fox')
    let alive = true
    const r = recordDrawTurn({ alive: () => alive })
    await flush()
    alive = false
    await answer()
    expect(await r).toEqual({ cancelled: true })
  })

  it('a second press while the first is in flight joins it: one request, one answer', async () => {
    const f = field(); f.type('a fox')
    const a = recordDrawTurn({ alive: () => true }), b = recordDrawTurn({ alive: () => true })
    expect(a).toBe(b)
    await flush(); await answer()
    expect(posts).toHaveLength(1)
    expect('turn' in (await a)).toBe(true)
  })

  it('with a turn still open, the words would steer it: Draw live says so and sends nothing', async () => {
    const f = field(); f.type('a fox')
    useAskStore.setState({ open: 'op_running' } as never)
    expect(await recordDrawTurn({ alive: () => true })).toEqual({ reason: DRAW_ASK_BUSY })
    expect(posts).toHaveLength(0)
  })
})
