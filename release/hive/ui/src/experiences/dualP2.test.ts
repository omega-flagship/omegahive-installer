import { afterEach, describe, expect, it, vi } from 'vitest'

// followups-r8 (P3): every test here signs a synthetic person in on a fresh simulated hive (identityEpoch.testkit,
// 1-1.5 s each on an idle machine) and drives the actual experiences through the controlled renderer: worst 26153 ms
// measured with six other heavy files in parallel (load 7-8.5), over vitest's 5 s default. A measured, bounded per-file
// timeout, listed in api/sim/simTimeouts.test.ts like the other heavy files.
vi.setConfig({ testTimeout: 78000 })

// Native Vitest source recipe, NOT RUN by the source author. The repo's existing mounted stand-in pattern
// (construct/askCustody.test.ts) exercises the actual components and real Hive/identity/view stores. This variant
// schedules a render only when a state setter changes value (Object.is), so unchanged navigation cannot hide the P2.
// It is not a browser/React scheduling, layout, accessibility or movement qualification. All people/text are synthetic.
const R = vi.hoisted(() => ({ own: null as null | { slots: unknown[]; effects: ({ deps?: unknown[]; cleanup?: unknown } | undefined)[]; dirty: boolean }, i: 0, ei: 0, pending: [] as (() => void)[], ids: 0, admin: false }))
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
    useId: () => R.own!.slots[slot(() => `:dual${++R.ids}:`)],
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
        changed() // retain a store change between the rendered read and subscription
        return off
      }, [subscribe])
      return snapshot.value
    }, useDebugValue: () => undefined,
    useContext: (c: { _currentValue?: unknown }) => c._currentValue, useEffect: effect, useLayoutEffect: effect,
  }
  return { ...m, default: m }
})
vi.mock('../store/store', async () => {
  const actual = await vi.importActual<typeof import('../store/store')>('../store/store')
  return { ...actual, useHive: Object.assign((sel?: (s: ReturnType<typeof actual.useHive.getState>) => unknown) => sel ? sel(actual.useHive.getState()) : actual.useHive.getState(), actual.useHive) }
})
// External Zustand's React binding does not share the controlled renderer's module graph. Bridge only its hook
// to the declared stand-in: selectors, getState/setState/subscribe and every native Ask action remain the real store.
vi.mock('../store/ask', async () => {
  const actual = await vi.importActual<typeof import('../store/ask')>('../store/ask')
  const { useSyncExternalStore } = await import('react')
  const useAskStore = Object.assign((sel?: (s: ReturnType<typeof actual.useAskStore.getState>) => unknown) => {
    const read = () => sel ? sel(actual.useAskStore.getState()) : actual.useAskStore.getState()
    return useSyncExternalStore(actual.useAskStore.subscribe, read, read)
  }, actual.useAskStore)
  return { ...actual, useAskStore }
})
// Read-only self/viewport hooks and local walking are leaf presentation stand-ins; no identity or dispatch gate is mocked.
vi.mock('./sdk', async (orig) => ({ ...(await orig<typeof import('./sdk')>()),
  useMe: () => ({ me: R.admin ? { principal: 'user:operator', kind: 'password', role: 'admin' } : undefined, loaded: R.admin, admin: R.admin }),
  useAdminView: () => ({ me: undefined, loaded: false, adminView: R.admin }),
  useReducedMotion: () => true, useRoomyLayout: () => false,
  useResting: (sel: (s: { resting: boolean }) => unknown) => sel({ resting: false }),
}))
const W = vi.hoisted(() => ({ stop: vi.fn(), walkTo: vi.fn(() => true) }))
vi.mock('./omegatown/movement', () => ({ useWalking: () => W }))
const win = { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout }
vi.stubGlobal('window', win)
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })

const { useHive } = await import('../store/store')
const { currentView } = await import('../features/ask/view')
const { currentEpoch } = await import('../lib/identityEpoch')
const { testPerson, signInAs, switchPerson, releasePersons } = await import('../lib/identityEpoch.testkit')
const { default: OmegaTown } = await import('./omegatown')
const { default: Professional } = await import('./professional')
const townBinding = await import('./omegatown/binding')
const professionalBinding = await import('./professional/binding')
const { Conversation, MindControls } = await import('./professional/Conversation')
type Agent = import('../api/types').Agent
interface El { type: unknown; key?: string | null; props: Record<string, unknown> }
const isEl = (x: unknown): x is El => !!x && typeof x === 'object' && 'type' in x && 'props' in x
function find(x: unknown, f: (e: El) => boolean): El[] {
  if (Array.isArray(x)) return x.flatMap((n) => find(n, f))
  if (!isEl(x)) return []
  return [...(f(x) ? [x] : []), ...find(x.props.children, f)]
}
const text = (x: unknown): string => typeof x === 'string' || typeof x === 'number' ? String(x) : Array.isArray(x) ? x.map(text).join('') : isEl(x) ? text(x.props.children) : ''
const call = (e: El, name = 'onClick', event?: unknown) => (e.props[name] as (e?: unknown) => unknown)(event)
const button = (tree: unknown, label: string) => {
  const matches = find(tree, (e) => e.type === 'button' && text(e) === label)
  expect(matches.length, label).toBeGreaterThan(0)
  return matches[0]
}
function attachRefs(tree: unknown) {
  for (const e of find(tree, () => true)) {
    const ref = e.props.ref as { current?: unknown } | undefined
    if (typeof e.type === 'string' && ref && typeof ref === 'object' && ref.current == null)
      ref.current = { isConnected: true, inert: false, closest(this: { inert: boolean }) { return this.inert ? this : null }, focus() {}, querySelector() { return null } }
  }
}
interface Mounted { readonly tree: unknown; readonly renders: number; settle(): void; render(): void; unmount(): void }
function mount(component: () => unknown): Mounted {
  const own = { slots: [] as unknown[], effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[], dirty: true }
  let tree: unknown, renders = 0
  const render = () => {
    own.dirty = false; R.own = own; R.i = R.ei = 0; R.pending = []
    tree = component(); renders++; attachRefs(tree)
    const pending = R.pending; R.pending = []; pending.forEach((f) => f())
  }
  const settle = () => { for (let i = 0; own.dirty && i < 20; i++) render(); expect(own.dirty, 'bounded mounted stand-in settled').toBe(false) }
  const out = { get tree() { return tree }, get renders() { return renders }, settle, render,
    unmount: () => own.effects.forEach((e) => typeof e?.cleanup === 'function' && (e.cleanup as () => void)()),
  }
  mounted.push(out); settle(); return out
}
let mounted: Mounted[] = []
const savedActions = { sendMessage: useHive.getState().sendMessage, retryMessage: useHive.getState().retryMessage, loadMessages: useHive.getState().loadMessages, agentAction: useHive.getState().agentAction }
afterEach(() => { mounted.reverse().forEach((m) => m.unmount()); mounted = []; useHive.setState(savedActions); releasePersons(); vi.restoreAllMocks() })
function experience(root: () => unknown) {
  const entry = mount(root), child = entry.tree as El
  expect(typeof child.type).toBe('function')
  return { key: child.key, view: mount(() => (child.type as (p: Record<string, unknown>) => unknown)(child.props)) }
}
async function person(name = 'a') {
  const p = testPerson(name); await signInAs(p)
  const existing = Object.values(useHive.getState().agents)[0]
  expect(existing).toBeDefined()
  const agent: Agent = { ...existing, kind: 'omega', status: 'awake', name: 'Invented resident' }
  useHive.setState({ agents: { [agent.id]: agent }, messages: {}, messagesLoaded: { [agent.id]: true }, pending: {} })
  return { p, agent }
}

