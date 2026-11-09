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

function tab(seed: number): Tab {
  const sim = new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
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

let seeds = 900
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
}
