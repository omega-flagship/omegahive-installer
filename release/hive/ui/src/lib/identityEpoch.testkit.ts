// Purpose: the identity kit for tests: people on synthetic simulated hives, signed in and switched on the real store.
import { Emitter } from '../api/client'
import { SimClient } from '../api/sim/SimClient'
import { useHive } from '../store/store'
import { currentEpoch } from './identityEpoch'

/**
 * Test kit for the identity epoch (vitest; tests only, never imported by the app). A person is a synthetic SimClient
 * that reports its sign-in the way the live client does (authContext / onAuthChange; Platform person-session).
 * `switchPerson` drives the REAL store identity change, so a feature test can show A, switch to B, and assert A's data
 * is gone at once and stays gone after A's late answers. Invented data only; no hive.
 *
 *   const a = testPerson('a'), b = testPerson('b')
 *   await signInAs(a)            // A is current
 *   ...show A's data...
 *   const done = switchPerson(a, b)
 *   expect(...A's data...).toBe(gone)   // synchronously, before any await
 *   await done                   // B has hydrated
 *   lateAnswerForA.resolve(...); expect(...still gone...)
 *
 * Stub `window` ({ location: { search: '' } }) as the store tests do, and call `releasePersons()` in afterEach.
 */

export interface TestPerson {
  readonly name: string
  readonly client: SimClient
  /** this person's credential on their tab (null = signed out) */
  token(): string | null
}

const made: SimClient[] = []
interface Tab {
  sim: SimClient
  token: string | null
  handle: object
  events: Emitter<void>
  principals: Map<string, string>
  nativeMe?: SimClient['me']
}
const tabs = new WeakMap<SimClient, Tab>()

/** A person's simulated hive: the kit's one way to make one, so warmPersons builds exactly what tab uses. */
const hiveFor = (seed: number) => new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })

function tab(seed: number): Tab {
  const sim = hiveFor(seed)
  made.push(sim)
  const t: Tab = { sim, token: null, handle: {}, events: new Emitter<void>(), principals: new Map() }
  Object.assign(sim, {
    needsAuth: () => !t.token,
    authContext: () => t.handle,
    onAuthChange: (l: () => void) => t.events.on(l),
  })
  tabs.set(sim, t)
  return t
}

// Each test's people get the same seeds in the same order, the test's first new tab 901, its next 902 and so on
// (releasePersons starts them again), so a test's hives differ from one another as before, and every test after a
// file's first takes its hives from the simulator's seed cache (api/sim/SimClient SEED_CACHE) instead of running the
// commons' seed program again: 0.3 s per person on a loaded laptop, more than a second on a busy CI runner.
const FIRST_SEED = 900
let seeds = FIRST_SEED

/**
 * Build, once, the hives a test's first `people` new tabs use, so a file's first test takes them from the seed cache
 * too. Call it in beforeAll: the commons' seed program then runs under the hook's own timeout, not a test's.
 */
export function warmPersons(people = 2): void {
  for (let seed = FIRST_SEED + 1; seed <= FIRST_SEED + people; seed++) hiveFor(seed).disconnect()
}
/**
 * A person on their own tab (client), or, with `sameTab`, on another person's tab: switching between two people who
 * share a tab is a re-login on the same client without a logout (a credential-only identity change).
 */
export function testPerson(name: string, opts: { seed?: number; sameTab?: TestPerson } = {}): TestPerson {
  const t = opts.sameTab ? tabs.get(opts.sameTab.client)! : tab(opts.seed ?? ++seeds)
  t.principals.set(`token-${name}`, `user:${name}`)
  return { name, client: t.sim, token: () => `token-${name}` }
}

/** Opt-in for tests that bind invented Ask principals while retaining SimClient's other host routes.
 * Read the current credential at response time: same-client A→B→A reports A, B, A,
 * rather than retaining whichever person installed a feature's Ask fixture last.
 */
export function reportTestPrincipal(p: TestPerson, principal = `user:${p.name}`): void {
  const t = tabs.get(p.client)!
  t.principals.set(p.token()!, principal)
  if (t.nativeMe) return
  const nativeMe = t.nativeMe = t.sim.me.bind(t.sim)
  t.sim.me = async () => {
    const me = await nativeMe()
    return { ...me, principal: t.token ? t.principals.get(t.token) ?? me.principal : me.principal }
  }
}

function presentCredential(p: TestPerson): void {
  const t = tabs.get(p.client)!
  if (t.token === p.token()) return
  t.token = p.token()
  t.handle = {}
  t.events.emit()
}

/** Make `p` the signed-in person on the real store (init of their client, with their credential). */
export async function signInAs(p: TestPerson): Promise<void> {
  if (useHive.getState().client === p.client) return presentCredential(p)
  tabs.get(p.client)!.token = p.token()
  await useHive.getState().init(p.client)
}

/** Whether `p` is the one the store holds now. */
export function isCurrent(p: TestPerson): boolean {
  const t = tabs.get(p.client)!
  return useHive.getState().client === p.client && t.token === p.token()
}

/**
 * Switch the real store from `from` to `to`. The identity change (epoch bump, every onIdentityChange clear) happens
 * synchronously inside this call, before it returns; the returned promise settles once `to` has hydrated.
 * Throws when `from` is not the current person, so a test cannot pass by switching from someone never shown.
 */
export function switchPerson(from: TestPerson, to: TestPerson): Promise<{ before: number; after: number }> {
  if (!isCurrent(from)) throw new Error(`switchPerson: ${from.name} is not the current person`)
  if (from === to || (from.client === to.client && from.token() === to.token())) throw new Error('switchPerson: same person')
  const before = currentEpoch()
  let done: Promise<void>
  if (to.client === from.client) {
    presentCredential(to)
    done = Promise.resolve()
  } else {
    tabs.get(to.client)!.token = to.token()
    done = useHive.getState().init(to.client)
  }
  const after = currentEpoch()
  return done.then(() => ({ before, after }))
}

/** Disconnect every client the kit made. */
export function releasePersons(): void {
  for (const c of made.splice(0)) c.disconnect()
  seeds = FIRST_SEED
}
