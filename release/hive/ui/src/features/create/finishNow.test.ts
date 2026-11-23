import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { fakeBrowser } from '../../lib/closeHome.testkit'

/**
 * Create now and Launch now: the REAL wizards, Create a mind and Start a swarm, are called on a minimal hook runtime
 * (this repo's tests run in node with no DOM library; the same approach as lib/closeHome.render.test.ts) and driven
 * through the elements they render. From the first page, a typed name and one click finish with what the later pages
 * hold by default, where Continue, Continue, Continue and the last page's button took four. Invented data only.
 */

// ---- a minimal hook runtime: one component render at a time; state survives re-renders until the next test ----
const rt = { cur: [] as unknown[], i: 0 }
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>()
  const slot = <T,>(init: () => T): { v: T } => {
    const k = rt.i++
    if (!(k in rt.cur)) rt.cur[k] = { v: init() }
    return rt.cur[k] as { v: T }
  }
  return {
    ...real,
    useState: <T,>(init: T | (() => T)) => {
      const s = slot(() => (typeof init === 'function' ? (init as () => T)() : init))
      return [s.v, (v: T | ((p: T) => T)) => (s.v = typeof v === 'function' ? (v as (p: T) => T)(s.v) : v)]
    },
    useRef: <T,>(init: T) => slot(() => ({ current: init })).v,
    useMemo: <T,>(f: () => T) => f(),
    useCallback: <T,>(f: T) => f,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useId: () => 'id',
    useSyncExternalStore: <T,>(_s: unknown, get: () => T) => get(),
  }
})
// zustand is loaded outside vitest's module graph (it would reach the real React dispatcher): its hooks read the store
vi.mock('zustand', async (orig) => {
  const real = await orig<typeof import('zustand')>()
  type Init = (...a: never[]) => unknown
  const make = (init: Init) => {
    const api = real.createStore(init as never) as { getState: () => unknown }
    const hook = (sel: (s: unknown) => unknown = (s) => s) => sel(api.getState())
    return Object.assign(hook, api)
  }
  return { ...real, create: (init?: Init) => (init ? make(init) : make) }
})
vi.mock('../../lib/hooks', async (orig) => ({ ...(await orig<typeof import('../../lib/hooks')>()), useReducedMotion: () => true }))

type El = { type?: unknown; props?: Record<string, unknown> }
function all(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out))
  else if (node && typeof node === 'object' && 'props' in node) {
    const e = node as El
    out.push(e)
    for (const v of Object.values(e.props ?? {})) if (v && typeof v === 'object') all(v, out)
  }
  return out
}
const textOf = (e: El): string => {
  const c = e.props?.children
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => typeof x === 'string' || typeof x === 'number').join('') : ''
}
const find = (tree: unknown, pick: (e: El) => boolean): El => {
  const hit = all(tree).find(pick)
  if (!hit) throw new Error('not rendered')
  return hit
}
const has = (tree: unknown, pick: (e: El) => boolean) => all(tree).some(pick)
const button = (label: string) => (e: El) => typeof e.props?.onClick === 'function' && textOf(e) === label
const press = (tree: unknown, label: string) => (find(tree, button(label)).props!.onClick as () => void)()
const type = (field: El, value: string) => (field.props!.onChange as (e: unknown) => void)({ target: { value } })
/** Render one component: its own hooks only; child components stay elements. */
function render<P>(C: (p: P) => unknown, props: P): ReactElement {
  rt.i = 0
  return C(props) as ReactElement
}

const model = { id: 'invented/sonnet-like', provider: 'invented', label: 'Invented Sonnet', local: false }
const lyre = { id: 's_lyre', name: 'Invented Lyre', description: 'an invented swarm', hue: 220, member_ids: [], created_at: '2026-10-01T00:00:00Z' }
// a person's personal swarm: the hive refuses a second mind there (core/personal.py personal_swarm)
const own = { id: 's_own', name: 'Invented Own', description: 'Personal mind', hue: 90, member_ids: ['a_own'], created_at: '2026-09-01T00:00:00Z', personal_of: 'user:u_invented' }
const mindNamed = (name: string) => ({ id: `a_${name}`, name, hue: 200, model: model.id, status: 'awake', kind: 'omega', swarm_id: null, created_at: '2026-10-08T00:00:00Z' })

