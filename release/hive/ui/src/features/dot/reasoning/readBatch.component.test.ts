import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The reasoning viewers' component and its read-batch helper agree (Root 173038Z): ReasoningModules is run with its
 * hooks stood in (one instance: refs and state keep across its renders; effects run on render and are cleaned up as
 * React does), against a synthetic client that counts every read it is sent and resolves each when the test says.
 *  - a StrictMode replay (setup, cleanup, setup in one commit) sends ONE batch of six reads, and its answers land;
 *  - an unmount mid-read writes nothing when the answers come;
 *  - another mind, or another client, sends a fresh batch, and the earlier batch's late answers write nothing;
 *  - the identity-epoch refusal still holds as a second layer: an epoch change refuses the batch's answers even
 *    while the batch itself is live.
 * Invented ids only; no hive.
 */
type Cleanup = () => void
let effects: { deps: unknown[] | undefined; cleanup?: Cleanup }[] = []
let slot = 0
let refs: { current: unknown }[] = []
let states: unknown[] = []
const writes: unknown[] = []

vi.mock('react', async (importOriginal) => {
  const R = await importOriginal<typeof import('react')>()
  const hooks = {
    useEffect: (effect: () => Cleanup | undefined, deps?: unknown[]) => {
      const i = slot++
      const prev = effects[i]
      if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps![k]))) return
      prev?.cleanup?.()
      effects[i] = { deps, cleanup: effect() ?? undefined }
    },
    useMemo: <T,>(make: () => T) => make(),
    useCallback: <T,>(f: T) => f,
    useDebugValue: () => undefined,
    useRef: <T,>(current: T) => {
      const i = slot++
      return (refs[i] ??= { current }) as { current: T }
    },
    useState: <T,>(init: T | (() => T)) => {
      const i = slot++
      if (!(i in states)) states[i] = typeof init === 'function' ? (init as () => T)() : init
      return [states[i], (v: unknown) => writes.push(typeof v === 'function' ? (v as (p: unknown) => unknown)(states[i]) : v)]
    },
    useSyncExternalStore: (_s: unknown, read: () => unknown) => read(),
  }
  return { ...R, ...hooks, default: { ...(R as unknown as { default: object }).default, ...hooks } }
})
let epoch = 1
let client: unknown = null
vi.mock('../../../store/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../store/store')>()
  // the component reads `client` through this hook; everything else keeps the real store
  const useHive = Object.assign(<T,>(select: (s: { client: unknown }) => T) => select({ client }), real.useHive)
  return { ...real, useHive }
})
vi.mock('../../../lib/epochBound', () => ({ useIdentityEpoch: () => epoch }))
vi.mock('../../../lib/identityEpoch', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/identityEpoch')>()
  return {
    ...real,
    bindEpoch: () => {
      const at = epoch
      const current = () => epoch === at
      return { epoch: at, current, commit: <R,>(w: () => R) => (current() ? w() : real.STALE) }
    },
  }
})
vi.mock('../../ask/view', () => ({ useAskView: () => undefined }))

const { ReasoningModules } = await import('./ReasoningModules')

/** A synthetic client: the reader declared; every read is counted and held until `release()`. */
function reader() {
  const sent: string[] = []
  const held: (() => void)[] = []
  return {
    sent,
    release: async () => {
      held.splice(0).forEach((f) => f())
      for (let i = 0; i < 10; i++) await Promise.resolve()
    },
    program: async () => ({ enabled: true, error: null, describe: { reads: [{ id: 'reasoning-module' }] } }),
    programRead: (_id: string, _s: string, _q: string, p: { ref: string }) => {
      sent.push(p.ref)
      const m = p.ref.split(':')[2]
      return new Promise((done) => held.push(() => done({ program: 'omega-tools', query: 'reasoning-module', result: { module: m, mind_id: p.ref.split(':')[1], state: 'unavailable', available: false, unavailable_reason: 'no_reader', revision: null, observed_at: null, qualification: 'invented', explain: 'invented', items: [], provenance: { source_revision: null, evidence_refs: [], read_path: 'none', authority: 'none' } } })))
    },
  }
}
const mind = (id: string) => ({ id, name: 'Invented', swarm_id: 's_invented' }) as unknown as Parameters<typeof ReasoningModules>[0]['agent']
const render = (id: string) => {
  slot = 0
  ReasoningModules({ agent: mind(id) })
}
/** React's unmount: every effect's cleanup */
const unmount = () => effects.forEach((e) => e.cleanup?.())
/** StrictMode's development replay: clean up every effect, then set each up again, in the same commit */
const replay = (id: string) => {
  unmount()
  effects = []
  render(id)
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  effects = []
  refs = []
  states = []
  writes.length = 0
  epoch = 1
})
afterEach(() => vi.useRealTimers())

describe('ReasoningModules and its read batch agree', () => {
  it('a StrictMode replay sends one batch (6 reads), and its answers are written', async () => {
    const c = reader()
    client = c
    render('a_one')
    replay('a_one')
    await settle()
    vi.advanceTimersByTime(5)
    expect(c.sent).toEqual(['attention', 'self', 'energy', 'scratch', 'assume', 'temporal'].map((m) => `mind:a_one:${m}`))
    await c.release()
    expect(writes.length).toBe(6)
  })

  it('an unmount mid-read: the answers that come later write nothing', async () => {
    const c = reader()
    client = c
    render('a_one')
    await settle()
    expect(c.sent.length).toBe(6)
    unmount()
    vi.advanceTimersByTime(5)
    await c.release()
    expect(writes).toEqual([])
  })

  it('another mind: a fresh batch is sent, the earlier one’s late answers write nothing', async () => {
    const c = reader()
    client = c
    render('a_one')
    await settle()
    render('a_two')
    await settle()
    expect([c.sent.filter((r) => r.startsWith('mind:a_one:')).length, c.sent.filter((r) => r.startsWith('mind:a_two:')).length]).toEqual([6, 6])
    await c.release()
    // only a_two's six answers are written; a_one's batch was aborted when the mind changed
    expect(writes.length).toBe(6)
    expect(JSON.stringify(writes)).not.toContain('a_one')
  })

  it('another client: a fresh batch on the new client, nothing written from the old one', async () => {
    const c1 = reader()
    const c2 = reader()
    client = c1
    render('a_one')
    await settle()
    client = c2
    render('a_one')
    await settle()
    expect([c1.sent.length, c2.sent.length]).toEqual([6, 6])
    await c1.release()
    expect(writes).toEqual([])
    await c2.release()
    expect(writes.length).toBe(6)
  })

  it('second layer: an identity-epoch change refuses a live batch’s answers', async () => {
    const c = reader()
    client = c
    render('a_one')
    await settle()
    epoch = 2 // the person changed; this render has not happened yet, so the batch is still live
    await c.release()
    expect(writes).toEqual([])
  })
})
