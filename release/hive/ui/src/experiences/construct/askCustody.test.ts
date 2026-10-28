import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stand-in ASK_EVERYWHERE_R1 (FA6C509D) #1-#3: Construct's prompt-as-Ask, MOUNTED. The real CommandLine and Console
// components run under the repo's minimal React stand-in (features/programs/HostConfirm.test.ts: hook slots, effects
// and their cleanups after each render), against the real hive store, the real Ask store and the identity-epoch test
// kit's people (synthetic SimClients; switchPerson drives the real identity change). The rendered element tree is read
// for its words. INVENTED data only; no hive, nothing leaves the page.
const R = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[], ei: 0, pending: [] as (() => void)[], ids: 0 }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const slot = (init: () => unknown) => {
    const n = R.i++
    if (!(n in R.slots)) R.slots[n] = init()
    return n
  }
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) => !a || !b || a.length !== b.length || a.some((d, k) => !Object.is(d, b[k]))
  const memo = (f: () => unknown, deps?: unknown[]) => {
    const n = slot(() => ({ deps: undefined, value: undefined, fresh: true }))
    const s = R.slots[n] as { deps?: unknown[]; value: unknown; fresh: boolean }
    if (s.fresh || changed(deps, s.deps)) R.slots[n] = { deps, value: f(), fresh: false }
    return (R.slots[n] as { value: unknown }).value
  }
  const effect = (fn: () => unknown, deps?: unknown[]) => {
    // each mount has its own effects (captured here), so two mounted components never share or erase each other's
    const effects = R.effects
    const n = R.ei++
    const prev = effects[n]
    if (!prev || changed(deps, prev.deps))
      R.pending.push(() => {
        if (typeof prev?.cleanup === 'function') (prev.cleanup as () => void)()
        effects[n] = { deps, cleanup: fn() }
      })
  }
  const m = {
    ...actual,
    useState: (init: unknown) => {
      // the setter writes this mount's own slots (captured), whenever it is called
      const slots = R.slots
      const n = slot(() => (typeof init === 'function' ? (init as () => unknown)() : init))
      return [slots[n], (v: unknown) => void (slots[n] = typeof v === 'function' ? (v as (p: unknown) => unknown)(slots[n]) : v)]
    },
    useRef: (v: unknown) => R.slots[slot(() => ({ current: v }))],
    useCallback: (f: unknown, deps?: unknown[]) => memo(() => f, deps),
    useMemo: (f: () => unknown, deps?: unknown[]) => memo(f, deps),
    useId: () => R.slots[slot(() => `:t${++R.ids}:`)],
    useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
    useDebugValue: () => undefined,
    useContext: (c: { _currentValue?: unknown }) => c._currentValue,
    useEffect: effect,
    useLayoutEffect: effect,
  }
  return { ...m, default: m }
})
// zustand's own React binding is outside this module graph: the stand-in reads each real store through its selector
const viaSelector = <S,>(store: { getState: () => S }) => Object.assign((sel?: (s: S) => unknown) => (sel ? sel(store.getState()) : store.getState()), store)
vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  return { ...actual, useHive: viaSelector(actual.useHive) }
})
vi.mock('../../store/ask', async () => {
  const actual = await vi.importActual<typeof import('../../store/ask')>('../../store/ask')
  return { ...actual, useAskStore: viaSelector(actual.useAskStore) }
})
vi.mock('./state', async () => {
  const actual = await vi.importActual<typeof import('./state')>('./state')
  return { ...actual, useC: viaSelector(actual.useC) }
})

const win = { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout }
vi.stubGlobal('window', win)
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })

type AskEvent = import('../../api/ask').AskEvent
type TestPerson = import('../../lib/identityEpoch.testkit').TestPerson
const { useHive } = await import('../../store/store')
const { useAskStore } = await import('../../store/ask')
const { useC } = await import('./state')
const { run } = await import('./commands')
const { CommandLine, Console } = await import('./CommandLine')
const kit = await import('../../lib/identityEpoch.testkit')
const { releasePersons, signInAs, switchPerson, testPerson } = kit

// ------------------------------------------------------------------ the stand-in's mount, and reading what it drew