let b: ReturnType<typeof fakeBrowser>
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  rt.cur = []
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mindWizard(state: Record<string, unknown>) {
  b = fakeBrowser('#/new')
  const { useHive } = await import('../../store/store')
  const made: unknown[] = []
  const started: [string, string][] = []
  useHive.setState({
    models: [model],
    catalog: null,
    agents: {},
    swarms: { s_own: own, s_lyre: lyre },
    keys: [],
    toast: () => undefined,
    createAgent: async (body: { name: string }) => {
      made.push(body)
      return { ...mindNamed(body.name), token: 'tok_invented' }
    },
    agentAction: async (id: string, action: string) => (started.push([id, action]), true),
    ...state,
  } as never)
  const { default: CreateFlow } = await import('./CreateFlow')
  const draw = (props: Record<string, unknown> = {}) => render(CreateFlow as never, props) as unknown
  return { useHive, made, started, draw }
}

describe('Create a mind: Create now on the first page', { timeout: 30_000 }, () => {
  it('a typed name and one click make the mind with the later pages’ defaults, as the review page would have', async () => {
    const { useHive, made, started, draw } = await mindWizard({})
    type(find(draw(), (e) => e.props?.id === 'dot-name'), 'Test mind')
    const first = draw()
    expect(textOf(find(first, (e) => e.type === 'h2'))).toBe('What should it help you with?') // still the first page
    expect(textOf(find(first, (e) => e.props?.id === 'create-now-note'))).toBe('Create now makes Test mind on its own, on Invented Sonnet.')
    expect(find(first, button('Create now')).props!.disabled).toBe(false)
    press(first, 'Create now')
    // the review page shows what is being made while it is made
    const review = draw()
    expect(textOf(find(review, (e) => e.type === 'h2'))).toBe('Bring it to life')
    await vi.runAllTimersAsync()
    expect(made).toEqual([
      { name: 'Test mind', kind: 'omega', swarm_id: null, model: model.id, persona: undefined, hue: expect.any(Number), budget_usd: 0, options: undefined, role_id: null, visibility: 'private', shared_with: undefined },
    ])
    // made and started, so it answers the first message without anyone finding Start
    expect(started).toEqual([['a_Test mind', 'start']])
    expect(b.location.hash).toBe('#/') // back on the hive view
    expect((useHive.getState() as { reveal?: { agent: { name: string }; token: string } }).reveal).toMatchObject({ agent: { name: 'Test mind' }, token: 'tok_invented' })
  })

  it('waits for a name, like Continue, and says so', async () => {
    const { made, draw } = await mindWizard({})
    const empty = draw()
    expect(find(empty, button('Create now')).props!.disabled).toBe(true)
    expect(find(empty, button('Continue')).props!.disabled).toBe(true)
    expect(textOf(find(empty, (e) => e.props?.id === 'create-now-note'))).toBe('Give it a name to create it.')
    expect(made).toEqual([])
  })

  it('a taken name keeps it closed with the same words the name field shows', async () => {
    const { draw } = await mindWizard({ agents: { a_taken: mindNamed('Test mind') } })
    type(find(draw(), (e) => e.props?.id === 'dot-name'), 'test MIND')
    const page = draw()
    expect(find(page, button('Create now')).props!.disabled).toBe(true)
    expect(textOf(find(page, (e) => e.props?.id === 'create-now-note'))).toBe('That name is taken')
  })

  it('with no model to run it on, it names the page that chooses one', async () => {
    const { draw } = await mindWizard({ models: [] })
    type(find(draw(), (e) => e.props?.id === 'dot-name'), 'Test mind')
    const page = draw()
    expect(find(page, button('Create now')).props!.disabled).toBe(true)
    expect(find(page, button('Continue')).props!.disabled).toBe(false) // Home is where the model is chosen
    expect(textOf(find(page, (e) => e.props?.id === 'create-now-note'))).toBe('Choose a model under Home to create it.')
  })

  it('stays beside Continue on Home and Mind, and the review page keeps its own button', async () => {
    const { draw } = await mindWizard({ swarms: {} })
    type(find(draw(), (e) => e.props?.id === 'dot-name'), 'Test mind')
    for (const title of ['Where does it work?', 'A few details']) {
      press(draw(), 'Continue')
      const page = draw()
      expect(textOf(find(page, (e) => e.type === 'h2'))).toBe(title)
      expect(has(page, button('Create now'))).toBe(true)
      expect(textOf(find(page, (e) => e.props?.id === 'create-now-note'))).toBe('Create now makes Test mind on its own, on Invented Sonnet.')
    }
    press(draw(), 'Continue')
    const review = draw()
    expect(has(review, button('Create now'))).toBe(false)
    expect(has(review, (e) => e.props?.id === 'create-now-note')).toBe(false)
    expect(has(review, button('Bring Test mind to life'))).toBe(true)
  })
})

