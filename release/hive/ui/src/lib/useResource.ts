import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ApiError, type HiveClient } from '../api/client'
import { useHive } from '../store/store'
import { readContext } from './readContext'
import { GRANT_SCOPE_WORDS, isGrantScope } from './grantScope'

/**
 * One loading model for every page: a resource is `unsupported` (this hive or the demo does not offer it),
 * `loading` (first fetch in flight), `error` (the last fetch failed and there is nothing to show), `empty`
 * or `ready`. A failed refresh keeps the last good data and reports the error alongside it.
 */
export type ResourceStatus = 'unsupported' | 'loading' | 'error' | 'empty' | 'ready'

export interface ResourceState<T> {
  status: ResourceStatus
  data: T | undefined
  /** The last failure, if the latest fetch failed (also set while showing stale data). */
  error: unknown
  /** A fetch is in flight while data is already shown. */
  refreshing: boolean
}

/** Thrown when the client has no such method: the page shows "not available here", never a false success. */
export class UnsupportedError extends Error {
  constructor(what = 'This') {
    super(`${what} is not available here.`)
    this.name = 'UnsupportedError'
  }
}

export const isUnsupported = (e: unknown): e is UnsupportedError => e instanceof UnsupportedError
export const isForbidden = (e: unknown): boolean => e instanceof ApiError && e.status === 403
/** A 404: the thing is gone, or (with R13 visibility) hidden from this viewer; the hive answers the same for both. */
export const isNotFound = (e: unknown): boolean => e instanceof ApiError && e.status === 404

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 0) return 'Could not reach the hive. Check the connection and try again.'
  if (isGrantScope(e)) return GRANT_SCOPE_WORDS
  if (e instanceof Error) return e.message
  return String(e)
}

type Method<K extends keyof HiveClient> = NonNullable<HiveClient[K]>

/**
 * The client's optional method `name`, bound, or throws UnsupportedError. Use it instead of `client!.x!()`
 * (a TypeError) or `client?.x?.()` (resolves undefined, so a caller's success path runs on nothing).
 */
export function need<K extends keyof HiveClient>(client: HiveClient | null | undefined, name: K, what?: string): Method<K> {
  const fn = client?.[name]
  if (typeof fn !== 'function') throw new UnsupportedError(what)
  return (fn as (...a: unknown[]) => unknown).bind(client) as Method<K>
}

/** True when the client offers the method (to hide or disable controls up front). */
export const has = (client: HiveClient | null | undefined, name: keyof HiveClient): boolean => typeof client?.[name] === 'function'

/** Toast fields for a failed action: "not available here" for a missing method, otherwise the error. */
export function actionFailure(e: unknown, title: string): { tone: 'info' | 'error'; title: string; body: string } {
  if (isUnsupported(e)) return { tone: 'info', title: 'Not available here', body: e.message }
  return { tone: 'error', title, body: errorMessage(e) }
}

export interface Visibility {
  hidden(): boolean
  /** Calls back when visibility changes; returns an unsubscribe. */
  onChange(fn: () => void): () => void
}

const documentVisibility: Visibility = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onChange(fn) {
    if (typeof document === 'undefined') return () => undefined
    document.addEventListener('visibilitychange', fn)
    return () => document.removeEventListener('visibilitychange', fn)
  },
}

export interface ResourceOptions<T> {
  /** Refetch every `poll` ms while the tab is visible; on becoming visible again it refetches at once. */
  poll?: number
  /** Default: an empty array is empty. */
  isEmpty?: (data: T) => boolean
  visibility?: Visibility
}

const defaultEmpty = (d: unknown) => Array.isArray(d) && d.length === 0

/** What a resource reads as while the answer for the current identity is not in yet. */
export const PENDING: ResourceState<never> = Object.freeze({ status: 'loading', data: undefined, error: undefined, refreshing: false })

/**
 * The framework-free state machine behind useResource (tested directly).
 *
 * Surface K1/L1: every answer belongs to the identity (`context`, see readContext.ts) it was read under. `rebind` to
 * another identity drops the old answer at once (it is never shown as a refresh of the new one) and ignores every
 * answer still in flight for the old identity; `mutateIn` writes only into the identity it names. A plain `load` for
 * the same identity keeps the last answer on screen while it reads again.
 */
export class Resource<T> {
  private state: ResourceState<T> = PENDING
  private listeners = new Set<() => void>()
  private seq = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private offVisible: (() => void) | null = null
  private fetcher: () => Promise<T>
  private readonly opts: ResourceOptions<T>
  private ctx: string

  constructor(fetcher: () => Promise<T>, opts: ResourceOptions<T> = {}, context = '') {
    this.fetcher = fetcher
    this.opts = opts
    this.ctx = context
  }

  /** The identity the current state belongs to. */
  get context(): string {
    return this.ctx
  }
  isBoundTo = (context: string): boolean => this.ctx === context

  /**
   * Switch to another identity: the old answer is dropped (status loading, no data, no error), and any read still in
   * flight for the old identity is ignored when it lands. Returns false (and changes nothing) for the same identity.
   */
  rebind(context: string): boolean {
    if (context === this.ctx) return false
    this.seq++
    this.ctx = context
    this.set(PENDING)
    return true
  }

  getState = (): ResourceState<T> => this.state
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  setFetcher(fetcher: () => Promise<T>) {
    this.fetcher = fetcher
  }