describe('stand-in P2: same local view/resident renews the actual scoped Ask export', () => {
  it.each([['Town', OmegaTown, 'Residents', 'omegatown'], ['Professional', Professional, 'Overview', 'professional']] as const)('%s: repeated current-view clicks renew after their immediate invalidation', async (_name, root, label, scope) => {
    await person()
    const { view } = experience(root)
    for (let i = 0; i < 3; i++) {
      expect(currentView()?.scope).toBe(scope)
      const before = view.renders
      call(button(view.tree, label))
      expect(currentView()).toBeNull() // retained pre-commit export is unavailable immediately
      view.settle()
      expect(view.renders).toBeGreaterThan(before) // Object.is bailout cannot leave the guard invalid indefinitely
      expect(currentView()?.scope).toBe(scope)
    }
  })
  it('Town: selecting the same exact resident repeatedly renews Ask and keeps the selected resident', async () => {
    const { agent } = await person(); const { view } = experience(OmegaTown)
    for (let i = 0; i < 3; i++) {
      const row = find(view.tree, (e) => e.type === 'button' && e.props.className === 'ot-directory-row')[0]
      call(row); expect(currentView()).toBeNull(); view.settle()
      expect(currentView()?.scope).toBe('omegatown')
      expect(text(view.tree)).toContain(agent.id)
      expect(find(view.tree, (e) => e.props.className === 'ot-selected-card')).toHaveLength(1)
    }
  })
  it('Professional: a retained same-resident selection handler renews Ask even before the row rerenders away', async () => {
    const { agent } = await person(); const { view } = experience(Professional)
    const row = find(view.tree, (e) => e.type === 'button' && e.props.className === 'pr-row-main' && text(e).includes(agent.name))[0]
    expect(row).toBeDefined()
    for (let i = 0; i < 3; i++) {
      call(row); expect(currentView()).toBeNull(); view.settle()
      expect(currentView()?.scope).toBe('professional')
      expect(currentView()?.view.refs).toEqual([{ kind: 'mind', ref: agent.id }])
    }
  })
})

