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
vi.mock('../shell/phase', async () => {
  const actual = await vi.importActual<typeof import('../shell/phase')>('../shell/phase')
  const { useSyncExternalStore } = await import('react')
  const usePhase = Object.assign((sel?: (s: ReturnType<typeof actual.usePhase.getState>) => unknown) => {
    const read = () => sel ? sel(actual.usePhase.getState()) : actual.usePhase.getState()
    return useSyncExternalStore(actual.usePhase.subscribe, read, read)
  }, actual.usePhase)
  return { ...actual, usePhase }
})
vi.mock('../lib/resting', async () => {
  const actual = await vi.importActual<typeof import('../lib/resting')>('../lib/resting')
  const { useSyncExternalStore } = await import('react')
  return { ...actual, useResting: Object.assign((sel?: (s: ReturnType<typeof actual.useResting.getState>) => unknown) => {
    const read = () => sel ? sel(actual.useResting.getState()) : actual.useResting.getState()
    return useSyncExternalStore(actual.useResting.subscribe, read, read)
  }, actual.useResting) }
})
// Read-only self/viewport hooks and local walking are leaf presentation stand-ins; no identity or dispatch gate is mocked.
vi.mock('./sdk', async (orig) => ({ ...(await orig<typeof import('./sdk')>()),
  useMe: () => ({ me: R.admin ? { principal: 'user:operator', kind: 'password', role: 'admin' } : undefined, loaded: R.admin, admin: R.admin }),
  useAdminView: () => ({ me: undefined, loaded: false, adminView: R.admin }),
  useReducedMotion: () => true, useRoomyLayout: () => false,
  useResting: (sel: (s: { resting: boolean }) => unknown) => sel({ resting: false }),
}))
const win = { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout }
vi.stubGlobal('window', win)
vi.stubGlobal('document', { hidden: false, documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })

const { useHive } = await import('../store/store')
const { currentView } = await import('../features/ask/view')
const { currentEpoch } = await import('../lib/identityEpoch')
const { testPerson, signInAs, switchPerson, releasePersons, reportTestPrincipal } = await import('../lib/identityEpoch.testkit')
const { default: Professional } = await import('./professional')
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
  it.each([['Professional', Professional, 'Overview', 'professional']] as const)('%s: repeated current-view clicks renew after their immediate invalidation', async (_name, root, label, scope) => {
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
  it('same-client A→B→A: the old epoch/Ask/selection handlers stay invalid', async () => {
    const { p: a } = await person(), b = testPerson('b', { sameTab: a })
    const ctx = professionalBinding.contextOf(useHive.getState()), epoch = currentEpoch(), old = experience(Professional)
    const stale = button(old.view.tree, 'Overview')
    const done = switchPerson(a, b)
    expect(currentEpoch()).toBeGreaterThan(epoch); expect(professionalBinding.current(ctx)).toBe(false); expect(currentView()).toBeNull()
    call(stale); old.view.settle(); expect(currentView()).toBeNull() // the old tree's click exports no view for the new epoch
    await done; await switchPerson(b, a)
    expect(professionalBinding.current(ctx)).toBe(false) // returning to the same person/client never revives a stale closure
    const fresh = experience(Professional); expect(fresh.key).not.toBe(old.key); expect(currentView()?.scope).toBe('professional')
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
const { useAskField, addressAskMind, releaseAskAddress, PLACE_CHANGED } = await import('../features/ask/useAskField')
const { useAskStore } = await import('../store/ask')
type AskBody = import('../api/ask').AskBody
const priorDocument = typeof document === 'undefined' ? undefined : document
afterEach(() => { useAskStore.getState().reset(); R.admin = false; vi.stubGlobal('document', priorDocument) })

/** Professional with this mind selected: its view then names the mind, which a prepared address requires. */
function showMind(view: Mounted, id: string) {
  const rowOf = () => find(view.tree, (e) => e.type === 'li' && e.props['data-presence-ref'] === `mind:${id}`)[0]
  if (!rowOf()) { call(find(view.tree, (e) => e.type === 'button' && text(e).trim().startsWith('Minds'))[0]); view.settle() }   // back to the list
  const row = rowOf()
  expect(row, id).toBeDefined()
  call(find(row, (e) => e.type === 'button' && e.props.className === 'pr-row-main')[0]); view.settle()
}
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
  reportTestPrincipal(p, 'user:p_invented')
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
  it.each([['Professional member', Professional, false], ['Professional admin', Professional, true]] as const)('%s renders the offered owner directory, so a dropped directory row is detectable', async (_name, root, admin) => {
    await person(); R.admin = admin; const { view } = experience(root)
    call(button(view.tree, 'All tools')); view.settle()
    const actual = find(view.tree, (e) => e.type === 'button' && typeof e.props['data-feature-id'] === 'string').map((e) => e.props['data-feature-id']).sort()
    const expected = FEATURES.filter((f) => featureOffered(f, { admin, apps: useHive.getState().programs })).map((f) => f.id).sort()
    expect(actual).toEqual(expected)
    expect(text(view.tree)).not.toMatch(/\b(?:boards?|goals?)\b/i)
  })
  it.each([['Professional', Professional, 'Tasks']] as const)('%s places native Motivations before its Tasks section', async (_name, root, label) => {
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
  it('public registry and event wording maps singular/plural Board and Goal while preserving exact wire kinds outside display', () => {
    expect(publicWords('A board or boards; one goal, many goals.')).toBe('A task view or task views; one task, many tasks.')
    expect(publicActivityKind('goal.updated')).toBe('task updated')
    expect(publicActivityKind('goals_review')).toBe('tasks review')
  })
  it('Professional’s All tools and Apps views, as rendered, name no private app', async () => {
    await person()
    const PRIVATE = /atlas|omega ?truth|\btruth\b(?! values?)/i
    const pro = experience(Professional).view
    for (const label of ['All tools', 'Apps']) {
      const b = find(pro.tree, (e) => e.type === 'button' && text(e).trim().startsWith(label))[0]
      expect(b, label).toBeDefined()
      call(b); pro.settle()
      expect(text(pro.tree), `Professional ${label}`).not.toMatch(PRIVATE)
    }
  })
  it('retargeting replaces only a prefix prepared by this field and preserves colon-bearing user drafts', async () => {
    const { agent } = await person(); const other = { ...agent, id: 'a_invented_beta', name: 'Beta' }
    useHive.setState({ agents: { [agent.id]: agent, [other.id]: other } })
    const pro = experience(Professional).view; showMind(pro, agent.id); const field = mount(() => useAskField({ experience: 'professional' }))
    fieldOf(field).change('Ask Alpha: explain Foo: bar'); field.settle()
    expect(addressAskMind(agent.id, 'professional', () => !!currentView())).toBe(true); field.settle()
    expect(fieldOf(field).value).toBe(`About ${agent.name}: Ask Alpha: explain Foo: bar`)
    showMind(pro, other.id)
    expect(addressAskMind(other.id, 'professional', () => !!currentView())).toBe(true); field.settle()
    expect(fieldOf(field).value).toBe('About Beta: Ask Alpha: explain Foo: bar')
  })
  it('an untouched prepared prefix rejects a stale live module before native Ask admission and retains its words', async () => {
    const { p, agent } = await person(), { call: sent } = askClient(p)
    const pro = experience(Professional).view; showMind(pro, agent.id); const field = mount(() => useAskField({ experience: 'professional' }))
    addressAskMind(agent.id, 'professional', () => !!currentView()); field.settle()
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
    const pro = experience(Professional).view; showMind(pro, agent.id); const field = mount(() => useAskField({ experience: 'professional' }))
    const ctx = professionalBinding.contextOf(useHive.getState())
    expect(addressAskMind(agent.id, 'professional', () => professionalBinding.current(ctx))).toBe(true); field.settle()
    win.location.hash = '#/program/%61tlas'
    expect(addressAskMind(agent.id, 'professional', () => true)).toBe(false)
    win.location.hash = '#/'
    const b = testPerson('b', { sameTab: a }); await switchPerson(a, b); await switchPerson(b, a)
    field.settle(); expect(fieldOf(field).value).toBe('')
    expect(addressAskMind(agent.id, 'professional', () => professionalBinding.current(ctx))).toBe(false)
  })
  it('stand-in R1 P1 (shared Ask): a prepared address, then a release, then submit keeps the words, drops the address and says so; the next Enter sends them to the Ask', async () => {
    const { p, agent } = await person(), { call: sent, sent: bodies } = askClient(p)
    const pro = experience(Professional).view; showMind(pro, agent.id); const field = mount(() => useAskField({ experience: 'professional' }))
    expect(addressAskMind(agent.id, 'professional', () => !!currentView())).toBe(true); field.settle()
    expect(fieldOf(field).to).toBe(agent.id)
    fieldOf(field).change(fieldOf(field).value + 'Invented words.'); field.settle()
    const words = fieldOf(field).value
    // the displayed place changes: the address is released at once (words kept, the line shown)
    releaseAskAddress('professional'); field.settle()
    expect(fieldOf(field).value).toBe(words)
    expect(fieldOf(field).panel).toEqual({ kind: 'say', text: PLACE_CHANGED })
    // the person submits: never swallowed silently; this Enter sends the kept words as an ordinary Ask
    await submitAsDrawn(field); field.settle()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(bodies[0].text).toContain('Invented words.')
    // destination: the kept words name exactly one visible mind, so the ordinary Ask still reaches that exact ID
    expect(bodies[0].context).toMatchObject({ experience: 'professional', mind: agent.id })
    expect(fieldOf(field).value).toBe('')
  })
  it('stand-in R2: a duplicate-named mind after a place change goes to the plain Ask (no guessed mind ID)', async () => {
    const { p, agent } = await person(), { call: sent, sent: bodies } = askClient(p)
    const twin = { ...agent, id: 'a_invented_duplicate' }
    useHive.setState({ agents: { [agent.id]: agent, [twin.id]: twin } })
    const pro = experience(Professional).view; showMind(pro, agent.id); const field = mount(() => useAskField({ experience: 'professional' }))
    expect(addressAskMind(agent.id, 'professional', () => !!currentView())).toBe(true); field.settle()
    expect(fieldOf(field).to).toBe(agent.id) // the exact prepared ID, not the twin
    fieldOf(field).change(fieldOf(field).value + 'Twin words.'); field.settle()
    releaseAskAddress('professional'); field.settle()
    expect(fieldOf(field).panel).toEqual({ kind: 'say', text: PLACE_CHANGED })
    expect(fieldOf(field).to).toBeUndefined() // the name alone is ambiguous: no mind is chosen for the person
    await submitAsDrawn(field); field.settle()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(bodies[0].text).toContain('Twin words.')
    expect(bodies[0].context).not.toHaveProperty('mind')
  })
  it.each([false, true])('stand-in R2: private-hash recovery keeps the words, sends nothing then, and the next Enter carries no mind ID (surrounding whitespace=%s)', async (padded) => {
    const { p, agent } = await person(), { call: sent, sent: bodies } = askClient(p)
    const pro = experience(Professional).view; showMind(pro, agent.id); const field = mount(() => useAskField({ experience: 'professional' }))
    expect(addressAskMind(agent.id, 'professional', () => !!currentView())).toBe(true); field.settle()
    const typed = fieldOf(field).value + 'Private-hash words.'
    fieldOf(field).change(padded ? `  ${typed}  ` : typed); field.settle()
    expect(fieldOf(field).to).toBe(agent.id)
    const words = fieldOf(field).value
    win.location.hash = '#/program/%61tlas'
    try {
      await submitAsDrawn(field); field.settle()
      expect(sent).not.toHaveBeenCalled()
      expect(fieldOf(field).value).toBe(words)
      expect(fieldOf(field).panel).toEqual({ kind: 'say', text: PLACE_CHANGED })
      // Dot's 20261104T070450Z ruling: a covered native field never sends from an active private app.
      // The former expectation of a public Ask on this second private Enter was wrong.
      await submitAsDrawn(field); field.settle()
      expect(sent).not.toHaveBeenCalled()
      expect(fieldOf(field).to).toBeUndefined()
      expect(fieldOf(field).value).toBe(words)
      win.location.hash = '#/'
      field.render(); field.settle()
      expect(fieldOf(field).value).toBe(words)
      expect(fieldOf(field).to).toBeUndefined()
      // Returning is a newly shown paid row; the ordinary reading interval still applies.
      const { ARM_MS } = await import('../lib/decisionGate')
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + ARM_MS + 1)
      await submitAsDrawn(field); field.settle()
      expect(sent).toHaveBeenCalledTimes(1)
      expect(bodies[0].context).not.toHaveProperty('mind')
      // The recovered PUBLIC view still includes its authorized visible minds; none is a prepared recipient.
      expect(bodies[0].context).toMatchObject({ route: 'hive', experience: 'professional', view: { refs: expect.arrayContaining([{ kind: 'mind', ref: agent.id }]) } })
      expect(bodies[0].context).not.toHaveProperty('program')
      expect(bodies[0].context).not.toHaveProperty('private')
    } finally { win.location.hash = '#/' }
  })
  it('stand-in R1 P1: a stale origin under a still-prepared address shows the line once and keeps the words (shared Ask, any experience)', async () => {
    const { p, agent } = await person(), { call: sent, sent: bodies } = askClient(p)
    const pro = experience(Professional).view; showMind(pro, agent.id); const field = mount(() => useAskField({ experience: 'professional' }))
    let live = true
    expect(addressAskMind(agent.id, 'professional', () => live)).toBe(true); field.settle()
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
    const pro = experience(Professional).view; showMind(pro, agent.id); const field = mount(() => useAskField({ experience: 'professional' }))
    expect(addressAskMind(agent.id, 'professional', () => !!currentView())).toBe(true); field.settle()
    fieldOf(field).change(fieldOf(field).value + 'Invented earlier words.'); field.settle()
    const stale = fieldOf(field), you = stale.value.trim()
    const b = testPerson('b', { sameTab: a }); await switchPerson(a, b); await switchPerson(b, a); field.settle()
    await stale.submit(); await stale.run({ do: 'mind', text: you }, you); field.settle()
    expect(sent).not.toHaveBeenCalled(); expect(fieldOf(field).value).toBe(''); expect(fieldOf(field).panel).toBeNull()
  })
})
