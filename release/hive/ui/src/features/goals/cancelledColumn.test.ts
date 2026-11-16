import { describe, expect, it, vi } from 'vitest'

// A tester cancelled a task on Tasks and found it under Failed, as if the hive had given up on it. The board is read as
// GoalsBoard returns it, on a minimal hook runtime (no DOM library here, as in lib/closeHome.render.test.ts): which task
// cards each column holds. INVENTED tasks.
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>()
  return {
    ...real,
    useState: <T,>(init: T | (() => T)) => [typeof init === 'function' ? (init as () => T)() : init, () => undefined],
    useRef: <T,>(current: T) => ({ current }),
    useMemo: <T,>(f: () => T) => f(),
    useCallback: <T,>(f: T) => f,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useContext: (c: { _currentValue?: unknown }) => c._currentValue,
    useId: () => 'id',
    useSyncExternalStore: <T,>(_s: unknown, get: () => T) => get(),
    useDebugValue: () => undefined,
  }
})
// External Zustand's React binding is outside the stand-in's module graph: bridge only its hooks (the dualP2 pattern)
async function bridged<S>(store: { getState: () => S; subscribe: (l: () => void) => () => void }) {
  const { useSyncExternalStore } = await import('react')
  return Object.assign((sel?: (s: S) => unknown) => {
    const read = () => (sel ? sel(store.getState()) : store.getState())
    return useSyncExternalStore(store.subscribe, read, read)
  }, store)
}
vi.mock('../../store/store', async () => { const a = await vi.importActual<typeof import('../../store/store')>('../../store/store'); return { ...a, useHive: await bridged(a.useHive) } })
vi.mock('../../shell/phase', async () => { const a = await vi.importActual<typeof import('../../shell/phase')>('../../shell/phase'); return { ...a, usePhase: await bridged(a.usePhase) } })
vi.mock('../../lib/resting', async () => { const a = await vi.importActual<typeof import('../../lib/resting')>('../../lib/resting'); return { ...a, useResting: await bridged(a.useResting) } })
const win = { location: { hash: '#/tasks', search: '', pathname: '/' }, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {} }
const doc = { hidden: false, documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) }
vi.stubGlobal('window', win)
vi.stubGlobal('document', doc)
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
vi.stubGlobal('navigator', { userAgent: '', language: 'en-GB' })
const { useHive } = await import('../../store/store')
const { GoalsBoard } = await import('./GoalsBoard')

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown; goal?: { id: string } } }
const isEl = (x: unknown): x is El => !!x && typeof x === 'object' && 'props' in x
const all = (x: unknown): El[] => (Array.isArray(x) ? x.flatMap(all) : !isEl(x) ? [] : [x, ...all(x.props.children), ...all(x.props.title)])
const cards = (x: unknown) => all(x).filter((e) => e.props.goal && typeof e.props.onDecide === 'function').map((e) => e.props.goal!.id)
const goal = (id: string, status: string) => ({ id, swarm_id: 's1', parent_id: null, title: `Task ${id}`, detail: '', priority: 0.5, status, created_by: 'user:p_ada', claimed_by: null, result: null, created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:00:00Z' })

describe('the task board', () => {
  it('keeps a cancelled task out of Failed, folded at the end of Done', () => {
    useHive.setState({
      swarms: { s1: { id: 's1', name: 'Mega', description: '', hue: 120, member_ids: [], created_at: '2026-10-01T00:00:00Z' } },
      goals: Object.fromEntries([goal('g_open', 'open'), goal('g_failed', 'failed'), goal('g_cancelled', 'cancelled'), goal('g_done', 'done')].map((g) => [g.id, g])),
      goalsLoaded: { s1: true },
    } as never)
    const board = GoalsBoard({ swarmId: 's1' })
    const column = (key: string) => all(board).find((e) => e.props['data-col'] === key)
    expect(cards(column('failed'))).toEqual(['g_failed'])
    expect(cards(column('done'))).toEqual(['g_done', 'g_cancelled'])
    // the fold names what it holds
    const fold = all(column('done')).find((e) => 'data-cancelled' in e.props)
    expect(JSON.stringify(fold?.props.children)).toContain('cancelled task')
  })
})
