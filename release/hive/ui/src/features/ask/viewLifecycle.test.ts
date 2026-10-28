import { afterEach, describe, expect, it, vi } from 'vitest'

/** Native hook lifecycle stand-in, invented window only. Root executes; no browser/React paint claim. */
const effects: (() => void)[] = []
vi.mock('react', () => ({
  useEffect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) effects.push(cleanup) },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}))
afterEach(() => { effects.splice(0).reverse().forEach((cleanup) => cleanup()); vi.unstubAllGlobals(); vi.resetModules() })

describe('Ask view native hash watch lifecycle', () => {
  it('imports with the actual existing minimal-window fixture shape without calling an absent listener', async () => {
    vi.stubGlobal('window', { location: { hash: '#/' } })
    const { currentView } = await import('./view')
    expect(currentView()).toBeNull()
  })
  it('watches once for concurrent mounted exporters, invalidates an old visit, and removes the last watch', async () => {
    const add = vi.fn(), remove = vi.fn()
    vi.stubGlobal('window', { location: { hash: '#/' }, addEventListener: add, removeEventListener: remove })
    const { useAskView, currentView } = await import('./view')
    expect(add).not.toHaveBeenCalled()
    useAskView('invented-a', { refs: [{ kind: 'mind', ref: 'a_invented' }] }, () => true)
    useAskView('invented-b', { refs: [{ kind: 'swarm', ref: 's_invented' }] }, () => true)
    expect(add).toHaveBeenCalledTimes(1)
    expect(currentView()?.scope).toBe('invented-b')
    const listener = add.mock.calls[0][1] as () => void
    listener(); expect(currentView()).toBeNull()
    effects.shift()!(); expect(remove).not.toHaveBeenCalled()
    effects.shift()!(); expect(remove).toHaveBeenCalledWith('hashchange', listener)
    expect(currentView()).toBeNull()
  })
})
