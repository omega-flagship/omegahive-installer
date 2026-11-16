import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * j0-fixes r1 item 1, MOUNTED (the brief's acceptance): a thread answering through mind A → close it → choose B under
 * Change → the paid row the person sees AND the context actually sent both say B. The shared Ask hook runs under the
 * repo's controlled React stand-in (the enterHandlers / dualP2 pattern), against the real hive store and the real Ask
 * store; the host is a synthetic client that records each request body. INVENTED minds and swarms; nothing leaves.
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
const { askOrigin, useAskStore } = await import('../../store/ask')
const { answererChoice } = await import('./answererChoice')
const { useAskField, restoreAskDraft } = await import('./useAskField')
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

// mind A answers through a coordinator-less swarm (Studio's); B is another swarm's coordinator; the person's own is C
const A = { id: 'a_maker', name: 'Studio Maker', swarm_id: 's_studio', status: 'awake' }
const B = { id: 'a_kelp', name: 'Kelp Keeper', swarm_id: 's_kelp', status: 'awake' }
const C = { id: 'a_own', name: 'Ember', swarm_id: 's_own', status: 'awake' }
const eligible = [{ id: 's_kelp', name: 'Kelp Commons', orchestrator: { id: B.id, name: B.name } }, { id: 's_own', name: 'Your mind', orchestrator: { id: C.id, name: C.name } }]
let posts: AskBody[] = []
let n = 0
function host(): HiveClient {
  const view = (b: AskBody, mind: { id: string; name: string }) => ({ operation_id: b.operation_id, turn_id: `t_${b.operation_id}`, thread: { id: `th_${mind.id}`, mind: { id: mind.id, name: mind.name }, budget_usd: 5, spent_usd: 0 }, state: 'accepted' as const, events: [], more: false })
  return {
    mode: 'sim',
    ask: vi.fn(async (b: AskBody) => {
      posts.push(structuredClone(b))
      const c = b.context as { mind?: string; swarm_id?: string }
      return view(b, c.mind === A.id ? A : c.swarm_id === 's_kelp' ? B : C)
    }),
    askTurn: vi.fn(async () => { throw new Error('not read in this test') }),
    askSettings: vi.fn(async () => useAskStore.getState().settings),
    setAskSettings: vi.fn(async (b: { swarm_id?: string | null }) => ({ ...useAskStore.getState().settings!, ...('swarm_id' in b ? { swarm_id: b.swarm_id ?? null } : {}) })),
  } as unknown as HiveClient
}
let clock = 1_000_000
beforeEach(() => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  posts = []
  useHive.setState({
    client: host(), session: `j0-${++n}`, inits: 1000 + n,
    swarms: { s_studio: { id: 's_studio', name: 'Studio swarm', description: '', hue: 0, member_ids: [], created_at: '', coordinator_id: null }, s_kelp: { id: 's_kelp', name: 'Kelp Commons', description: '', hue: 0, member_ids: [], created_at: '', coordinator_id: B.id }, s_own: { id: 's_own', name: 'Your mind', description: '', hue: 0, member_ids: [], created_at: '', coordinator_id: C.id } } as never,
    agents: { a_maker: A, a_kelp: B, a_own: C } as never,
    programs: [{ id: 'omegadesign', name: 'OmegaDesign' }] as never,
  })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_invented')
  useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 5, eligible }, personal: C as never })
})
afterEach(() => {
  mounted.reverse().forEach((m) => m.unmount())
  mounted = []
  useAskStore.getState().reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A first request from Studio's page: answered through mind A (its swarm has no coordinator); the turn then ends. */
async function threadWithA() {
  await useAskStore.getState().send('Make a poster', { route: 'programs/omegadesign', experience: 'classic', program: 'omegadesign', swarm_id: 's_studio' })
  await flush()
  expect(posts.at(-1)!.context).toMatchObject({ mind: A.id })
  useAskStore.setState({ open: null })
}
const rowWords = (f: ReturnType<typeof useAskField>) => f.list.find((c) => c.key === 'mind')?.parts.map((p) => p.t).join('') ?? ''
async function typeAndSend(m: Mounted, words: string) {
  const f = () => m.tree as ReturnType<typeof useAskField>
  f().change(words); m.settle()
  f().declareSeen({ rows: true, panel: false })
  clock += 10_000
  const row = rowWords(f())
  await f().submit(); await flush(); m.settle()
  return row
}

describe('thread with mind A → close → choose B: the row and the sent context both say B', () => {
  it('the mounted Ask hook, end to end', async () => {
    await threadWithA()
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    // while the thread shows, a plain follow-up continues A, and every surface says A
    f().change('and a smaller date'); m.settle()
    expect(rowWords(f())).toMatch(/^Ask Studio Maker: /)
    expect(f().chip).toEqual({ kind: 'thread', name: 'Studio Maker' })
    f().change(''); m.settle()
    // close the thread, then choose B under Change
    useAskStore.getState().setThreadOpen(false); m.settle()
    expect(await useAskStore.getState().chooseAnswerer('s_kelp')).toBe('saved')
    m.settle()
    const row = await typeAndSend(m, 'what is on today')
    expect(row).toMatch(/^Ask Kelp Keeper: what is on today/)
    expect(posts).toHaveLength(2)
    expect(posts[1].context).toMatchObject({ swarm_id: 's_kelp' })
    expect(posts[1].context).not.toHaveProperty('mind')
  })
  it('choosing B while the thread still shows: the explicit choice beats continuity, in the row and the request', async () => {
    await threadWithA()
    const m = mount(() => useAskField({ experience: 'classic' }))
    expect(await useAskStore.getState().chooseAnswerer('s_kelp')).toBe('saved')
    m.settle()
    const row = await typeAndSend(m, 'what is on today')
    expect(row).toMatch(/^Ask Kelp Keeper: /)
    expect(posts[1].context).toMatchObject({ swarm_id: 's_kelp' })
    expect(posts[1].context).not.toHaveProperty('mind')
  })
  it('closing alone (no choice): the person’s own mind, named by the chip and the row, gets the request; A is not sent', async () => {
    await threadWithA()
    const m = mount(() => useAskField({ experience: 'classic' }))
    useAskStore.getState().setThreadOpen(false); m.settle()
    expect(m.tree && (m.tree as ReturnType<typeof useAskField>).chip).toMatchObject({ kind: 'personal', name: 'Ember' })
    const row = await typeAndSend(m, 'what is on today')
    expect(row).toMatch(/^Ask Ember: /)
    expect(posts[1].context).not.toHaveProperty('mind')
    expect(posts[1].context).not.toHaveProperty('swarm_id')
  })
  it('a turn in flight keeps its deliberate steering: a choice saved mid-turn does not retarget it', async () => {
    await useAskStore.getState().send('Make a poster', { route: 'programs/omegadesign', experience: 'classic', program: 'omegadesign', swarm_id: 's_studio' })
    await flush()
    expect(useAskStore.getState().open).not.toBeNull()
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    expect(await useAskStore.getState().chooseAnswerer('s_kelp')).toBe('saved')
    m.settle()
    f().change('make the date bigger'); m.settle()
    const row = f().list[0]
    expect(row.key).toBe('steer')
    expect(row.parts.map((p) => p.t).join('')).toBe('Tell Studio Maker now: make the date bigger')
    expect(row.pays).toBe('Paid by you · this thread has used $0.00 of $5.00 · no estimate before it starts')
  })
  it('r1.5 (stand-in r1.4 P1, behavioural): typing another mind’s name while A answers: row, chip and send all name A', async () => {
    await useAskStore.getState().send('Make a poster', { route: 'programs/omegadesign', experience: 'classic', program: 'omegadesign', swarm_id: 's_studio' })
    await flush()
    const open = useAskStore.getState().open
    expect(open).not.toBeNull()
    const steer = vi.spyOn(useAskStore.getState(), 'steer').mockResolvedValue(undefined as never)
    const send = vi.spyOn(useAskStore.getState(), 'send')
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    f().change(`ask ${B.name} to make the date bigger`); m.settle()
    const row = f().list[0]
    expect(row.key).toBe('steer')
    expect(row.parts.map((p) => p.t).join('')).toContain(A.name)
    expect(row.parts.map((p) => p.t).join('')).not.toContain(`Tell ${B.name}`)
    expect(f().answerer).toBe(A.name)
    f().declareSeen({ rows: true, panel: false }); clock += 10_000
    await f().submit(); await flush()
    expect(steer).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('r1.6: two minds named "Ember" (the person\'s own, and another swarm\'s coordinator): choosing the other is not "you"', async () => {
    useHive.setState({ agents: { ...useHive.getState().agents, a_kelp: { ...B, name: C.name } } as never })
    expect(await useAskStore.getState().chooseAnswerer('s_kelp')).toBe('saved')
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    f().change('what is on today'); m.settle()
    expect(f().answererId).toBe(B.id)
    expect(f().answeringYou).toBe(false)
    expect(f().answerer).toBe(C.name)          // same display name, different mind
    const row = await typeAndSend(m, 'a small poem')
    expect(row).toContain(C.name)
    expect(posts.at(-1)!.context).toMatchObject({ swarm_id: 's_kelp' })
  })
  it('r1.6: with no swarm chosen the person\'s own mind answers, and that IS "you" (by id)', async () => {
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    f().change('what is on today'); m.settle()
    expect(f().answererId).toBe(C.id)
    expect(f().answeringYou).toBe(true)
  })
  it('another person signing in inherits no carried mind', async () => {
    await threadWithA()
    useAskStore.setState({ threadOpen: true })
    expect(useAskStore.getState().carry).toEqual({ mind: A.id, swarm: 's_studio' })
    useAskStore.getState().bind(`j0-other-${n}`, 'user:p_other_invented')
    expect(useAskStore.getState().carry).toBeNull()
    expect(useAskStore.getState().thread).toBeNull()
  })
  it('the paid row says who pays and the limit, with no invented estimate', async () => {
    await threadWithA()
    const m = mount(() => useAskField({ experience: 'classic' }))
    useAskStore.getState().setThreadOpen(false); m.settle()
    const f = () => m.tree as ReturnType<typeof useAskField>
    f().change('what is on today'); m.settle()
    expect(f().list.find((c) => c.key === 'mind')?.pays).toBe('Paid by you · a new thread may spend up to $5.00 · no estimate before it starts')
  })
})

describe('item 2: a Studio starter fills the Ask and never sends', () => {
  it('fills editable words; nothing is sent until the person sends; typed words are kept unless replaced', async () => {
    const { fillAsk } = await import('./useAskField')
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    expect(fillAsk('Make a poster inviting neighbours')).toBe('filled')
    m.settle(); await flush()
    expect(f().value).toBe('Make a poster inviting neighbours')
    expect(posts).toHaveLength(0)
    // the person edits it; a second starter does not overwrite their words
    f().change('Make a poster for the spring picnic'); m.settle()
    expect(fillAsk('Make a warm invitation card')).toBe('kept')
    m.settle()
    expect(f().value).toBe('Make a poster for the spring picnic')
    expect(fillAsk('Make a warm invitation card', { replace: true })).toBe('filled')
    m.settle()
    expect(f().value).toBe('Make a warm invitation card')
    expect(posts).toHaveLength(0)
    // the deliberate send goes through the guarded Ask: the paid row is the one taken
    f().declareSeen({ rows: true, panel: false })
    clock += 10_000
    expect(f().list[0]).toMatchObject({ key: 'mind' })
    expect(f().list[0].pays).toMatch(/^Paid by you/)
    await f().submit(); await flush()
    expect(posts.map((p) => p.text)).toEqual(['Make a warm invitation card'])
  })
  it('filled words are not the person’s typing: a paid row they bring waits out the arming window', async () => {
    const { fillAsk } = await import('./useAskField')
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    fillAsk('Make a poster inviting neighbours'); m.settle()
    f().declareSeen({ rows: true, panel: false })
    await f().submit(); await flush()
    expect(posts).toHaveLength(0) // the row just appeared under words nobody typed: read it first
    clock += 10_000
    await f().submit(); await flush()
    expect(posts).toHaveLength(1)
  })
  it('no Ask field mounted: nothing filled, nothing sent', async () => {
    const { fillAsk } = await import('./useAskField')
    expect(fillAsk('Make a poster')).toBe('none')
    expect(posts).toHaveLength(0)
  })
})

describe('wake retry restored-draft ownership', () => {
  it('clears an unchanged restoration on retry dispatch and never clears an edited draft', () => {
    const m = mount(() => useAskField({ experience: 'classic' }))
    const field = () => m.tree as ReturnType<typeof useAskField>
    const clearRestored = restoreAskDraft('Read the note', 'classic')!
    m.settle(); expect(field().value).toBe('Read the note')
    clearRestored(); m.settle(); expect(field().value).toBe('')
    const clearEdited = restoreAskDraft('Read the note', 'classic')!
    m.settle()
    field().change('A new question'); m.settle()
    clearEdited(); m.settle(); expect(field().value).toBe('A new question')
    // Even editing back to identical text is a new person-owned draft.
    field().change('Read the note'); m.settle()
    clearEdited(); m.settle(); expect(field().value).toBe('Read the note')
    expect(restoreAskDraft('Must not replace this', 'classic')).toBeNull()
  })
  it('a restoration cleanup retained across an identity change cannot clear the next person’s draft', () => {
    const m = mount(() => useAskField({ experience: 'classic' }))
    const field = () => m.tree as ReturnType<typeof useAskField>
    const cleanup = restoreAskDraft('Earlier private words', 'classic')!
    m.settle()
    useHive.setState({ session: 'another-person-session', inits: 9001 })
    m.settle()
    expect(field().value).toBe('')
    field().change('Next person’s question'); m.settle()
    cleanup(); m.settle(); expect(field().value).toBe('Next person’s question')
  })
})

it('restored words leave the thread Retry reachable; deliberate Enter uses that same choice instead of a fresh Ask', async () => {
  const m = mount(() => useAskField({ experience: 'classic' }))
  const field = () => m.tree as ReturnType<typeof useAskField>
  const retry = vi.fn(async () => {})
  restoreAskDraft('Read the note', 'classic', retry)
  m.settle()
  expect(field().list).toEqual([])
  await field().submit({ quiet: true })
  expect(retry).not.toHaveBeenCalled()
  await field().submit()
  expect(retry).toHaveBeenCalledTimes(1)
  expect(posts).toHaveLength(0)
  field().change('A newly edited question'); m.settle()
  expect(field().list.length).toBeGreaterThan(0)
})

it('pre-admission composer copy stays quiet for 400ms, then says waking rather than reading', async () => {
  vi.useFakeTimers()
  try {
    let awake = false
    let finish!: () => void
    const wait = new Promise<void>((resolve) => { finish = () => { awake = true; resolve() } })
    const agent = async () => ({ ...C, kind: 'omega', status: awake ? 'awake' : 'asleep', is_mine: true, may_sleep: true })
    const client = Object.assign(host(), {
      me: async () => ({ principal: 'user:p_invented', role: 'member' }),
      myMind: async () => ({ mind: C }), getAgent: agent,
      getSwarm: async () => ({ id: C.swarm_id, coordinator_id: C.id, owner: 'user:p_invented' }),
      agentAction: async () => { await wait; return agent() },
    })
    useHive.setState({ client: client as HiveClient })
    useAskStore.getState().bind(useHive.getState().session, 'user:p_invented')
    useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 5, eligible }, personal: C as never })
    const m = mount(() => useAskField({ experience: 'classic' }))
    const field = () => m.tree as ReturnType<typeof useAskField>
    const sent = useAskStore.getState().send('Read the note', { route: 'hive', experience: 'classic' })
    await flush(); m.settle()
    expect(field().step).toBe('preparing')
    expect(posts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(399); m.settle()
    expect(field().waking).toBe(false)
    await vi.advanceTimersByTimeAsync(1); m.settle()
    expect(field().step).toBe('waking')
    expect(field().waking).toBe(true)
    expect(posts).toHaveLength(0)
    finish(); await sent; m.settle()
    expect(posts).toHaveLength(1)
    expect(field().waking).toBe(false)
  } finally { vi.useRealTimers() }
})

it('a local choice names the paid row, but never leaves its chip over a later typed address', () => {
  const m = mount(() => useAskField({ experience: 'classic' }))
  const f = () => m.tree as ReturnType<typeof useAskField>
  answererChoice.select({ kind: 'swarm', swarm: 's_kelp', name: 'Kelp Commons' }, askOrigin().ok)
  m.settle()
  f().change('what is on today'); m.settle()
  expect(f().chip).toEqual({ kind: 'thread', name: 'Kelp Commons' })
  expect(rowWords(f())).toContain('Kelp Keeper')
  f().change('ask Ember to read this note'); m.settle()
  expect(f().chip).not.toEqual({ kind: 'thread', name: 'Kelp Commons' })
  expect(f().answerer).toBe('Ember')
  expect(answererChoice.get()).toMatchObject({ kind: 'swarm', swarm: 's_kelp' })
})

it('an outgoing native chooser trigger cannot acquire the next credential’s Ask origin', async () => {
  vi.stubGlobal('requestAnimationFrame', win.requestAnimationFrame)
  const { AnswererInline, AnswererChipButton } = await import('./AnswererPicker')
  let credential = {}
  const client = useHive.getState().client!
  Object.assign(client, { authContext: () => credential })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_invented')
  useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 5, eligible }, personal: C as never })
  type El = { type: unknown; props: Record<string, unknown> }
  const elements = (tree: unknown): El[] => {
    if (Array.isArray(tree)) return tree.flatMap(elements)
    if (!tree || typeof tree !== 'object' || !('props' in tree)) return []
    const el = tree as El
    return [el, ...elements(el.props.children)]
  }
  const shell = mount(() => AnswererInline({ chip: { kind: 'personal', name: C.name, resting: false }, answering: false, look: 'construct' }))
  const child = shell.tree as El
  const chooser = mount(() => (child.type as (p: Record<string, unknown>) => unknown)(child.props))
  const oldTrigger = elements(chooser.tree).find((el) => el.type === AnswererChipButton)!.props.onToggle as () => void
  credential = {}
  useAskStore.getState().bind(useHive.getState().session, 'user:next_invented')
  oldTrigger(); chooser.settle()
  expect(elements(chooser.tree).some((el) => el.props.className === 'ask-answerer-pop')).toBe(false)
  expect(client.setAskSettings).not.toHaveBeenCalled()
  expect(posts).toHaveLength(0)
})