describe('Create a mind: everyday words, homes the hive accepts, and a mind that starts', { timeout: 30_000 }, () => {
  it('opens on what it should help with, then its name, with the kind already chosen in plain words', async () => {
    const { draw } = await mindWizard({})
    const first = draw()
    const words = all(first).map(textOf).join(' ')
    expect(textOf(find(first, (e) => e.type === 'h2'))).toBe('What should it help you with?')
    const fields = all(first).filter((e) => e.type === 'textarea' || e.type === 'input').map((e) => e.props?.id)
    expect(fields.indexOf('dot-persona')).toBeLessThan(fields.indexOf('dot-name'))
    expect(words).toContain('A full mind')
    for (const gone of ['neural-symbolic', 'MeTTa', 'AtomSpace', 'hue', 'publishes', 'Wanderer', 'rumours']) expect(words, gone).not.toContain(gone)
  })

  it('offers on its own and every group a new mind may join, never a person’s own swarm, which the hive refuses', async () => {
    const { draw } = await mindWizard({})
    type(find(draw(), (e) => e.props?.id === 'dot-name'), 'Test mind')
    press(draw(), 'Continue')
    const home = draw()
    // each choice is a Choice element (the runtime renders one component, so its children stay elements)
    const offered = all(home).filter((e) => typeof e.props?.on === 'boolean' && typeof e.props?.title === 'string').map((e) => e.props?.title)
    expect(offered).toEqual(['On its own', 'Invented Lyre'])
    expect(find(home, (e) => e.props?.title === 'On its own').props!.on).toBe(true)
  })

  it('keeps a home the page it came from names, but never a personal swarm named that way', async () => {
    const named = await mindWizard({})
    type(find(named.draw({ swarmId: 's_lyre' }), (e) => e.props?.id === 'dot-name'), 'Test mind')
    expect(textOf(find(named.draw({ swarmId: 's_lyre' }), (e) => e.props?.id === 'create-now-note'))).toBe('Create now makes Test mind in Invented Lyre, on Invented Sonnet.')
    rt.cur = []
    const personal = await mindWizard({})
    type(find(personal.draw({ swarmId: 's_own' }), (e) => e.props?.id === 'dot-name'), 'Test mind')
    expect(textOf(find(personal.draw({ swarmId: 's_own' }), (e) => e.props?.id === 'create-now-note'))).toContain('on its own')
  })

  it('a tool is made but never started', async () => {
    const { made, started, draw } = await mindWizard({})
    type(find(draw(), (e) => e.props?.id === 'dot-name'), 'Test tool')
    ;(find(draw(), (e) => e.props?.title === 'A tool').props!.onClick as () => void)()
    press(draw(), 'Create now')
    await vi.runAllTimersAsync()
    expect(made).toHaveLength(1)
    expect(started).toEqual([])
  })
})

// the hive's own month limit, as GET /api/budgets lists it to anyone (limits_view.scope_visible)
const hiveMonth = { id: 'r_hive', scope: 'hive', period: 'month', limit_usd: 50, spent_usd: 0, note: '', origin: 'rule' }
// the hive cap is the hive's month rule, else its day rule (Budgets.hive_cap); a total holds no mind with no cap of its own
const hiveDay = { ...hiveMonth, id: 'r_hive_day', period: 'day' }
const hiveTotal = { ...hiveMonth, id: 'r_hive_total', period: 'total' }