describe('stand-in P2: live kind and exact canonical identity at native dispatch', () => {
  it.each(['send', 'retry'] as const)('%s: a stale rendered mind handler rejects the same id after it becomes a module, before a rerender', async (action) => {
    const { agent } = await person()
    const send = vi.fn(async () => undefined), retry = vi.fn(async () => undefined)
    useHive.setState({ sendMessage: send, retryMessage: retry, pending: { [agent.id]: [{ tempId: 'p_invented', agent_id: agent.id, created_at: '2026-10-07T12:00:00Z', text: 'Invented pending words', status: 'failed', error: 'Invented refusal' }] } })
    const view = mount(() => Conversation({ agent, ctx: professionalBinding.contextOf(useHive.getState()) }))
    const field = find(view.tree, (e) => e.type === 'textarea')[0]
    call(field, 'onChange', { target: { value: 'Invented draft words' } }); view.settle()
    // uifix-r2.4: the composer's form never sends on submission; its Send button sends on its own click
    const stale = action === 'send' ? button(view.tree, 'Send message') : button(view.tree, 'Retry')
    useHive.setState({ agents: { [agent.id]: { ...agent, kind: 'module' } } })
    call(stale, 'onClick', { preventDefault() {} })
    expect(send).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled()
    view.settle(); expect(find(view.tree, (e) => e.type === 'textarea')[0].props.value).toBe('Invented draft words')
  })
  it.each(['omega', 'iter'] as const)('%s remains a native chatting mind: send and failed retry reach the exact store actions', async (kind) => {
    const { agent: original } = await person(), agent = { ...original, kind }
    const send = vi.fn(async () => undefined), retry = vi.fn(async () => undefined)
    useHive.setState({ agents: { [agent.id]: agent }, sendMessage: send, retryMessage: retry, pending: { [agent.id]: [{ tempId: 'p_invented', agent_id: agent.id, created_at: '2026-10-07T12:00:00Z', text: 'Invented pending words', status: 'failed', error: 'Invented refusal' }] } })
    const view = mount(() => Conversation({ agent, ctx: professionalBinding.contextOf(useHive.getState()) }))
    call(find(view.tree, (e) => e.type === 'textarea')[0], 'onChange', { target: { value: '  Invented draft words  ' } }); view.settle()
    // uifix-r2.4: the form never sends on submission (an implicit submit is inert); the Send button's click sends
    call(find(view.tree, (e) => e.type === 'form')[0], 'onSubmit', { preventDefault() {} })
    expect(send).not.toHaveBeenCalled()
    call(button(view.tree, 'Send message'))
    call(button(view.tree, 'Retry'))
    expect(send).toHaveBeenCalledWith(agent.id, 'Invented draft words'); expect(retry).toHaveBeenCalledWith(agent.id, 'p_invented')
  })
  it('same-client A→B→A: the old epoch/Ask/selection handlers stay invalid and the volatile remembered pose clears synchronously', async () => {
    const { p: a } = await person(), b = testPerson('b', { sameTab: a })
    const ctx = townBinding.contextOf(useHive.getState()), epoch = currentEpoch(), old = experience(OmegaTown)
    townBinding.rememberPose(ctx, { ...townBinding.START, x: 777, coat: 'violet' })
    const stale = button(old.view.tree, 'Residents')
    const done = switchPerson(a, b)
    expect(currentEpoch()).toBeGreaterThan(epoch); expect(townBinding.current(ctx)).toBe(false); expect(currentView()).toBeNull()
    expect(townBinding.restorePose(townBinding.contextOf(useHive.getState()))).toEqual(townBinding.START)
    const renders = old.view.renders; call(stale); old.view.settle(); expect(old.view.renders).toBe(renders)
    await done; await switchPerson(b, a)
    expect(townBinding.current(ctx)).toBe(false) // returning to the same person/client never revives a stale closure
    const fresh = experience(OmegaTown); expect(fresh.key).not.toBe(old.key); expect(currentView()?.scope).toBe('omegatown')
    expect(townBinding.restorePose(townBinding.contextOf(useHive.getState()))).toEqual(townBinding.START)
  })
  it('Town release: A→B→A on the shared identity epoch leaves no per-person Town state (resident, room, tab, search, pose, Ask view)', async () => {
    const { p: a, agent } = await person(), b = testPerson('b', { sameTab: a })
    const old = experience(OmegaTown), view = old.view
    call(find(view.tree, (e) => e.type === 'button' && e.props.className === 'ot-directory-row')[0]); view.settle()
    expect(find(view.tree, (e) => e.props.className === 'ot-selected-card')).toHaveLength(1)
    call(find(view.tree, (e) => e.type === 'input' && e.props.placeholder === 'Search this directory')[0], 'onChange', { target: { value: 'invented' } }); view.settle()
    call(button(view.tree, 'Work')); view.settle()
    ;(find(view.tree, (e) => e.type === TownScene)[0].props.onPlace as (id: string) => void)('hall'); view.settle()
    call(find(view.tree, (e) => e.type === 'button' && e.props['aria-label'] === 'Move right')[0]); view.settle()
    const ctxA = townBinding.contextOf(useHive.getState())
    townBinding.rememberPose(ctxA, { ...townBinding.START, x: 701, coat: 'fern' })
    expect(text(view.tree)).toContain('Motivations and Tasks')
    await switchPerson(a, b)
    expect(townBinding.current(ctxA)).toBe(false); expect(currentView()).toBeNull()
    await switchPerson(b, a)
    useHive.setState({ agents: { [agent.id]: agent } })
    const fresh = experience(OmegaTown)
    expect(fresh.key).not.toBe(old.key) // a new epoch remounts Town: React state of the earlier sign-in is gone
    const t = fresh.view.tree
    expect(find(t, (e) => e.props.className === 'ot-selected-card')).toHaveLength(0)
    expect(find(t, (e) => e.props.className === 'ot-room')).toHaveLength(0)
    expect(find(t, (e) => e.type === 'h2' && text(e) === 'Residents')).toHaveLength(1)
    expect(find(t, (e) => e.type === 'button' && e.props['aria-current'] === 'page').map(text)).toEqual(['Residents'])
    expect(find(t, (e) => e.type === 'input' && e.props.placeholder === 'Search this directory')[0].props.value).toBe('')
    expect(townBinding.restorePose(townBinding.contextOf(useHive.getState()))).toEqual(townBinding.START)
    expect(text(t)).toContain(`Position ${townBinding.START.x}, ${townBinding.START.y}`)
    expect(currentView()?.scope).toBe('omegatown')
  })
  it('same-client sign-in change rejects a retained send closure and remounts the Professional draft empty', async () => {
    const { p: a, agent } = await person(), b = testPerson('b', { sameTab: a })
    const send = vi.fn(async () => undefined); useHive.setState({ sendMessage: send })
    const ctx = professionalBinding.contextOf(useHive.getState())
    const old = mount(() => Conversation({ agent, ctx }))
    call(find(old.tree, (e) => e.type === 'textarea')[0], 'onChange', { target: { value: 'Invented A draft' } }); old.settle()
    const stale = find(old.tree, (e) => e.type === 'form')[0], keyA = experience(Professional).key
    await switchPerson(a, b)
    useHive.setState({ agents: { [agent.id]: agent } }) // deliberately same live id, so identity is the rejecting condition
    call(stale, 'onSubmit', { preventDefault() {} }); expect(send).not.toHaveBeenCalled()
    expect(experience(Professional).key).not.toBe(keyA)
    const fresh = mount(() => Conversation({ agent, ctx: professionalBinding.contextOf(useHive.getState()) }))
    expect(find(fresh.tree, (e) => e.type === 'textarea')[0].props.value).toBe('')
  })
  it('a late conversation read rejection for A cannot write after same-client B then A re-login', async () => {
    const { p: a, agent } = await person(), b = testPerson('b', { sameTab: a })
    let reject!: (e: Error) => void
    useHive.setState({ loadMessages: () => new Promise<void>((_r, j) => { reject = j }) })
    const ctx = professionalBinding.contextOf(useHive.getState()), view = mount(() => Conversation({ agent, ctx }))
    await switchPerson(a, b); await switchPerson(b, a)
    reject(new Error('Invented A late read failure')); await Promise.resolve(); await Promise.resolve(); view.settle()
    expect(text(view.tree)).not.toContain('Invented A late read failure')
  })
  it('a late lifecycle answer commits through Surface’s binding and cannot write after same-client B then A re-login', async () => {
    const { p: a, agent } = await person(), b = testPerson('b', { sameTab: a })
    let resolve!: (v: boolean) => void
    useHive.setState({ agentAction: () => new Promise<boolean>((r) => { resolve = r }) })
    const ctx = professionalBinding.contextOf(useHive.getState()), view = mount(() => MindControls({ agent, ctx }))
    call(button(view.tree, 'Sleep')); view.settle()
    await switchPerson(a, b); await switchPerson(b, a)
    resolve(true); await Promise.resolve(); await Promise.resolve(); view.settle()
    expect(text(view.tree)).not.toContain('The hive confirmed the change.')
  })
})

const { FEATURES, featureOffered } = await import('./sdk')
const { Motivations } = await import('./Motivations')
const { publicWords, publicActivityKind } = await import('./publicWords')
const { TownScene } = await import('./omegatown/TownScene')
const { PLACES, residentPlacements } = await import('./omegatown/world')
const { useAskField, addressAskMind, releaseAskAddress, PLACE_CHANGED } = await import('../features/ask/useAskField')
const { useAskStore } = await import('../store/ask')
const { actHandlerFor } = await import('../features/ask/handlers')
const { performAct } = await import('../features/ask/run')
type AskBody = import('../api/ask').AskBody
const priorDocument = typeof document === 'undefined' ? undefined : document
afterEach(() => { useAskStore.getState().reset(); W.stop.mockClear(); W.walkTo.mockClear(); R.admin = false; vi.stubGlobal('document', priorDocument) })

