import { describe, expect, it, vi } from 'vitest'

// A tester opened the command list to jump to a mind and saw four of her seven under Minds: with nothing typed it showed
// the hive's pages and actions first and stopped at 40 rows. The list is read as the component returns it, on a minimal
// hook runtime (no DOM library here, as in lib/closeHome.render.test.ts). INVENTED minds and swarms.
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
// External Zustand's React binding is outside the stand-in's module graph: bridge only its hook (the dualP2 pattern)
async function bridged<S>(store: { getState: () => S; subscribe: (l: () => void) => () => void }) {
  const { useSyncExternalStore } = await import('react')
  return Object.assign((sel?: (s: S) => unknown) => {
    const read = () => (sel ? sel(store.getState()) : store.getState())
    return useSyncExternalStore(store.subscribe, read, read)
  }, store)
}
// useModalContainment asks framer-motion whether the dialog is present, through React outside the stand-in
vi.mock('framer-motion', async (orig) => ({ ...(await orig<typeof import('framer-motion')>()), useIsPresent: () => true }))
vi.mock('../../store/store', async () => { const a = await vi.importActual<typeof import('../../store/store')>('../../store/store'); return { ...a, useHive: await bridged(a.useHive) } })
const win = { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {} }
const doc = { hidden: false, documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) }
vi.stubGlobal('window', win)
vi.stubGlobal('document', doc)
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
vi.stubGlobal('navigator', { userAgent: '', language: 'en-GB' })
// useModalContainment asks whether focus is on an element: nothing is focused here
vi.stubGlobal('HTMLElement', class HTMLElement {})
const { useHive } = await import('../../store/store')
const { default: CommandPalette } = await import('./CommandPalette')

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } }
const isEl = (x: unknown): x is El => !!x && typeof x === 'object' && 'props' in x
const all = (x: unknown): El[] => (Array.isArray(x) ? x.flatMap(all) : !isEl(x) ? [] : [x, ...all(x.props.children)])

const MINDS = ['Analyst', 'Builder', 'Checker', 'Code controller', 'Critic', 'Drafter', 'Judge', 'Market Researcher', 'Mega', 'Opponent', 'Proponent', 'Scout', 'Scribe', 'Tester', 'Tutor', 'Writer']
const SWARMS = ['Business Decisions', 'Create · Code', 'Mega']

describe('the command list with nothing typed', () => {
  it('lists every mind and every swarm, however many pages and actions come first', () => {
    const swarms = Object.fromEntries(SWARMS.map((name, i) => [`s${i}`, { id: `s${i}`, name, description: '', hue: 40 * i, member_ids: [], created_at: '2026-11-01T00:00:00Z' }]))
    const agents = Object.fromEntries(MINDS.map((name, i) => [`a${i}`, { id: `a${i}`, name, kind: 'omega', status: 'asleep', model: 'stub/model', hue: 20 * i, swarm_id: `s${i % 3}` }]))
    useHive.setState({ agents, swarms } as never)
    const options = all(CommandPalette()).filter((e) => e.props.role === 'option').map((e) => String(e.props.id))
    for (const id of Object.keys(agents)) expect(options).toContain(`cmd-dot-${id}`)
    for (const id of Object.keys(swarms)) expect(options).toContain(`cmd-swarm-${id}`)
    // the pages and actions are all still there, ahead of the minds
    expect(options.indexOf('cmd-dot-a0')).toBeGreaterThan(options.indexOf('cmd-recenter'))
  })
})