describe('Create a mind: what holds a mind with no cap of its own', { timeout: 30_000 }, () => {
  it('a mind made on its own or in a team starts with no cap of its own', async () => {
    const { made, draw } = await mindWizard({ swarms: { s_lyre: lyre }, budgets: [hiveMonth] })
    type(find(draw({ swarmId: 's_lyre' }), (e) => e.props?.id === 'dot-name'), 'Test mind')
    press(draw(), 'Create now')
    await vi.runAllTimersAsync()
    expect(made).toMatchObject([{ swarm_id: 's_lyre', budget_usd: 0 }])
  })

  it('calls the hive’s limit the mind’s bound only once the limits are read and hold one, and warns when they hold none', async () => {
    const details = async (budgets: unknown) => {
      rt.cur = []
      const w = await mindWizard({ budgets })
      type(find(w.draw(), (e) => e.props?.id === 'dot-name'), 'Test mind')
      press(w.draw(), 'Continue')
      press(w.draw(), 'Continue')
      return all(w.draw()).map(textOf).join(' ')
    }
    expect(await details([hiveMonth])).toContain('The hive\'s monthly limit holds what it spends, and Usage shows it.')
    expect(await details([hiveDay])).toContain('The hive\'s daily limit holds what it spends, and Usage shows it.')
    expect(await details([])).toContain('The hive has no monthly limit yet, so a mind on a paid model can\'t answer.')
    expect(await details([hiveTotal])).toContain('The hive has no monthly limit yet, so a mind on a paid model can\'t answer.')
    const unread = await details(null)   // limits not read (yet): neither claimed
    expect(unread).toContain('What it spends shows under Usage.')
    expect(unread).not.toContain('The hive\'s monthly limit holds')
    expect(unread).not.toContain('The hive has no monthly limit yet')
  })

  it('reads the limits this person may see as a page opens, a member included, whom budgets.updated never reaches', async () => {
    const { useHive } = await mindWizard({ budgets: null, client: { listBudgets: async () => [hiveMonth] } })
    await (useHive.getState() as unknown as { loadBudgets: () => Promise<void> }).loadBudgets()
    expect((useHive.getState() as unknown as { budgets: unknown }).budgets).toEqual([hiveMonth])
  })
})

async function swarmWizard(agents: Record<string, unknown>, state: Record<string, unknown> = {}) {
  b = fakeBrowser('#/swarms/new')
  const { useHive } = await import('../../store/store')
  const calls: [string, ...unknown[]][] = []
  const client = {
    createSwarm: async (body: { name: string; description: string; hue: number }) => {
      calls.push(['createSwarm', body])
      return { id: 's_new', name: body.name, description: body.description, hue: body.hue, member_ids: [], created_at: '2026-11-09T00:00:00Z' }
    },
    createAgent: async (body: { name: string }) => {
      calls.push(['createAgent', body])
      return { ...mindNamed(body.name), token: 'tok_invented' }
    },
    agentAction: async (id: string, action: string) => void calls.push(['agentAction', id, action]),
    createGoal: async (swarm: string, body: unknown) => void calls.push(['createGoal', swarm, body]),
    setBudget: async (body: unknown) => void calls.push(['setBudget', body]),
  }
  useHive.setState({ client, models: [model], catalog: null, agents, roles: null, ...state } as never)
  const { default: LaunchSwarm } = await import('../launch/LaunchSwarm')
  const draw = () => render(LaunchSwarm as never, {}) as unknown
  const nameField = (tree: unknown) => find(tree, (e) => e.type === 'input' && e.props?.placeholder === 'e.g. Market Watch, Bridge Build, Reading Group')
  return { calls, draw, nameField }
}

