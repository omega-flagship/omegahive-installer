// Purpose: verify creation confirmations report the live mind state and protect one-time tokens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { fakeBrowser } from '../../lib/closeHome.testkit'

/**
 * The new mind's token card, rendered: the REAL TokenReveal is called on a minimal hook runtime (this repo's tests run
 * in node with no DOM library; the same approach as lib/closeHome.render.test.ts) and driven through the elements it
 * renders. The hive runs an Omega or Iter mind with its own copy of the token (the token file in the mind's workspace,
 * hive/supervisor/workspace.py), so that card closes at once and keeps the token in a fold for developers; a Module
 * runs outside the hive, so its card still waits for "I have stored the token somewhere safe". Invented data only.
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
// Esc as the card registers it: the handler and whether it is switched on
const esc: { fn: (() => void) | null; active: boolean } = { fn: null, active: false }
vi.mock('../../lib/hooks', async (orig) => ({
  ...(await orig<typeof import('../../lib/hooks')>()),
  useEscape: (fn: () => void, active = true) => {
    esc.fn = fn
    esc.active = active
  },
}))

// the focus trap reads framer-motion's presence context, which only a real React tree provides; it is not what this checks
vi.mock('../../ui/useModalContainment', () => ({ useModalContainment: () => undefined }))

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
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => typeof x === 'string').join('') : ''
}
const find = (tree: unknown, pick: (e: El) => boolean): El => {
  const hit = all(tree).find(pick)
  if (!hit) throw new Error('not rendered')
  return hit
}
const has = (tree: unknown, pick: (e: El) => boolean) => all(tree).some(pick)
const button = (label: string) => (e: El) => typeof e.props?.onClick === 'function' && textOf(e) === label
const checkbox = (e: El) => e.type === 'input' && e.props?.type === 'checkbox'
const tokenCode = (token: string) => (e: El) => e.type === 'code' && e.props?.children === token
/** Render one component: its own hooks only; child components stay elements. */
function render(C: () => unknown): ReactElement {
  rt.i = 0
  return C() as ReactElement
}

const TOKEN = 'invented-token-0000'
const mind = (kind: string) => ({ id: `a_${kind}`, name: `Test ${kind}`, hue: 200, model: 'invented/model', status: 'starting', kind, swarm_id: null, created_at: '2026-11-09T00:00:00Z' })

let b: ReturnType<typeof fakeBrowser>
async function card(kind: string) {
  b = fakeBrowser('#/')
  const { useHive } = await import('../../store/store')
  const agent = mind(kind)
  useHive.setState({ agents: { [agent.id]: agent }, reveal: { agent, token: TOKEN } } as never)
  const { default: TokenReveal } = await import('./TokenReveal')
  return { useHive, draw: () => render(TokenReveal as never) as unknown }
}
beforeEach(() => {
  vi.resetModules()
  rt.cur = []
  esc.fn = null
  esc.active = false
})
afterEach(() => vi.unstubAllGlobals())

describe('a mind the hive runs: its card closes at once', { timeout: 30_000 }, () => {
  it('reports saved and starting, then a failed start from live state without claiming the mind is alive', async () => {
    const { useHive, draw } = await card('omega')
    const title = (tree: unknown) => textOf(find(tree, (e) => e.props?.id === 'reveal-title'))
    expect(title(draw())).toBe('Test omega is saved')
    expect(textOf(find(draw(), (e) => e.props?.id === 'reveal-state'))).toBe('It is starting. It is not ready to talk yet.')
    const state = useHive.getState()
    useHive.setState({ agents: { ...state.agents, a_omega: { ...state.agents.a_omega, status: 'error' } } })
    const failed = draw()
    expect(title(failed)).toBe('Test omega is saved')
    expect(find(failed, (e) => e.props?.id === 'reveal-state').props?.role).toBe('alert')
    expect(textOf(find(failed, (e) => e.props?.id === 'reveal-state'))).toContain('hit an error and is not ready to talk')
    expect(all(failed).map(textOf).join(' ')).not.toContain('is alive')
    useHive.setState({ agents: { ...state.agents, a_omega: { ...state.agents.a_omega, status: 'awake' } } })
    expect(textOf(find(draw(), (e) => e.props?.id === 'reveal-state'))).toBe('It is running.')
  })

  it.each(['omega', 'iter'])('%s: Done, Open and Esc work without the tick, and the token waits in a fold for developers', async (kind) => {
    const { useHive, draw } = await card(kind)
    const tree = draw()
    expect(has(tree, checkbox)).toBe(false)
    expect(find(tree, button('Done')).props!.disabled).toBe(false)
    expect(find(tree, (e) => textOf(e) === `Open Test ${kind}` && typeof e.props?.onClick === 'function').props!.disabled).toBe(false)
    expect(esc.active).toBe(true)
    expect(find(tree, (e) => e.props?.id === 'reveal-note').props!.children).toBe(`The hive keeps its token and uses it to run Test ${kind}, so you do not need to store it.`)
    // the token is still there, once, inside the fold
    const fold = find(tree, (e) => e.type === 'details')
    expect(textOf(find(fold, (e) => e.type === 'summary'))).toBe('Agent token, for developers')
    expect(all(tree).filter(tokenCode(TOKEN))).toHaveLength(1)
    expect(has(fold, tokenCode(TOKEN))).toBe(true)
    // Done: back to the hive, one step
    ;(find(tree, button('Done')).props!.onClick as () => void)()
    expect((useHive.getState() as { reveal: unknown }).reveal).toBeNull()
  })

  it('Esc closes it', async () => {
    const { useHive, draw } = await card('omega')
    draw()
    expect(esc.active).toBe(true) // registered and switched on: the page's Esc reaches it
    esc.fn!()
    expect((useHive.getState() as { reveal: unknown }).reveal).toBeNull()
  })

  it('Open closes it and goes to the new mind', async () => {
    const { useHive, draw } = await card('omega')
    const open = find(draw(), (e) => textOf(e) === 'Open Test omega' && typeof e.props?.onClick === 'function')
    expect(open.props!.disabled).toBe(false) // a disabled button's click never reaches its handler
    ;(open.props!.onClick as () => void)()
    expect((useHive.getState() as { reveal: unknown }).reveal).toBeNull()
    expect(b.location.hash).toBe('#/dot/a_omega')
  })
})

describe('a module, which runs outside the hive: its card keeps the tick', { timeout: 30_000 }, () => {
  it('shows the token and the once-only warning, and Done, Open and Esc wait until the person has stored it', async () => {
    const { useHive, draw } = await card('module')
    let tree = draw()
    expect(has(tree, (e) => e.type === 'details')).toBe(false)
    expect(has(tree, tokenCode(TOKEN))).toBe(true)
    expect(has(tree, (e) => e.props?.id === 'reveal-warn')).toBe(true)
    expect(find(tree, button('Done')).props!.disabled).toBe(true)
    expect(find(tree, (e) => textOf(e) === 'Open Test module' && typeof e.props?.onClick === 'function').props!.disabled).toBe(true)
    expect(esc.active).toBe(false)
    ;(find(tree, checkbox).props!.onChange as (e: unknown) => void)({ target: { checked: true } })
    tree = draw()
    expect(find(tree, button('Done')).props!.disabled).toBe(false)
    expect(esc.active).toBe(true)
    ;(find(tree, button('Done')).props!.onClick as () => void)()
    expect((useHive.getState() as { reveal: unknown }).reveal).toBeNull()
  })
})