interface El { type: unknown; props: Record<string, unknown> }
const isEl = (v: unknown): v is El => !!v && typeof v === 'object' && 'props' in (v as object) && 'type' in (v as object)

function mount(component: () => unknown) {
  // this mount's own hook slots and effects: R points at them only while it renders
  const own = { slots: [] as unknown[], effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[] }
  const out = { tree: undefined as unknown }
  const once = () => {
    R.slots = own.slots
    R.effects = own.effects
    R.i = 0
    R.ei = 0
    R.pending = []
    out.tree = component()
    R.pending.forEach((f) => f())
  }
  // render, run effects, render again (as React does after a state change), until nothing new is pending
  const settle = () => {
    for (let k = 0; k < 4; k++) once()
  }
  settle()
  return {
    get tree() {
      return out.tree
    },
    /** one render with no effects run yet: what the screen shows in the very render after a change */
    renderOnly: () => {
      R.slots = own.slots
      R.effects = own.effects
      R.i = 0
      R.ei = 0
      R.pending = []
      out.tree = component()
      const p = R.pending
      R.pending = []
      return { tree: out.tree, flush: () => p.forEach((f) => f()) }
    },
    settle,
    unmount: () => {
      own.effects.forEach((e) => typeof e?.cleanup === 'function' && (e.cleanup as () => void)())
      own.effects.length = 0
    },
  }
}

/** Every string the drawn tree carries (children, text props such as Decode's `text`, Segs' `segs`). */
function words(node: unknown, acc: string[] = [], seen = new WeakSet<object>()): string[] {
  if (typeof node === 'string' || typeof node === 'number') acc.push(String(node))
  else if (Array.isArray(node)) for (const n of node) words(n, acc, seen)
  else if (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node)
    if (isEl(node)) {
      for (const [k, v] of Object.entries(node.props)) if (k !== 'ref' && typeof v !== 'function') words(v, acc, seen)
    } else if (!('current' in (node as object))) for (const v of Object.values(node as object)) words(v, acc, seen)
  }
  return acc
}
const text = (tree: unknown) => words(tree).join(' ')
function find(node: unknown, pred: (e: El) => boolean, acc: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) find(n, pred, acc)
  else if (isEl(node)) {
    if (pred(node)) acc.push(node)
    find(node.props.children, pred, acc)
  }
  return acc
}
const key = (k: string, more: Partial<{ shiftKey: boolean; ctrlKey: boolean; repeat: boolean }> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, preventDefault() {}, stopPropagation() {}, nativeEvent: { isComposing: false }, ...more })
const inputOf = (tree: unknown) => find(tree, (e) => e.type === 'input')[0].props as Record<string, (...a: unknown[]) => void> & Record<string, unknown>

// ------------------------------------------------------------------ people with an Ask (a hand-made Ask on their client)

// the host's frames are numbered per turn, 1, 2, 3…
const seqs = new Map<string, number>()
function withAsk(p: TestPerson) {
  const thread = { id: `ses_${p.name}`, mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
  Object.assign(p.client, {
    ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: `t_${p.name}`, thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: `t_${p.name}`, events: [], more: false })),
    askSteer: vi.fn(async (op: string, b: { steer_id: string }) => ({ steer_id: b.steer_id, operation_id: op })),
    askStop: vi.fn(async () => ({})),
    askEndThread: vi.fn(async () => ({})),
  })
  return thread
}
const frame = (op: string, f: Record<string, unknown>) => ({ type: 'ask', operation_id: op, turn_id: 't', principal: 'user:x', seq: seqs.set(op, (seqs.get(op) ?? 0) + 1).get(op), at: '2026-10-07T12:00:00Z', ...f }) as unknown as AskEvent
const deliver = (e: AskEvent) => useAskStore.getState().onEvent(e)