  private set(next: ResourceState<T>) {
    this.state = next
    for (const fn of [...this.listeners]) fn()
  }

  /** Fetch now. Responses to superseded fetches are dropped. */
  load = async (): Promise<void> => {
    const my = ++this.seq
    const ctx = this.ctx
    const had = this.state.data !== undefined
    if (had) {
      if (!this.state.refreshing) this.set({ ...this.state, refreshing: true })
    } else if (this.state.status !== 'loading') {
      this.set({ status: 'loading', data: undefined, error: undefined, refreshing: false })
    }
    try {
      const data = await Promise.resolve().then(() => this.fetcher())
      if (my !== this.seq || ctx !== this.ctx) return
      const empty = (this.opts.isEmpty ?? defaultEmpty)(data)
      this.set({ status: empty ? 'empty' : 'ready', data, error: undefined, refreshing: false })
    } catch (e) {
      if (my !== this.seq || ctx !== this.ctx) return
      if (isUnsupported(e)) this.set({ status: 'unsupported', data: undefined, error: e, refreshing: false })
      else if (had) this.set({ ...this.state, error: e, refreshing: false })
      else this.set({ status: 'error', data: undefined, error: e, refreshing: false })
    }
  }

  /** Replace the data locally (after a mutation the server confirmed). */
  mutate = (fn: (data: T | undefined) => T) => {
    this.mutateIn(this.ctx, fn)
  }

  /** Replace the data locally, only if the resource still belongs to `context` (an action's answer for an old identity is dropped). */
  mutateIn = (context: string, fn: (data: T | undefined) => T) => {
    if (context !== this.ctx) return
    const data = fn(this.state.data)
    const empty = (this.opts.isEmpty ?? defaultEmpty)(data)
    this.set({ status: empty ? 'empty' : 'ready', data, error: undefined, refreshing: this.state.refreshing })
  }

  /** Begin: fetch, then poll while visible. */
  start() {
    this.stop()
    void this.load()
    const vis = this.opts.visibility ?? documentVisibility
    if (this.opts.poll && this.opts.poll > 0) {
      this.timer = setInterval(() => {
        if (!vis.hidden() && this.state.status !== 'unsupported') void this.load()
      }, this.opts.poll)
      this.offVisible = vis.onChange(() => {
        if (!vis.hidden() && this.state.status !== 'unsupported') void this.load()
      })
    }
  }

  /** Stop polling and ignore any fetch still in flight. */
  stop() {
    this.seq++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.offVisible?.()
    this.offVisible = null
    if (this.state.refreshing) this.state = { ...this.state, refreshing: false }
  }
}

const noAuthChanges = () => () => undefined
const noAuthContext = () => null

/**
 * Re-render on every sign-in change the client reports (Platform person-session: `onAuthChange`), so readContext,
 * which names the client's current sign-in, is recomputed and the previous sign-in's answer drops. A client without
 * it (the sim) never re-renders here.
 */
export function useAuthContext(client: HiveClient | null | undefined): object | null {
  // stable per client (the power gate hands out a freshly bound method on every property read)
  const subscribe = useMemo(() => (client?.onAuthChange ? (l: () => void) => client.onAuthChange!(l) : noAuthChanges), [client])
  const read = useMemo(() => (client?.authContext ? () => client.authContext!() : noAuthContext), [client])
  return useSyncExternalStore(subscribe, read, read)
}

export type ResourceHandle<T> = ResourceState<T> & { reload: () => void; mutate: (fn: (data: T | undefined) => T) => void }

export interface ReadOptions<T> extends ResourceOptions<T> {
  /**
   * Who and what this read is for, besides the client (which is always part of it): the principal, admin or member,
   * the entity's id, a saved session. When it changes, the old answer is dropped and hidden at once (status loading)
   * until the new identity's answer arrives, and a late answer for the old identity never lands.
   */
  context?: unknown
  /** Read again for the same identity (an update time, a retry counter): the last answer stays on screen meanwhile. */
  key?: unknown
}

/**
 * Load `fetcher` and track its state. Inside the fetcher, call optional client methods through `need(client, 'x')`,
 * so a client without them yields `unsupported` instead of a skeleton that never resolves.
 *
 * The answer is bound to the store's current client instance plus `context` (Surface K1/L1): a different client, or a
 * different context, never sees the previous one's answer, not even for the render before the new read starts. `key`
 * only re-reads within the same identity.
 */
export function useResource<T>(fetcher: () => Promise<T>, opts: ReadOptions<T> = {}): ResourceHandle<T> {
  const { key, context, ...rest } = opts
  const client = useHive((s) => s.client)
  useAuthContext(client)
  const ctx = readContext(client, context)
  const [res] = useState(() => new Resource<T>(fetcher, rest, ctx))
  useEffect(() => {
    res.setFetcher(fetcher)
  })
  useEffect(() => {
    res.rebind(ctx)
    res.start()
    return () => res.stop()
  }, [res, key, ctx])
  const raw = useSyncExternalStore(res.subscribe, res.getState, res.getState)
  // between a change of identity and the effect that rebinds, the old answer is already not this identity's
  const state: ResourceState<T> = res.isBoundTo(ctx) ? raw : PENDING
  return { ...state, reload: () => void res.load(), mutate: (fn) => res.mutateIn(ctx, fn) }
}
