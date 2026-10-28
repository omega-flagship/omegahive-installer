import { vi } from 'vitest'

/**
 * A browser's session history for one tab, for the close-home tests (tests only; never imported by the app): entries,
 * index, push (location.hash), replaceState, history.go/back/forward, hashchange, sessionStorage and a reload that
 * keeps history and storage but drops the page's listeners. Stubs the globals `window`, `history`, `HashChangeEvent`.
 */
type Entry = { hash: string; state: unknown }
const TRAIL_KEY = 'omegadots.nav.trail'

/** A browser's session history for one tab: pushing a hash, replacing an entry, history.go, hashchange, reload. */
export function fakeBrowser(first: string) {
  const entries: Entry[] = [{ hash: first, state: null }]
  let idx = 0
  const listeners = new Set<() => void>()
  const fire = () => listeners.forEach((l) => l())
  const store = new Map<string, string>()
  const location = {
    pathname: '/',
    search: '',
    get hash() { return entries[idx].hash },
    set hash(h: string) {
      const next = h.startsWith('#') ? h : `#${h}`
      if (next === entries[idx].hash) return
      entries.splice(idx + 1)
      entries.push({ hash: next, state: null })
      idx++
      fire()
    },
  }
  const history = {
    get state() { return entries[idx].state },
    get length() { return entries.length },
    replaceState(state: unknown, _t: string, url?: string) {
      entries[idx] = { hash: url ? url.slice(url.indexOf('#')) || entries[idx].hash : entries[idx].hash, state }
    },
    go(d: number) {
      const to = Math.max(0, Math.min(entries.length - 1, idx + d))
      if (to === idx) return
      idx = to
      fire()
    },
    back() { this.go(-1) },
    forward() { this.go(1) },
  }
  const install = () => {
    vi.stubGlobal('history', history)
    vi.stubGlobal('window', {
      location,
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      addEventListener: (t: string, l: () => void) => t === 'hashchange' && listeners.add(l),
      removeEventListener: (t: string, l: () => void) => t === 'hashchange' && listeners.delete(l),
      dispatchEvent: () => (fire(), true),
    })
    vi.stubGlobal('HashChangeEvent', class { constructor(public type: string) {} })
  }
  install()
  return {
    location,
    history,
    hashes: () => entries.map((e) => e.hash),
    trail: () => JSON.parse(store.get(TRAIL_KEY) ?? 'null') as string[] | null,
    /** A reload: the page's scripts and listeners go; history entries (with their state) and sessionStorage stay. */
    reload: () => listeners.clear(),
  }
}