/** Sign `p` in, bind the Ask to them, and ask one invented question (the open turn's op). */
async function askAs(p: TestPerson, words: string) {
  const thread = withAsk(p)
  await signInAs(p)
  useAskStore.getState().bind(useHive.getState().session, `user:${p.name}`)
  await useAskStore.getState().send(words, { route: 'hive', experience: 'construct' }, { where: 'in Construct' })
  const op = useAskStore.getState().open!
  deliver(frame(op, { phase: 'accepted', thread }))
  return op
}
/** An answer, and the turn's close (the line under the prompt shows the answer once the turn is no longer working). */
const answerFor = (op: string, t: string) => {
  deliver(frame(op, { phase: 'answer', text: t }))
  return frame(op, { phase: 'done', outcome: 'complete' })
}
const presenceFor = (op: string, caption: string) => frame(op, { phase: 'presence', actor: { id: 'a_vega01', name: 'Vega' }, verb: 'look', target: { region: 'page' }, caption })
const consoleText = () => useC.getState().console.map((l) => l.segs.map((s) => s.t).join('')).join('\n')

const A_ANSWER = 'Invented answer meant only for person A'
const A_LATE = 'Invented late answer for person A'
const A_REQUEST = 'where did my invented notes for A go'
const A_CAPTION = 'Reading invented page for A'

let mounted: { unmount: () => void }[] = []
beforeEach(() => {
  vi.stubGlobal('window', win)
  useC.getState().forget?.()
  useC.setState({ console: [], flash: null, consoleOpen: false, mind: null })
})
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount()
  useAskStore.getState().reset()
  releasePersons()
})
const keep = <T extends { unmount: () => void }>(m: T) => (mounted.push(m), m)

// ------------------------------------------------------------------ #1 the preview under the prompt

describe('#1 the answer under the prompt belongs to the person (and thread) it arrived for', () => {
  for (const tab of ['same tab (re-login, credential only)', 'another tab (another client)'] as const) {
    it(`${tab}: A's answer is gone in the very render after the switch, and A's late answer never shows`, async () => {
      const a = testPerson('a')
      const b = tab.startsWith('same') ? testPerson('b', { sameTab: a }) : testPerson('b')
      withAsk(b)
      const op = await askAs(a, 'invented question from A')
      const view = keep(mount(() => CommandLine({ phone: false })))
      deliver(answerFor(op, A_ANSWER))
      view.settle()
      expect(text(view.tree)).toContain(A_ANSWER)

      const done = switchPerson(a, b)
      // the very next render (no effect has run yet) no longer draws it
      const next = view.renderOnly()
      expect(text(next.tree)).not.toContain(A_ANSWER)
      next.flush()
      view.settle()
      expect(text(view.tree)).not.toContain(A_ANSWER)
      await done
      deliver(answerFor(op, A_LATE))
      view.settle()
      expect(text(view.tree)).not.toContain(A_ANSWER)
      expect(text(view.tree)).not.toContain(A_LATE)
    })
  }

  it('a new thread takes the shown answer with it (the line never outlives its thread)', async () => {
    const a = testPerson('a')
    const op = await askAs(a, 'invented question from A')
    const view = keep(mount(() => CommandLine({ phone: false })))
    deliver(answerFor(op, A_ANSWER))
    view.settle()
    expect(text(view.tree)).toContain(A_ANSWER)
    await useAskStore.getState().newThread()
    view.settle()
    expect(text(view.tree)).not.toContain(A_ANSWER)
  })
})

// ------------------------------------------------------------------ #2 the console's copies