function fieldOf(m: Mounted): ReturnType<typeof useAskField> { return m.tree as ReturnType<typeof useAskField> }
/**
 * uifix-r2.1: Enter acts only on what a skin draws (enter.ts AskSeen; a bare hook declares nothing, so nothing is seen).
 * These mount the bare hook, so they declare what every skin draws: the rows, or the policy's panel in their place.
 */
async function submitAsDrawn(m: Mounted) {
  const f = fieldOf(m)
  f.declareSeen({ rows: !f.panel, panel: !!f.panel })
  await f.submit()
}
function askClient(p: import('../lib/identityEpoch.testkit').TestPerson) {
  const thread = { id: 'ses_invented_ask', mind: { id: 'a_invented_coordinator', name: 'Invented coordinator' }, budget_usd: 0.25, spent_usd: 0 }
  const sent: AskBody[] = []
  const call = vi.spyOn(p.client, 'ask').mockImplementation(async (body) => {
    sent.push(body)
    return { operation_id: body.operation_id, turn_id: 't_invented', thread, state: 'accepted' }
  })
  vi.spyOn(p.client, 'askTurn').mockImplementation(async (op) => ({ operation_id: op, turn_id: 't_invented', events: [], more: false }))
  useAskStore.getState().bind(useHive.getState().session, 'user:p_invented')
  vi.spyOn(p.client, 'askActResult').mockResolvedValue({ recorded: true })
  return { sent, call, thread }
}

