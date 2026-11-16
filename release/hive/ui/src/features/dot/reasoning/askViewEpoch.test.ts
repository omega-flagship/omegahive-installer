import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Root r5 intake, bounded Ask origin correction (Kimi's stale-PageView observation): the reasoning viewers' PageView is
 * bound to the identity epoch through useAskView's existing displayedOriginCurrent seam, so a change of person drops
 * it at once. The hooks run as in viewLifecycle.test.ts (effects synchronously, kept until cleaned); the person switch
 * is the REAL store identity change (lib/identityEpoch.testkit), and the Ask's view is read before any effect of the
 * new person runs and before the old export's cleanup. Synthetic SimClients and an invented mind only; no hive.
 */
const effects: (() => void)[] = []
vi.mock('react', async (importOriginal) => {
  const R = await importOriginal<typeof import('react')>()
  const hooks = {
    useEffect: (effect: () => (() => void) | undefined) => {
      const cleanup = effect()
      if (cleanup) effects.push(cleanup)
    },
    useMemo: <T,>(make: () => T) => make(),
    useCallback: <T,>(f: T) => f,
    useRef: <T,>(current: T) => ({ current }),
    useDebugValue: () => undefined,
    useState: <T,>(init: T | (() => T)) => [typeof init === 'function' ? (init as () => T)() : init, () => undefined],
    useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  }
  return { ...R, ...hooks, default: { ...(R as unknown as { default: object }).default, ...hooks } }
})
// zustand (a dependency, not inlined) keeps the real React; its hook reads the same REAL store here (getState,
// subscribe and setState are the store's own, so the identity epoch and the testkit see exactly what they always do)
vi.mock('../../../store/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../store/store')>()
  const store = real.useHive
  const useHive = Object.assign(<T,>(select: (s: ReturnType<typeof store.getState>) => T) => select(store.getState()), store)
  return { ...real, useHive }
})
afterEach(async () => {
  effects.splice(0).reverse().forEach((cleanup) => cleanup())
  const { releasePersons } = await import('../../../lib/identityEpoch.testkit')
  releasePersons()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the reasoning viewers’ Ask view follows the person', () => {
  it('a person switch invalidates the previous person’s PageView at once, before effects run', async () => {
    vi.stubGlobal('window', { location: { search: '', hash: '#/dot/a_invented/tools', pathname: '/' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) })
    const { signInAs, switchPerson, testPerson } = await import('../../../lib/identityEpoch.testkit')
    const { currentView } = await import('../../ask/view')
    const { ReasoningModules } = await import('./ReasoningModules')
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    const agent = { id: 'a_invented', name: 'Invented', swarm_id: null } as unknown as Parameters<typeof ReasoningModules>[0]['agent']
    ReasoningModules({ agent })
    expect(currentView()?.scope).toBe('mind-reasoning')
    const cleanups = effects.length
    const done = switchPerson(a, b)
    // synchronously after the identity change: no effect has run or been cleaned up, and A's view is not returned
    expect(effects.length).toBe(cleanups)
    expect(currentView()).toBeNull()
    await done
    expect(currentView()).toBeNull()
  })

  it('a re-login on the same tab (credential only) invalidates it too', async () => {
    vi.stubGlobal('window', { location: { search: '', hash: '#/dot/a_invented/tools', pathname: '/' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) })
    const { signInAs, switchPerson, testPerson } = await import('../../../lib/identityEpoch.testkit')
    const { currentView } = await import('../../ask/view')
    const { ReasoningModules } = await import('./ReasoningModules')
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    await signInAs(a)
    ReasoningModules({ agent: { id: 'a_invented', name: 'Invented', swarm_id: null } as unknown as Parameters<typeof ReasoningModules>[0]['agent'] })
    expect(currentView()?.scope).toBe('mind-reasoning')
    const done = switchPerson(a, b)
    expect(currentView()).toBeNull()
    await done
  })
})