describe('#2 the console never keeps what was printed for an earlier person', () => {
  async function aWithScrollback(b: (a: TestPerson) => TestPerson) {
    const a = testPerson('a')
    const other = b(a)
    withAsk(other)
    const op = await askAs(a, 'invented question from A')
    const line = keep(mount(() => CommandLine({ phone: false })))
    // A types a request at the prompt (echoed in the console) and runs a command (its output is printed there too).
    // uifix-r2.3: the echo is printed when the Ask acts, which needs the prompt in use (focused, its row drawn)
    inputOf(line.tree).onFocus()
    line.settle()
    inputOf(line.tree).onChange({ target: { value: A_REQUEST } })
    line.settle()
    inputOf(line.tree).onKeyDown(key('Enter'))
    line.settle()
    await run('help')
    useC.getState().setConsole(true)
    const con = keep(mount(() => Console()))
    expect(text(con.tree)).toContain(A_REQUEST)
    expect(consoleText()).toContain(A_REQUEST)
    return { a, b: other, op, line, con }
  }

  it('same-client re-login: the console (and its scrollback) is empty at once, stays so after A’s late events, and on re-entry', async () => {
    const { a, b, op, line, con } = await aWithScrollback((a) => testPerson('b', { sameTab: a }))
    const done = switchPerson(a, b)
    expect(consoleText()).toBe('')
    con.settle()
    expect(text(con.tree)).not.toContain(A_REQUEST)
    await done
    deliver(presenceFor(op, A_CAPTION))
    deliver(answerFor(op, A_LATE))
    line.settle()
    con.settle()
    expect(consoleText()).not.toMatch(/invented|A_/i)
    expect(text(line.tree)).not.toContain(A_REQUEST)
    expect(text(line.tree)).not.toContain(A_LATE)
    // re-entry: B opens the console and the prompt afresh
    line.unmount()
    con.unmount()
    useC.getState().setConsole(true)
    const again = keep(mount(() => Console()))
    const prompt = keep(mount(() => CommandLine({ phone: false })))
    expect(text(again.tree)).not.toContain(A_REQUEST)
    expect(inputOf(prompt.tree).value).toBe('')
  })

  it('another client: the same, and B’s own prompt starts empty', async () => {
    const { a, b, line, con } = await aWithScrollback(() => testPerson('b'))
    inputOf(line.tree).onChange({ target: { value: 'half-typed invented words of A' } })
    line.settle()
    const done = switchPerson(a, b)
    expect(consoleText()).toBe('')
    await done
    line.settle()
    con.settle()
    expect(text(con.tree)).not.toContain(A_REQUEST)
    expect(inputOf(line.tree).value).toBe('')
  })

  it('while Construct is not shown: a re-login still clears the console before Construct is entered again', async () => {
    const { a, b, line, con } = await aWithScrollback((a) => testPerson('b', { sameTab: a }))
    line.unmount()
    con.unmount()
    mounted = []
    expect(consoleText()).toContain(A_REQUEST)
    await switchPerson(a, b)
    expect(consoleText()).toBe('')
    useC.getState().setConsole(true)
    const again = keep(mount(() => Console()))
    expect(text(again.tree)).not.toContain(A_REQUEST)
  })

  it('the orchestrator’s presence echoed for A leaves with A; A’s late presence is never echoed for B', async () => {
    const { watchAskEcho } = await import('./askEcho')
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    withAsk(b)
    const op = await askAs(a, 'invented question from A')
    const off = watchAskEcho()
    try {
      deliver(presenceFor(op, A_CAPTION))
      expect(consoleText()).toContain(A_CAPTION)
      const done = switchPerson(a, b)
      expect(consoleText()).not.toContain(A_CAPTION)
      await done
      deliver(presenceFor(op, `${A_CAPTION} (late)`))
      expect(consoleText()).not.toContain(A_CAPTION)
    } finally {
      off()
    }
  })

  it('a new thread takes the Ask’s copies out of the console; the person’s own command output stays', async () => {
    const { line } = await aWithScrollback((a) => testPerson('b', { sameTab: a }))
    void line
    expect(consoleText()).toMatch(/help/)
    await useAskStore.getState().newThread()
    expect(consoleText()).not.toContain(A_REQUEST)
    expect(consoleText()).toMatch(/help/)
  })
})

// ------------------------------------------------------------------ #3 command completions as a combobox