describe('Surface fixes: actual components and native presentation paths, no paid caller', () => {
  it.each([['Town member', OmegaTown, false], ['Professional member', Professional, false], ['Town admin', OmegaTown, true], ['Professional admin', Professional, true]] as const)('%s renders the offered owner directory, so a dropped directory row is detectable', async (_name, root, admin) => {
    await person(); R.admin = admin; const { view } = experience(root)
    call(button(view.tree, 'All tools')); view.settle()
    const actual = find(view.tree, (e) => e.type === 'button' && typeof e.props['data-feature-id'] === 'string').map((e) => e.props['data-feature-id']).sort()
    const expected = FEATURES.filter((f) => featureOffered(f, { admin, apps: useHive.getState().programs })).map((f) => f.id).sort()
    expect(actual).toEqual(expected)
    expect(text(view.tree)).not.toMatch(/\b(?:boards?|goals?)\b/i)
  })
  it.each([['Town', OmegaTown, 'Work'], ['Professional', Professional, 'Tasks']] as const)('%s places native Motivations before its Tasks section', async (_name, root, label) => {
    await person(); const { view } = experience(root)
    call(button(view.tree, label)); view.settle()
    const sections = find(view.tree, (e) => e.type === Motivations || e.props['data-professional-region'] === 'tasks' || (e.type === 'h3' && text(e) === 'Tasks'))
    expect(sections.length).toBeGreaterThanOrEqual(2)
    expect(sections[0].type).toBe(Motivations)
  })
  it('professional-release r1.1 (UI review C4): Professional activity rows say which mind did it', async () => {
    const { agent } = await person()
    useHive.setState({ activity: [{ id: 1, at: '2026-10-16T09:00:00Z', kind: 'belief', agent_id: agent.id, swarm_id: null, text: 'revised an invented belief' }, { id: 2, at: '2026-10-16T09:01:00Z', kind: 'error', agent_id: null, swarm_id: null, text: 'an invented hive line' }] as never })
    const { view } = experience(Professional)
    call(button(view.tree, 'Activity')); view.settle()
    const rows = find(view.tree, (e) => e.type === 'li' && find(e, (x) => x.type === 'p').length > 0).map((e) => text(find(e, (x) => x.type === 'p')[0]))
    expect(rows).toContain(`${agent.name} revised an invented belief`)
    expect(rows).toContain('an invented hive line') // no mind: no name invented
  })
  it('professional-release r1.1 (Kimi r1): Create a task never submits by its form; Enter in Task is guarded and creates once', async () => {
    await person()
    const swarm = Object.values(useHive.getState().swarms).find((x) => !x.archived_at)!
    expect(swarm).toBeDefined()
    const createGoal = vi.fn(async () => true)
    useHive.setState({ createGoal: createGoal as never })
    const { view: pro } = experience(Professional)
    call(button(pro.tree, 'Tasks')); pro.settle()
    const el = find(pro.tree, (e) => typeof e.type === 'function' && (e.type as { name?: string }).name === 'CreateGoal')[0]
    expect(el).toBeDefined()
    const view = mount(() => (el.type as (p: Record<string, unknown>) => unknown)(el.props))
    const form = () => find(view.tree, (e) => e.type === 'form' && find(e, (x) => x.type === 'input' && x.props.placeholder === 'What should this swarm do?').length > 0)[0]
    call(find(form(), (e) => e.type === 'select')[0], 'onChange', { target: { value: swarm.id } }); view.settle()
    const task = () => find(view.tree, (e) => e.type === 'input' && e.props.placeholder === 'What should this swarm do?')[0]
    call(task(), 'onChange', { target: { value: 'Invented task' } }); view.settle()
    let prevented = 0
    // the form's own submission does nothing
    call(form(), 'onSubmit', { preventDefault: () => prevented++ })
    expect(createGoal).not.toHaveBeenCalled(); expect(prevented).toBe(1)
    expect(find(view.tree, (e) => e.type === 'button' && e.props.type === 'submit')).toHaveLength(0)
    // an input method's Enter (composing, or a confirming 229) creates nothing
    call(task(), 'onKeyDown', { key: 'Enter', isComposing: true, keyCode: 229, preventDefault() {} })
    expect(createGoal).not.toHaveBeenCalled()
    // a plain Enter creates once
    call(task(), 'onKeyDown', { key: 'Enter', keyCode: 13, preventDefault() {} }); await Promise.resolve()
    expect(createGoal).toHaveBeenCalledTimes(1)
  })
  it('Town Hall offers the same native Motivations component and exact canonical destination', async () => {
    await person(); const { view } = experience(OmegaTown)
    const scene = find(view.tree, (e) => e.type === TownScene)[0]
    ;(scene.props.onPlace as (id: string) => void)('hall'); view.settle()
    expect(find(view.tree, (e) => e.type === Motivations)).toHaveLength(1)
    expect(text(view.tree)).toContain('Motivations and Tasks')
  })
  it('public registry and event wording maps singular/plural Board and Goal while preserving exact wire kinds outside display', () => {
    expect(publicWords('A board or boards; one goal, many goals.')).toBe('A task view or task views; one task, many tasks.')
    expect(publicActivityKind('goal.updated')).toBe('task updated')
    expect(publicActivityKind('goals_review')).toBe('tasks review')
  })
  it('resident placement keeps distinct visible slots clear of door hit areas; excess minds stay in the directory', async () => {
    const { agent } = await person()
    const minds = Array.from({ length: 60 }, (_, i) => ({ ...agent, id: `a_invented_${i}` }))
    const placed = residentPlacements(minds, Object.values(useHive.getState().swarms))
    expect(placed.length).toBeGreaterThanOrEqual(12); expect(placed.length).toBeLessThan(60)
    expect(new Set(placed.map((p) => `${p.point.x},${p.point.y}`)).size).toBe(placed.length)
    for (const p of placed) {
      for (const door of PLACES) expect(Math.abs(p.point.x - door.point.x) >= 105 || Math.abs(p.point.y - (door.point.y + 22)) >= 115).toBe(true)
      for (const q of placed) if (p !== q) expect(Math.hypot(p.point.x - q.point.x, p.point.y - q.point.y)).toBeGreaterThanOrEqual(150)
    }
  })
  it('the actual scene declares every door for native point resolution and Ask clearance', async () => {
    const { agent } = await person()
    const scene = mount(() => TownScene({ agents: [agent], swarms: [], pose: townBinding.restorePose(townBinding.contextOf(useHive.getState())), selected: null, onResident() {}, onPlace() {}, onWalk() {}, walkingEnabled: true, visitorLabel: 'Invented visitor' }))
    const doors = find(scene.tree, (e) => e.type === 'button' && e.props.className === 'ot-place')
    expect(doors).toHaveLength(PLACES.length)
    for (const p of PLACES) expect(doors.some((e) => e.props['data-presence-region'] === `town-place-${p.id}` && e.props['data-xc-keep-clear'] === '')).toBe(true)
  })
  it('Town release r3: Town’s and Professional’s directories, All tools and Apps views, as rendered, name no private app', async () => {
    await person()
    const PRIVATE = /atlas|omega ?truth|\btruth\b(?! values?)/i
    const town = experience(OmegaTown).view
    const seen: string[] = []
    for (const label of ['Residents', 'Swarms', 'Work', 'Activity', 'All tools']) {
      call(button(town.tree, label)); town.settle()
      const shown = text(town.tree); seen.push(shown)
      expect(shown, `Town ${label}`).not.toMatch(PRIVATE)
    }
    expect(seen.at(-1)).toContain('Every app this hive offers you') // the shared Apps row, rendered in All tools
    const pro = experience(Professional).view
    for (const label of ['All tools', 'Apps']) {
      const b = find(pro.tree, (e) => e.type === 'button' && text(e).trim().startsWith(label))[0]
      expect(b, label).toBeDefined()
      call(b); pro.settle()
      expect(text(pro.tree), `Professional ${label}`).not.toMatch(PRIVATE)
    }
  })
  it('Town release: conductor point/highlight targets on its always-visible chrome, as the other experiences declare them', async () => {
    await person(); const { view } = experience(OmegaTown)
    const feature = (id: string) => find(view.tree, (e) => e.props['data-presence-feature'] === id)
    expect(feature('decide.approvals').map(text)).toEqual([expect.stringMatching(/^Decisions/)])
    expect(feature('hive.changeui').map(text)).toEqual(['Change experience'])
    expect(feature('work.goals').map(text)).toEqual(['Work'])
    expect(feature('minds.see').map(text)).toEqual(['Residents'])
    expect(feature('swarms.see').map(text)).toEqual(['Swarms'])
    expect(currentView()?.view.refs).toEqual(expect.arrayContaining([{ kind: 'feature', ref: 'decide.approvals' }, { kind: 'feature', ref: 'work.goals' }]))
    // the tools directory carries the same ids on its own rows, so the tabs step back while it is open (one target each)
    call(button(view.tree, 'All tools')); view.settle()
    expect(find(view.tree, (e) => e.props['data-presence-feature'] === 'work.goals' && e.props.className === 'ot-tool')).toHaveLength(1)
    expect(find(view.tree, (e) => e.props['data-presence-feature'] === 'work.goals' && text(e) === 'Work')).toHaveLength(0)
  })
  it('visible touch controls move the local pose once and an earlier-person handler cannot move it', async () => {
    const { p: a } = await person(), { view } = experience(OmegaTown)
    const right = find(view.tree, (e) => e.type === 'button' && e.props['aria-label'] === 'Move right')[0]
    expect(right).toBeDefined()
    const before = text(view.tree).match(/Position (\d+), (\d+)/)!
    call(right); view.settle()
    expect(text(view.tree)).toContain(`Position ${Number(before[1]) + 22}, ${before[2]}`)
    const b = testPerson('b', { sameTab: a }); await switchPerson(a, b)
    const old = text(view.tree); call(right); view.settle(); expect(text(view.tree)).toBe(old)
  })
  it("the owner's ruling (residents use their own voice, the Ask is the person): Talk opens the exact mind's own chat and never addresses or sends through the Ask", async () => {
    const { p, agent } = await person()
    const other = { ...agent, id: 'a_invented_duplicate' }
    useHive.setState({ agents: { [agent.id]: agent, [other.id]: other } })
    const { call: sent } = askClient(p)
    const { view } = experience(OmegaTown)
    const field = mount(() => useAskField({ experience: 'omegatown' }))
    fieldOf(field).change('Invented words of my own'); field.settle()
    const resident = find(view.tree, (e) => e.type === 'button' && e.props.className === 'ot-directory-row' && text(e).includes(agent.id))[0]
    call(resident); view.settle()
    const thread = useAskStore.getState().thread
    try {
      expect(find(view.tree, (e) => e.type === 'button' && text(e) === 'Open native chat')).toHaveLength(0) // one way to talk, not two
      call(button(view.tree, `Talk to ${agent.name}`)); field.settle()
      expect(win.location.hash).toBe(`#/dot/${agent.id}`) // the exact mind's own chat (its chat tab), never the twin's
      expect(fieldOf(field).to).toBeUndefined() // the Ask is not addressed to, or spoken through, the resident
      expect(fieldOf(field).value).toBe('Invented words of my own') // the person's own words are untouched
      expect(useAskStore.getState().thread).toBe(thread)
      expect(sent).not.toHaveBeenCalled()
      expect(text(view.tree)).toContain('The Ask below is yours.')
    } finally { win.location.hash = '#/' }
  })
  it("the owner's ruling: Talk to a module opens its native controls, not a chat and not the Ask", async () => {
    const { agent } = await person()
    useHive.setState({ agents: { [agent.id]: { ...agent, kind: 'module' } } })
    const { view } = experience(OmegaTown)
    const field = mount(() => useAskField({ experience: 'omegatown' }))
    call(find(view.tree, (e) => e.type === 'button' && e.props.className === 'ot-directory-row')[0]); view.settle()
    try {
      call(button(view.tree, 'Open this module')); field.settle()
      expect(win.location.hash).toBe(`#/dot/${agent.id}/model`)
      expect(fieldOf(field).to).toBeUndefined()
    } finally { win.location.hash = '#/' }
  })
  it('retargeting replaces only a prefix prepared by this field and preserves colon-bearing user drafts', async () => {
    const { agent } = await person(); const other = { ...agent, id: 'a_invented_beta', name: 'Beta' }
    useHive.setState({ agents: { [agent.id]: agent, [other.id]: other } })
    experience(OmegaTown); const field = mount(() => useAskField({ experience: 'omegatown' }))
    fieldOf(field).change('Ask Alpha: explain Foo: bar'); field.settle()
    expect(addressAskMind(agent.id, 'omegatown', () => !!currentView())).toBe(true); field.settle()
    expect(fieldOf(field).value).toBe(`About ${agent.name}: Ask Alpha: explain Foo: bar`)
    expect(addressAskMind(other.id, 'omegatown', () => !!currentView())).toBe(true); field.settle()
    expect(fieldOf(field).value).toBe('About Beta: Ask Alpha: explain Foo: bar')
  })
  it('an untouched prepared prefix rejects a stale live module before native Ask admission and retains its words', async () => {
    const { p, agent } = await person(), { call: sent } = askClient(p)
    experience(OmegaTown); const field = mount(() => useAskField({ experience: 'omegatown' }))
    addressAskMind(agent.id, 'omegatown', () => !!currentView()); field.settle()
    const stale = fieldOf(field), words = stale.value
    useHive.setState({ agents: { [agent.id]: { ...agent, kind: 'module' } } })
    await stale.run({ do: 'mind', text: words.trim() }, words.trim()); field.settle()
    expect(sent).not.toHaveBeenCalled(); expect(fieldOf(field).value).toBe(words)
    expect(fieldOf(field).panel).toMatchObject({ kind: 'say', tone: 'warn' })
    await stale.submit(); field.settle()
    expect(sent).not.toHaveBeenCalled(); expect(fieldOf(field).value).toBe(words)
  })
  it('encoded private hashes and A→B→A prevent prepared-address revival; native identity clears the field synchronously', async () => {
    const { p: a, agent } = await person()
    experience(OmegaTown); const field = mount(() => useAskField({ experience: 'omegatown' }))
    const ctx = townBinding.contextOf(useHive.getState())
    expect(addressAskMind(agent.id, 'omegatown', () => townBinding.current(ctx))).toBe(true); field.settle()
    win.location.hash = '#/program/%61tlas'
    expect(addressAskMind(agent.id, 'omegatown', () => true)).toBe(false)
    win.location.hash = '#/'
    const b = testPerson('b', { sameTab: a }); await switchPerson(a, b); await switchPerson(b, a)
    field.settle(); expect(fieldOf(field).value).toBe('')
    expect(addressAskMind(agent.id, 'omegatown', () => townBinding.current(ctx))).toBe(false)
  })
  it('stand-in R1 P1 (shared Ask): a prepared address, then a release, then submit keeps the words, drops the address and says so; the next Enter sends them to the Ask', async () => {
    const { p, agent } = await person(), { call: sent, sent: bodies } = askClient(p)
    experience(OmegaTown); const field = mount(() => useAskField({ experience: 'omegatown' }))
    expect(addressAskMind(agent.id, 'omegatown', () => !!currentView())).toBe(true); field.settle()
    expect(fieldOf(field).to).toBe(agent.id)
    fieldOf(field).change(fieldOf(field).value + 'Invented words.'); field.settle()
    const words = fieldOf(field).value
    // the displayed place changes: the address is released at once (words kept, the line shown)
    releaseAskAddress('omegatown'); field.settle()
    expect(fieldOf(field).value).toBe(words)
    expect(fieldOf(field).panel).toEqual({ kind: 'say', text: PLACE_CHANGED })
    // the person submits: never swallowed silently; this Enter sends the kept words as an ordinary Ask
    await submitAsDrawn(field); field.settle()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(bodies[0].text).toContain('Invented words.')
    // destination: the kept words name exactly one visible mind, so the ordinary Ask still reaches that exact ID
    expect(bodies[0].context).toMatchObject({ experience: 'omegatown', mind: agent.id })
    expect(fieldOf(field).value).toBe('')
  })
  it('stand-in R2: a duplicate-named mind after a place change goes to the plain Ask (no guessed mind ID)', async () => {
    const { p, agent } = await person(), { call: sent, sent: bodies } = askClient(p)
    const twin = { ...agent, id: 'a_invented_duplicate' }
    useHive.setState({ agents: { [agent.id]: agent, [twin.id]: twin } })
    experience(OmegaTown); const field = mount(() => useAskField({ experience: 'omegatown' }))
    expect(addressAskMind(agent.id, 'omegatown', () => !!currentView())).toBe(true); field.settle()
    expect(fieldOf(field).to).toBe(agent.id) // the exact prepared ID, not the twin
    fieldOf(field).change(fieldOf(field).value + 'Twin words.'); field.settle()
    releaseAskAddress('omegatown'); field.settle()
    expect(fieldOf(field).panel).toEqual({ kind: 'say', text: PLACE_CHANGED })
    expect(fieldOf(field).to).toBeUndefined() // the name alone is ambiguous: no mind is chosen for the person
    await submitAsDrawn(field); field.settle()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(bodies[0].text).toContain('Twin words.')
    expect(bodies[0].context).not.toHaveProperty('mind')
  })
  it('stand-in R2: private-hash recovery keeps the words, sends nothing then, and the next Enter carries no mind ID', async () => {
    const { p, agent } = await person(), { call: sent, sent: bodies } = askClient(p)
    experience(OmegaTown); const field = mount(() => useAskField({ experience: 'omegatown' }))
    expect(addressAskMind(agent.id, 'omegatown', () => !!currentView())).toBe(true); field.settle()
    fieldOf(field).change(fieldOf(field).value + 'Private-hash words.'); field.settle()
    const words = fieldOf(field).value
    win.location.hash = '#/program/%61tlas'
    try {
      await submitAsDrawn(field); field.settle()
      expect(sent).not.toHaveBeenCalled()
      expect(fieldOf(field).value).toBe(words)
      expect(fieldOf(field).panel).toEqual({ kind: 'say', text: PLACE_CHANGED })
      await submitAsDrawn(field); field.settle()
      expect(sent).toHaveBeenCalledTimes(1)
      expect(bodies[0].context).not.toHaveProperty('mind')
      expect(JSON.stringify(bodies[0].context)).not.toContain(agent.id)
    } finally { win.location.hash = '#/' }
  })
  it('stand-in R1 P1: a stale origin under a still-prepared address shows the line once and keeps the words (shared Ask, any experience)', async () => {
    const { p, agent } = await person(), { call: sent, sent: bodies } = askClient(p)
    experience(OmegaTown); const field = mount(() => useAskField({ experience: 'omegatown' }))
    let live = true
    expect(addressAskMind(agent.id, 'omegatown', () => live)).toBe(true); field.settle()
    fieldOf(field).change(fieldOf(field).value + 'More invented words.'); field.settle()
    const words = fieldOf(field).value
    live = false // the displayed origin goes stale without the experience releasing it
    await submitAsDrawn(field); field.settle()
    expect(sent).not.toHaveBeenCalled()
    expect(fieldOf(field).value).toBe(words)
    expect(fieldOf(field).panel).toEqual({ kind: 'say', text: PLACE_CHANGED })
    await submitAsDrawn(field); field.settle()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(bodies[0].text).toContain('More invented words.')
    // destination: the one visible mind named in the kept words, by exact ID (never a different mind)
    expect(bodies[0].context).toMatchObject({ mind: agent.id })
  })
  it('retained native submit and run cannot write or send after same-client A→B→A', async () => {
    const { p: a, agent } = await person(), { call: sent } = askClient(a)
    experience(OmegaTown); const field = mount(() => useAskField({ experience: 'omegatown' }))
    expect(addressAskMind(agent.id, 'omegatown', () => !!currentView())).toBe(true); field.settle()
    fieldOf(field).change(fieldOf(field).value + 'Invented earlier words.'); field.settle()
    const stale = fieldOf(field), you = stale.value.trim()
    const b = testPerson('b', { sameTab: a }); await switchPerson(a, b); await switchPerson(b, a); field.settle()
    await stale.submit(); await stale.run({ do: 'mind', text: you }, you); field.settle()
    expect(sent).not.toHaveBeenCalled(); expect(fieldOf(field).value).toBe(''); expect(fieldOf(field).panel).toBeNull()
  })
  it('the native typed Code handler yields until its submitting key has propagated, then requests an origin-bound walk', async () => {
    await person(); const { view } = experience(OmegaTown)
    const handler = actHandlerFor('omegatown')!
    const result = handler({ do: 'feature', id: 'build.code' }, 'Take me to Code')
    expect(W.walkTo).not.toHaveBeenCalled()
    expect(await result).toBe(true)
    expect(W.walkTo).toHaveBeenCalledWith(PLACES.find((p) => p.id === 'code')!.point, expect.objectContaining({ conductor: true, onArrival: expect.any(Function) }))
    W.walkTo.mockClear(); call(button(view.tree, 'Residents'))
    expect(await handler({ do: 'feature', id: 'build.code' }, 'Take me to Code')).toBe('keep')
    expect(W.walkTo).not.toHaveBeenCalled()
    view.settle()
    expect(await handler({ do: 'feature', id: 'build.code' }, 'Take me to Code')).toBe('keep')
  })
})