describe('Start a swarm: Launch now on the first page', { timeout: 30_000 }, () => {
  it('a typed name and one click launch the Research swarm awake, with its first task and no cap on any mind', async () => {
    const { calls, draw, nameField } = await swarmWizard({})
    type(nameField(draw()), 'Test swarm')
    const first = draw()
    expect(textOf(find(first, (e) => e.props?.id === 'launch-now-note'))).toBe('Launch now starts 3 minds on Invented Sonnet.')
    expect(find(first, button('Launch now')).props!.disabled).toBe(false)
    press(first, 'Launch now')
    await vi.runAllTimersAsync()
    expect(calls.map((c) => c[0])).toEqual(['createSwarm', 'createAgent', 'agentAction', 'createAgent', 'agentAction', 'createAgent', 'agentAction', 'createGoal'])
    expect(calls[0][1]).toEqual({ name: 'Test swarm', description: '', hue: 196, visibility: 'private', shared_with: undefined })
    const minds = calls.filter((c) => c[0] === 'createAgent').map((c) => c[1] as { name: string; swarm_id: string; model: string; budget_usd: number })
    expect(minds.map((m) => [m.name, m.swarm_id, m.model, m.budget_usd])).toEqual([
      ['Scout', 's_new', model.id, 0],
      ['Analyst', 's_new', model.id, 0],
      ['Sceptic', 's_new', model.id, 0],
    ])
    expect(calls.at(-1)).toEqual(['createGoal', 's_new', { title: 'Research a question and report what the evidence supports, with sources and honest confidence', priority: 0.7 }])
    // the Launch page, with what was made and where to go next
    const done = draw()
    expect(has(done, button('Open Test swarm'))).toBe(true)
    expect(has(done, button('Launch now'))).toBe(false)
  })

  it('when a default mind name is taken, it stays closed and names the mind and the page that renames it', async () => {
    const { calls, draw, nameField } = await swarmWizard({ a_scout: mindNamed('Scout') })
    type(nameField(draw()), 'Test swarm')
    const first = draw()
    expect(find(first, button('Launch now')).props!.disabled).toBe(true)
    expect(find(first, button('Continue')).props!.disabled).toBe(false)
    expect(textOf(find(first, (e) => e.props?.id === 'launch-now-note'))).toBe('Rename Scout under Minds: each mind needs a name not used anywhere else in the hive.')
    expect(calls).toEqual([])
  })

  it('waits for the swarm’s name and says so', async () => {
    const { draw } = await swarmWizard({})
    const empty = draw()
    expect(find(empty, button('Launch now')).props!.disabled).toBe(true)
    expect(textOf(find(empty, (e) => e.props?.id === 'launch-now-note'))).toBe('Name the swarm to launch it.')
  })
})

describe('Start a swarm: what holds minds with no cap of their own', { timeout: 30_000 }, () => {
  const limits = async (budgets: unknown, removed: string[] = []) => {
    rt.cur = []
    const w = await swarmWizard({}, { budgets })
    type(w.nameField(w.draw()), 'Test swarm')
    press(w.draw(), 'Continue')
    removed.forEach((name) => (find(w.draw(), (e) => e.props?.['aria-label'] === `Remove ${name}`).props!.onClick as () => void)())
    press(w.draw(), 'Continue')
    return all(w.draw()).map(textOf).join(' ')
  }

  it('warns, naming them, when the hive has no limit and its minds are on a paid model', async () => {
    const words = await limits([])
    expect(words).toContain('What these minds spend comes out of the hive\'s limits, which its owner sets on Usage and limits')
    expect(words).toContain('The hive has no monthly limit yet, so a mind on a paid model can\'t answer (Scout, Analyst, Sceptic). Set the hive\'s on Usage and limits, or pick a model on this computer for it under Minds.')
    expect(words).not.toContain('Budget for')
  })

  it('names only the minds still in the swarm', async () => {
    expect(await limits([], ['Analyst', 'Sceptic'])).toContain('can\'t answer (Scout).')
  })

  it('warns of nothing when the hive has a limit, or when its limits are not read yet', async () => {
    for (const budgets of [[hiveMonth], [hiveDay], null]) {
      const words = await limits(budgets)
      expect(words).toContain('What these minds spend comes out of the hive\'s limits')
      expect(words).not.toContain('The hive has no monthly limit yet')
    }
  })

  it('warns when the hive’s only limit is a total, which holds no mind with no cap of its own', async () => {
    expect(await limits([hiveTotal])).toContain('The hive has no monthly limit yet')
  })
})