describe('#3 command completions: the combobox names its listbox and the selected option', () => {
  it('typing, then Tab and Shift+Tab: aria-controls is the listbox, aria-activedescendant the selected option, every time', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const view = keep(mount(() => CommandLine({ phone: false })))
    inputOf(view.tree).onFocus()
    inputOf(view.tree).onChange({ target: { value: 's' } })
    view.settle()
    const check = () => {
      const inp = inputOf(view.tree)
      expect(inp['aria-expanded']).toBe(true)
      const lists = find(view.tree, (e) => e.props.role === 'listbox')
      expect(lists.length).toBeGreaterThan(0)
      const ids = String(inp['aria-controls'] ?? '').split(' ')
      for (const l of lists) expect(ids).toContain(l.props.id)
      const active = find(view.tree, (e) => e.props.role === 'option' && e.props.id === inp['aria-activedescendant'])
      expect(active).toHaveLength(1)
      expect(active[0].props['aria-selected']).toBe(true)
      expect(find(view.tree, (e) => e.props.role === 'option' && e.props['aria-selected'] === true)).toHaveLength(1)
      return { id: inp['aria-activedescendant'], value: String(inp.value) }
    }
    const first = check()
    const seen = new Set<unknown>([first.id])
    for (let k = 0; k < 7; k++) {
      inputOf(view.tree).onKeyDown(key('Tab'))
      view.settle()
      const now = check()
      seen.add(now.id)
      // the selected option is the completion now in the field
      const opt = find(view.tree, (e) => e.props.id === now.id)[0]
      expect(text(opt)).toContain(now.value.trim())
    }
    expect(seen.size).toBeGreaterThan(2)
    inputOf(view.tree).onKeyDown(key('Tab', { shiftKey: true }))
    view.settle()
    check()
  })
})

// ------------------------------------------------------------------ r2b: the shared field, and Construct's late command output

describe('r2b: the shared Ask field (every skin) never keeps the earlier person’s typed words', () => {
  for (const tab of ['same tab (re-login, credential only)', 'another tab (another client)'] as const) {
    it(`${tab}: A's typed words leave the mounted field at once; a field mounted later for B starts empty`, async () => {
      const { useAskField } = await import('../../features/ask/useAskField')
      const a = testPerson('a')
      const b = tab.startsWith('same') ? testPerson('b', { sameTab: a }) : testPerson('b')
      withAsk(b)
      await askAs(a, 'invented question from A')
      const view = keep(mount(() => useAskField({ experience: 'cosmos' })))
      ;(view.tree as { change: (v: string) => void }).change('half-typed invented words of A')
      view.settle()
      expect((view.tree as { value: string }).value).toBe('half-typed invented words of A')
      const done = switchPerson(a, b)
      // the very next render (no effect has run yet) shows an empty field
      expect((view.renderOnly().tree as { value: string }).value).toBe('')
      await done
      view.settle()
      expect((view.tree as { value: string }).value).toBe('')
      // recall (ArrowUp) under B offers nothing of A's
      ;(view.tree as { onKeyDown: (e: unknown) => void }).onKeyDown(key('ArrowUp'))
      view.settle()
      expect((view.tree as { value: string }).value).toBe('')
    })
  }
})

