/**
 * The tour drives the real app, so it takes a snapshot first and puts everything back afterwards:
 * the route, overlays it opened, and the program sessions (trails) it touched, in memory and in storage.
 */

export interface RestorableState<P = unknown> {
  paletteOpen: boolean
  stopAllOpen: boolean
  programSessions: Record<string, P>
}

export interface RestoreEnv<P = unknown> {
  getHash(): string
  /** Replace the route without adding a history entry. */
  replaceHash(hash: string): void
  getState(): RestorableState<P>
  setState(partial: Partial<RestorableState<P>>): void
  storage: {
    keys(): string[]
    get(key: string): string | null
    set(key: string, value: string): void
    remove(key: string): void
  }
}

export interface Snapshot<P = unknown> {
  hash: string
  programSessions: Record<string, P>
  storage: Record<string, string>
}

/** Storage the tour may change while it plays (program trails, a program's remembered swarm). */
export const TOUR_TOUCHED_PREFIX = 'omegadots.program.'

export function takeSnapshot<P>(env: RestoreEnv<P>, returnTo?: string): Snapshot<P> {
  const storage: Record<string, string> = {}
  for (const k of safeKeys(env)) {
    if (!k.startsWith(TOUR_TOUCHED_PREFIX)) continue
    const v = safeGet(env, k)
    if (v !== null) storage[k] = v
  }
  return { hash: returnTo ?? env.getHash(), programSessions: env.getState().programSessions, storage }
}

export function restoreSnapshot<P>(env: RestoreEnv<P>, snap: Snapshot<P>): void {
  env.setState({ paletteOpen: false, stopAllOpen: false, programSessions: snap.programSessions })
  for (const k of safeKeys(env)) {
    if (k.startsWith(TOUR_TOUCHED_PREFIX) && !(k in snap.storage)) safe(() => env.storage.remove(k))
  }
  for (const [k, v] of Object.entries(snap.storage)) if (safeGet(env, k) !== v) safe(() => env.storage.set(k, v))
  const hash = snap.hash || '#/'
  if (env.getHash() !== hash) env.replaceHash(hash)
}

function safe(fn: () => void) {
  try {
    fn()
  } catch {
    /* storage unavailable */
  }
}
function safeKeys<P>(env: RestoreEnv<P>): string[] {
  try {
    return env.storage.keys()
  } catch {
    return []
  }
}
function safeGet<P>(env: RestoreEnv<P>, k: string): string | null {
  try {
    return env.storage.get(k)
  } catch {
    return null
  }
}

/** The real environment: location.hash, the zustand store, localStorage. */
export function browserRestoreEnv<P>(store: { getState(): RestorableState<P>; setState(p: Partial<RestorableState<P>>): void }): RestoreEnv<P> {
  return {
    getHash: () => window.location.hash || '#/',
    replaceHash(hash) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    },
    getState: () => store.getState(),
    setState: (p) => store.setState(p),
    storage: {
      keys: () => {
        const out: string[] = []
        const ls = window.localStorage
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i)
          if (k) out.push(k)
        }
        return out
      },
      get: (k) => window.localStorage.getItem(k),
      set: (k, v) => window.localStorage.setItem(k, v),
      remove: (k) => window.localStorage.removeItem(k),
    },
  }
}