describe('room/picker Code fallback preserves native dispatch and foreground fences', () => {
  it.each(['hall', 'house'] as const)('%s: explicit Code acts leave a room through the native Code route without walking', async (place) => {
    await person(); const { view } = experience(OmegaTown)
    const scene = find(view.tree, (e) => e.type === TownScene)[0]
    ;(scene.props.onPlace as (id: string) => void)(place); view.settle()
    expect(find(view.tree, (e) => e.props.className === 'ot-room')).toHaveLength(1)
    expect(await actHandlerFor('omegatown')!({ do: 'feature', id: 'build.code' }, 'Open Code')).toBe(false)
    expect(W.walkTo).not.toHaveBeenCalled()
    try {
      await performAct({ do: 'feature', id: 'build.code' }, { you: 'Open Code', where: 'in OmegaTown', experience: 'omegatown' })
      expect(win.location.hash).toBe('#/code')
      expect(W.walkTo).not.toHaveBeenCalled()
    } finally { win.location.hash = '#/' }
  })
  it('an exact-mind tool picker permits the same ordinary Code fallback without selecting a mind', async () => {
    await person(); const { view } = experience(OmegaTown)
    call(button(view.tree, 'All tools')); view.settle()
    const { targetFor } = await import('./targets')
    const chosen = FEATURES.find((f) => targetFor(f)?.kind === 'mind' && featureOffered(f, { admin: false, apps: useHive.getState().programs }))!
    expect(chosen).toBeDefined()
    const row = find(view.tree, (e) => e.type === 'button' && e.props['data-feature-id'] === chosen.id)[0]
    call(row, 'onClick', { currentTarget: { dataset: { featureId: chosen.id } } }); view.settle()
    expect(find(view.tree, (e) => e.props.className === 'ot-scope')).toHaveLength(1)
    expect(await actHandlerFor('omegatown')!({ do: 'feature', id: 'build.code' }, 'Open Code')).toBe(false)
    try {
      await performAct({ do: 'feature', id: 'build.code' }, { you: 'Open Code', where: 'in OmegaTown', experience: 'omegatown' })
      expect(win.location.hash).toBe('#/code'); expect(W.walkTo).not.toHaveBeenCalled()
    } finally { win.location.hash = '#/' }
  })
  it.each(['paletteOpen', 'stopAllOpen', 'reveal'] as const)('%s arriving before a render prevents room fallback', async (field) => {
    const { agent } = await person(); const { view } = experience(OmegaTown)
    const scene = find(view.tree, (e) => e.type === TownScene)[0]
    ;(scene.props.onPlace as (id: string) => void)('hall'); view.settle()
    const handler = actHandlerFor('omegatown')!
    const before = useHive.getState()[field]
    try {
      if (field === 'reveal') useHive.setState({ reveal: { agent, token: 'synthetic-only' } })
      else useHive.setState({ [field]: true })
      expect(await handler({ do: 'feature', id: 'build.code' }, 'Open Code')).toBe('keep')
      expect(win.location.hash).toBe('#/'); expect(W.walkTo).not.toHaveBeenCalled()
    } finally { useHive.setState({ [field]: before }) }
  })
  it('a retained room handler cannot revive after a view renewal', async () => {
    await person(); const { view } = experience(OmegaTown)
    const scene = find(view.tree, (e) => e.type === TownScene)[0]
    ;(scene.props.onPlace as (id: string) => void)('hall'); view.settle()
    const retained = actHandlerFor('omegatown')!
    call(button(view.tree, 'Residents'))
    expect(await retained({ do: 'feature', id: 'build.code' }, 'Open Code')).toBe('keep')
    view.settle()
    expect(await retained({ do: 'feature', id: 'build.code' }, 'Open Code')).toBe('keep')
    expect(W.walkTo).not.toHaveBeenCalled(); expect(win.location.hash).toBe('#/')
  })
})