it('a Still field handover preserves an unsent starter and re-arms its newly shown paid row', async () => {
  const { useDraft } = await import('../../experiences/drafts')
  const { fillAsk } = await import('./useAskField')
  const paper = mount(() => useAskField({ experience: 'still', draft: useDraft('still:ask') }))
  expect(fillAsk('Make a poster inviting neighbours', { experience: 'still' })).toBe('filled')
  paper.settle()
  expect((paper.tree as ReturnType<typeof useAskField>).value).toBe('Make a poster inviting neighbours')
  paper.unmount()
  const floating = mount(() => useAskField({ experience: 'still', draft: useDraft('still:ask') }))
  const field = () => floating.tree as ReturnType<typeof useAskField>
  expect(field().value).toBe('Make a poster inviting neighbours')
  field().declareSeen({ rows: true, panel: false })
  await field().submit(); await flush()
  expect(posts).toHaveLength(0)
  clock += 10_000
  await field().submit(); await flush()
  expect(posts.map(p => p.text)).toEqual(['Make a poster inviting neighbours'])
})

it('returning to the retained paper re-arms words filled through the fallback', async () => {
  const { useState } = await import('react')
  const { useDraft } = await import('../../experiences/drafts')
  const { fillAsk } = await import('./useAskField')
  let setPaperActive!: (v: boolean) => void
  const paper = mount(() => {
    const [active, setActive] = useState(true)
    setPaperActive = setActive
    return useAskField({ experience: 'still', draft: useDraft('still:ask'), active })
  })
  fillAsk('Make a poster inviting neighbours', { experience: 'still' }); paper.settle()
  clock += 10_000
  setPaperActive(false); paper.settle()
  expect(fillAsk('An inactive field cannot receive words', { experience: 'still' })).toBe('none')
  const hidden = paper.tree as ReturnType<typeof useAskField>
  hidden.declareSeen({ rows: true, panel: false })
  await hidden.submit(); await flush()
  expect(posts).toHaveLength(0)
  const floating = mount(() => useAskField({ experience: 'still', draft: useDraft('still:ask') }))
  fillAsk('Make a warmer invitation card', { experience: 'still', replace: true })
  paper.settle(); floating.settle()
  clock += 10_000
  floating.unmount()
  setPaperActive(true); paper.settle()
  const field = () => paper.tree as ReturnType<typeof useAskField>
  expect(field().value).toBe('Make a warmer invitation card')
  field().declareSeen({ rows: true, panel: false })
  await field().submit(); await flush()
  expect(posts).toHaveLength(0)
  clock += 10_000
  await field().submit(); await flush()
  expect(posts.map(p => p.text)).toEqual(['Make a warmer invitation card'])
})