describe('r2b: a Construct command’s late output never prints for the next person', () => {
  type HiveState = ReturnType<typeof useHive.getState>
  const saved: Partial<HiveState> = {}
  function hold<K extends keyof HiveState>(k: K) {
    // every call while held (A's, and B's own hydration) waits; all of them settle together, late
    const calls: { r: (v: unknown) => void; j: (e: unknown) => void }[] = []
    if (!(k in saved)) (saved as Record<string, unknown>)[k] = useHive.getState()[k]
    useHive.setState({ [k]: () => new Promise((r, j) => void calls.push({ r, j })) } as never)
    return { settle: (v?: unknown) => calls.forEach((c) => c.r(v)), fail: (e: unknown) => calls.forEach((c) => c.j(e)) }
  }
  afterEach(() => {
    useHive.setState(saved as never)
    for (const k of Object.keys(saved)) delete (saved as Record<string, unknown>)[k]
  })
  async function aRuns(line: string, setup: () => { settle: (v?: unknown) => void; fail: (e: unknown) => void }) {
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const gate = setup()
    const p = run(line)
    await Promise.resolve()
    await switchPerson(a, b)
    expect(consoleText()).toBe('')
    return { gate, p }
  }
  const awakeMind = () => Object.values(useHive.getState().agents)[0]

  it.each(['ok', 'no', 'throws'] as const)('sleep/wake (agentAction) answered late, %s: neither the ✓, the refusal nor run()’s own catch prints for B', async (end) => {
    {
      const a = testPerson('a')
      const b = testPerson('b', { sameTab: a })
      await signInAs(a)
      const m = awakeMind()
      useHive.setState({ agents: { ...useHive.getState().agents, [m.id]: { ...m, status: 'awake' } } })
      const gate = hold('agentAction')
      const p = run(`sleep ${m.name.toLowerCase().replace(/\s+/g, '-')}`)
      expect(consoleText()).toMatch(/sleeping/)
      await switchPerson(a, b)
      expect(consoleText()).toBe('')
      if (end === 'throws') gate.fail(new Error('invented late failure for A'))
      else gate.settle(end === 'ok')
      await p
      expect(consoleText(), end).toBe('')
      useHive.setState(saved as never)
      releasePersons()
    }
  })

  const w = () => Object.values(useHive.getState().swarms)[0]
  it.each([
    ['beliefs', 'loadBeliefs', 'ok'],
    ['beliefs', 'loadBeliefs', 'throws'],
    ['decided', 'loadApprovals', 'ok'],
    ['rules', 'loadPolicy', 'ok'],
    ['rules', 'loadPolicy', 'throws'],
  ] as const)('%s (%s, %s late): nothing read for A prints for B', async (line, k, end) => {
    {
      const { gate, p } = await aRuns(line === 'beliefs' ? `beliefs ${w().name.toLowerCase().replace(/\s+/g, '-')}` : line, () => hold(k))
      if (end === 'throws') gate.fail(new Error('invented'))
      else gate.settle()
      await p
      expect(consoleText(), `${line} ${end}`).toBe('')
      useHive.setState(saved as never)
      releasePersons()
    }
  })

  it('goal <swarm> <title> (createGoal): the “goal posted” line never prints for B', async () => {
    const { gate, p } = await aRuns(`goal ${Object.values(useHive.getState().swarms)[0]?.name.toLowerCase().replace(/\s+/g, '-') ?? 'x'} an invented goal of A`, () => hold('createGoal'))
    gate.settle({ id: 'g_x', title: 'an invented goal of A', status: 'open' })
    await p
    expect(consoleText()).toBe('')
  })

  it('ls motivations, read late (release only: the motivations commands): neither “read” nor “could not read” prints for B', async () => {
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const client = useHive.getState().client as unknown as { listMotivations?: (q?: unknown) => Promise<unknown> }
    expect(client.listMotivations, 'the sim keeps motivations').toBeTruthy()
    let release!: () => void
    const real = client.listMotivations!.bind(client)
    client.listMotivations = (q?: unknown) => new Promise((r) => (release = () => r(real(q))))
    useHive.setState({ motivationsLoaded: false } as never)
    await run('ls motivations')
    expect(consoleText()).toMatch(/reading motivations/)
    await switchPerson(a, b)
    expect(consoleText()).toBe('')
    release()
    for (let k = 0; k < 10; k++) await new Promise((r) => setTimeout(r, 0))
    expect(consoleText()).toBe('')
  })

  it.each(['approve', 'goal'] as const)('yes on a previewed %s (decide / writeGoal): the outcome never prints for B', async (kind) => {
    const now = vi.spyOn(performance, 'now')
    try {
      {
        const a = testPerson('a')
        const b = testPerson('b', { sameTab: a })
        await signInAs(a)
        let t = 1000
        now.mockImplementation(() => t)
        if (kind === 'approve') {
          const ap = Object.values(useHive.getState().approvals)[0]
          expect(ap, 'the sim has an approval request').toBeTruthy()
          useHive.setState({ approvals: { [ap.id]: { ...ap, status: 'pending' } } })
          await run('approve 1')
        } else {
          const sw = Object.values(useHive.getState().swarms)[0]
          const g = { id: 'g_invented', swarm_id: sw.id, title: 'An invented goal of A', status: 'open', claimed_by: null, created_at: '2026-10-07T10:00:00Z', updated_at: '2026-10-07T10:00:00Z' }
          useHive.setState({ goals: { [g.id]: g } as never })
          await run('goal done 1')
        }
        t += 10_000
        const gate = hold(kind === 'approve' ? 'decide' : 'writeGoal')
        const p = run('yes')
        await Promise.resolve()
        await switchPerson(a, b)
        expect(consoleText()).toBe('')
        gate.settle(kind === 'approve' ? { id: 'x' } : { kind: 'taken', checked: false })
        await p
        expect(consoleText(), kind).toBe('')
        useHive.setState(saved as never)
        releasePersons()
      }
    } finally {
      now.mockRestore()
    }
  })
})