describe('native Ask thread origin fences the local Code fast path without changing Town identity or view', () => {
  it('an unchanged native Ask origin permits the Code walk and local room arrival', async () => {
    await person(); const { view } = experience(OmegaTown)
    expect(await performAct({ do: 'feature', id: 'build.code' }, { you: 'Take me to Code', where: 'in OmegaTown', experience: 'omegatown' })).toBe(true)
    expect(W.walkTo).toHaveBeenCalledTimes(1)
    const opts = (W.walkTo.mock.calls[0] as unknown as [unknown, { onArrival: () => void }])[1]
    opts.onArrival(); view.settle()
    expect(text(view.tree)).toContain('Choose a Code workspace')
    expect(win.location.hash).toBe('#/') // the native Code app is still an explicit separate action
  })
  it.each(['newThread', 'deleteThread'] as const)('%s before the async continuation rejects the old walk while identity and Town view stay current', async (reset) => {
    await person(); const { view } = experience(OmegaTown)
    const identity = currentEpoch(), ctx = townBinding.contextOf(useHive.getState())
    const displayed = currentView(), epoch = useAskStore.getState().epoch
    const result = performAct({ do: 'feature', id: 'build.code' }, { you: 'Take me to Code', where: 'in OmegaTown', experience: 'omegatown' })
    expect(W.walkTo).not.toHaveBeenCalled()
    // No thread is installed, so these are the actual native reset paths and make no simulated host request.
    expect(useAskStore.getState().thread).toBeNull()
    await useAskStore.getState()[reset]()
    expect(useAskStore.getState().epoch).toBeGreaterThan(epoch)
    expect(currentEpoch()).toBe(identity); expect(townBinding.current(ctx)).toBe(true)
    expect(currentView()).toBe(displayed)
    expect(await result).toBe('stale') // the ordinary runner also retains its finer native Ask origin
    expect(W.walkTo).not.toHaveBeenCalled()
    view.settle(); expect(text(view.tree)).not.toContain('Choose a Code workspace')
    expect(win.location.hash).toBe('#/')
  })
  it.each(['newThread', 'deleteThread'] as const)('%s during an active path stops it and an already retained arrival cannot open the room', async (reset) => {
    await person(); const { view } = experience(OmegaTown)
    const identity = currentEpoch(), ctx = townBinding.contextOf(useHive.getState())
    const displayed = currentView(), epoch = useAskStore.getState().epoch
    expect(await performAct({ do: 'feature', id: 'build.code' }, { you: 'Take me to Code', where: 'in OmegaTown', experience: 'omegatown' })).toBe(true)
    expect(W.walkTo).toHaveBeenCalledTimes(1)
    const opts = (W.walkTo.mock.calls[0] as unknown as [unknown, { onArrival: () => void }])[1]
    W.stop.mockClear()
    expect(useAskStore.getState().thread).toBeNull()
    await useAskStore.getState()[reset]()
    expect(useAskStore.getState().epoch).toBeGreaterThan(epoch)
    expect(currentEpoch()).toBe(identity); expect(townBinding.current(ctx)).toBe(true)
    expect(currentView()).toBe(displayed)
    expect(W.stop).toHaveBeenCalledTimes(1) // cancellation is synchronous with the native store change
    opts.onArrival(); view.settle()
    expect(text(view.tree)).not.toContain('Choose a Code workspace')
    expect(win.location.hash).toBe('#/')
  })
})