it('late words from the yielding presentation re-arm the already mounted shared receiver', async () => {
  const { useDraft } = await import('../../experiences/drafts')
  const paper = mount(() => useAskField({ experience: 'still', draft: useDraft('still:ask'), active: false }))
  const floating = mount(() => useAskField({ experience: 'still', draft: useDraft('still:ask') }))
  // A final recognition result can arrive while the old voice controller is stopping. The words stay editable.
  ;(paper.tree as ReturnType<typeof useAskField>).voiceText('Make a poster inviting neighbours')
  paper.settle(); floating.settle()
  const field = () => floating.tree as ReturnType<typeof useAskField>
  expect(field().value).toBe('Make a poster inviting neighbours')
  field().declareSeen({ rows: true, panel: false })
  await field().submit(); await flush()
  expect(posts).toHaveLength(0)
  clock += 10_000
  await field().submit(); await flush()
  expect(posts.map(p => p.text)).toEqual(['Make a poster inviting neighbours'])
})

it.each(['submit', 'take', 'run'] as const)('a retained %s closure loses authority across native/floating handover and unmount', async kind => {
  const { useState } = await import('react')
  const { useDraft } = await import('../../experiences/drafts')
  const { fillAsk } = await import('./useAskField')
  let setNative!: (active: boolean) => void
  const native = mount(() => {
    const [active, setActive] = useState(true); setNative = setActive
    return useAskField({ experience: 'construct', draft: useDraft('construct:ask'), active })
  })
  const value = 'Explain this invented onboarding message'
  fillAsk(value, { experience: 'construct' }); native.settle(); clock += 10_000
  const capture = (field: ReturnType<typeof useAskField>) => {
    field.declareSeen({ rows: true, panel: false })
    const paid = field.list.find(c => c.act?.do === 'mind')
    expect(paid).toBeDefined()
    return () => kind === 'submit' ? field.submit() : kind === 'take' ? field.take(paid) : field.run({ do: 'mind', text: field.value }, field.value)
  }
  const oldNative = capture(native.tree as ReturnType<typeof useAskField>)
  setNative(false); native.settle()
  const floating = mount(() => useAskField({ experience: 'construct', draft: useDraft('construct:ask') }))
  clock += 10_000
  const oldFloating = capture(floating.tree as ReturnType<typeof useAskField>)
  await oldNative(); await flush()
  expect(posts, 'yielded native closure cannot spend').toEqual([])
  floating.unmount(); setNative(true); native.settle(); clock += 10_000
  ;(native.tree as ReturnType<typeof useAskField>).declareSeen({ rows: true, panel: false })
  await oldNative(); await oldFloating(); await flush()
  expect(posts, 'reactivation never revives an earlier closure; the unmounted fallback remains disarmed').toEqual([])
  expect((native.tree as ReturnType<typeof useAskField>).value).toBe(value)
})
