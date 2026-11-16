import { describe, expect, it, vi } from 'vitest'

// A tester meaning to talk to a mind pressed Sleep, which sat next to Talk on its selection bar. The bar is read as
// SelectionActions returns it (no DOM library here: hooks answer from the store, as in actionAuthority.mounted.test.ts).
// INVENTED minds.
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>()
  return { ...real, useContext: (c: { _currentValue?: unknown }) => c._currentValue, useSyncExternalStore: <T,>(_s: unknown, get: () => T) => get(), useDebugValue: () => undefined }
})
// External Zustand's React binding is outside the stand-in's module graph: bridge only its hook (the dualP2 pattern)
async function bridged<S>(store: { getState: () => S; subscribe: (l: () => void) => () => void }) {
  const { useSyncExternalStore } = await import('react')
  return Object.assign((sel?: (s: S) => unknown) => {
    const read = () => (sel ? sel(store.getState()) : store.getState())
    return useSyncExternalStore(store.subscribe, read, read)
  }, store)
}
vi.mock('../../store/store', async () => { const a = await vi.importActual<typeof import('../../store/store')>('../../store/store'); return { ...a, useHive: await bridged(a.useHive) } })
const win = { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {} }
const doc = { hidden: false, documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) }
vi.stubGlobal('window', win)
vi.stubGlobal('document', doc)
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
vi.stubGlobal('navigator', { userAgent: '', language: 'en-GB' })
const { useHive } = await import('../../store/store')
const { SelectionActions } = await import('./index')

type El = { type: unknown; props: { children?: unknown } }
const words = (x: unknown): string => (typeof x === 'string' ? x : Array.isArray(x) ? x.map(words).join('') : x && typeof x === 'object' && 'props' in x ? words((x as El).props.children) : '')
const bar = (status: 'awake' | 'asleep') => {
  const first = Object.values(useHive.getState().agents)[0]
  useHive.setState({ agents: { ...useHive.getState().agents, a_bar: { ...first, id: 'a_bar', name: 'Proponent', status } } })
  const out = SelectionActions({ item: { kind: 'mind', id: 'a_bar', key: 'mind:a_bar' } as never, openChat() {}, startDraft() {}, flyToItem() {}, openInspect() {}, askGoal() {} }) as El
  return ([] as unknown[]).concat(out.props.children).filter(Boolean).map(words)
}

describe("a mind's selection bar on the Canvas", () => {
  it('keeps Sleep away from Talk, last on the bar', () => {
    expect(bar('awake')).toEqual(['Talk', 'Mind', 'Memory', 'Sleep'])
  })
  it('puts Wake last too, for a mind that is asleep', () => {
    expect(bar('asleep')).toEqual(['Talk', 'Mind', 'Memory', 'Wake'])
  })
})