const { conduct, conductorSettled, resetConductor } = await import('../features/ask/conductor')
afterEach(() => resetConductor())
async function conductorPoint() {
  const { p } = await person(), { thread } = askClient(p)
  const { view } = experience(OmegaTown)
  const box = { left: 100, top: 100, right: 220, bottom: 170, width: 120, height: 70 }
  vi.stubGlobal('document', { querySelector: () => null, querySelectorAll: () => [{ getBoundingClientRect: () => box, closest: () => null, getAttribute: () => 'town-place-code' }] })
  await useAskStore.getState().send('Point to the Code den', { route: 'hive', experience: 'omegatown' })
  const op = useAskStore.getState().open!
  useAskStore.getState().onEvent({ type: 'ask', operation_id: op, turn_id: 't_invented', principal: 'user:p_invented', seq: 1, at: '2026-10-07T12:00:00Z', phase: 'accepted', thread })
  expect(useAskStore.getState().turns[op].state).toBe('open')
  conduct(op, { type: 'ask', operation_id: op, turn_id: 't_invented', seq: 2, at: '2026-10-07T12:00:00Z', phase: 'act', act: { kind: 'point', act_id: 'point-invented-code', target: { region: 'town-place-code' } } })
  await conductorSettled(op)
  expect(W.walkTo).toHaveBeenCalledTimes(1)
  const opts = (W.walkTo.mock.calls[0] as unknown as [unknown, { conductor: boolean; onArrival: () => void }])[1]
  expect(opts.conductor).toBe(true)
  return { op, view, arrive: opts.onArrival }
}
describe('native conductor point to a declared Town place, scripted admission/DOM and movement leaf only', () => {
  it('the existing native conductor requests the local Code walk and arrival opens only its room', async () => {
    const { view, arrive } = await conductorPoint()
    expect(win.location.hash).toBe('#/')
    arrive(); view.settle()
    expect(text(view.tree)).toContain('Choose a Code workspace')
    expect(win.location.hash).toBe('#/')
  })
  it('native person takeover cancels the active local walk and an old arrival cannot open its room', async () => {
    const { view, arrive } = await conductorPoint()
    useAskStore.getState().personTookOver()
    expect(W.stop).toHaveBeenCalled()
    arrive(); view.settle()
    expect(text(view.tree)).not.toContain('Choose a Code workspace')
  })
})
