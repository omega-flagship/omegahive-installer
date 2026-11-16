import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { currentEpoch, onIdentityChange } from './identityEpoch'
import { isPanelRoute, parse, type Route } from './router'
import { useResting } from './resting'
import { usePhase } from '../shell/phase'

/** Owners choose a scope explicitly. A dialog also requires its opening surface's authority. */
export type VisibleScope = 'hive-pro' | 'page' | 'dialog'
export interface VisibleOwner {
  subscribe(notify: () => void): () => void
  snapshot(): unknown
  matches(snapshot: unknown): boolean
}
/** A stable adapter, declared beside its owning store; no parallel state or registry. */
export function visibleOwner<State, Snapshot>(store: { getState(): State; subscribe(notify: () => void): () => void }, select: (state: State) => Snapshot, matches: (snapshot: Snapshot) => boolean): VisibleOwner {
  return { subscribe: store.subscribe, snapshot: () => select(store.getState()), matches: (snapshot) => matches(snapshot as Snapshot) }
}
const subscribeRoute = (notify: () => void) => {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}
const routeSnapshot = () => window.location.hash
const noOwner = () => null
const noSubscription = () => () => {}
/**
 * The hive's own view is on screen at home and beside a side panel, which leaves it in reach (on a desktop the panel is
 * modeless; a phone's full sheet lays a backdrop over it that takes the taps itself); a full page covers it. A tester with
 * a mind's panel open found every click on the Canvas's minds dropped.
 */
const homeShown = (name: Route['name']) => name === 'hive' || isPanelRoute(name)
const visibleNow = (scope: VisibleScope, parent?: () => boolean) => {
  if (document.hidden || useResting.getState().resting) return false
  const name = parse(window.location.hash).name
  const phase = usePhase.getState()
  if (scope === 'hive-pro') return homeShown(name) && (!phase.phased || phase.phase === 'pro')
  if (scope === 'page') return name !== 'hive'
  return parent?.() ?? false
}

/** One displayed owner, identity, route and visible attachment. Saved callbacks never renew themselves. */
export function useVisibleAuthority(scope: 'dialog', active: boolean, attachment: unknown, parent: () => boolean): () => boolean
export function useVisibleAuthority(scope: Exclude<VisibleScope, 'dialog'>, active: boolean, attachment: unknown, source?: VisibleOwner): () => boolean
export function useVisibleAuthority(scope: VisibleScope, active: boolean, attachment: unknown, ownerOrParent?: VisibleOwner | (() => boolean)): () => boolean {
  const source = typeof ownerOrParent === 'object' ? ownerOrParent : undefined
  const parent = typeof ownerOrParent === 'function' ? ownerOrParent : undefined
  const epoch = useSyncExternalStore(onIdentityChange, currentEpoch, currentEpoch)
  const route = useSyncExternalStore(subscribeRoute, routeSnapshot, () => '')
  const ownerSnapshot = useSyncExternalStore(source?.subscribe ?? noSubscription, source?.snapshot ?? noOwner, noOwner)
  const resting = useResting(s => s.resting)
  const pro = usePhase(s => !s.phased || s.phase === 'pro')
  const home = parse(route).name === 'hive'
  const visible = active && !resting && (scope === 'hive-pro' ? homeShown(parse(route).name) && pro : scope === 'page' ? !home : !!parent && parent()) && (!source || source.matches(ownerSnapshot))
  const owner = useRef<object | null>(null)
  const blocked = useRef(false)
  const [revision, revise] = useState(0)
  const [published, publish] = useState<object | null>(null)
  useLayoutEffect(() => {
    blocked.current = document.hidden
    const invalidate = (hidden: boolean) => { blocked.current = hidden; owner.current = null; revise(n => n + 1) }
    const visibility = () => invalidate(document.hidden)
    const hide = () => invalidate(true)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', visibility)
    window.addEventListener('hashchange', visibility)
    const offRest = useResting.subscribe((s, prev) => { if (s.resting && !prev.resting) invalidate(document.hidden) })
    const offPhase = usePhase.subscribe((s, prev) => {
      if (homeShown(parse(window.location.hash).name) && s.phased && s.phase !== 'pro' && (!prev.phased || prev.phase === 'pro')) invalidate(document.hidden)
    })
    let last = source?.snapshot()
    const offOwner = source?.subscribe(() => {
      const next = source.snapshot()
      if (!Object.is(last, next)) { last = next; invalidate(document.hidden) }
    })
    return () => {
      owner.current = null
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', visibility)
      window.removeEventListener('hashchange', visibility)
      offRest(); offPhase(); offOwner?.()
    }
  }, [source])
  useLayoutEffect(() => {
    if (!visible || blocked.current || !visibleNow(scope, parent)) return
    const grant = {}
    owner.current = grant
    publish(grant)
    return () => { if (owner.current === grant) owner.current = null }
  }, [visible, scope, attachment, ownerSnapshot, epoch, route, revision])
  return useCallback(() => visible && published !== null && owner.current === published && !blocked.current && epoch === currentEpoch() && route === routeSnapshot() && (!source || Object.is(ownerSnapshot, source.snapshot())) && visibleNow(scope, parent), [visible, published, epoch, route, scope, source, ownerSnapshot, parent])
}

/** A React-owned attachment value, published synchronously at its setter before the render projection commits. */
export function useVisibleState<T>(initial: T) {
  const [rendered, render] = useState(initial)
  const [owner] = useState(() => {
    let value = initial
    const listeners = new Set<() => void>()
    const source: VisibleOwner = { snapshot: () => value, matches: (snapshot) => snapshot !== null, subscribe: (notify) => { listeners.add(notify); return () => { listeners.delete(notify) } } }
    const set = (next: T | ((previous: T) => T)) => {
      const nextValue = typeof next === 'function' ? (next as (previous: T) => T)(value) : next
      if (Object.is(value, nextValue)) return
      value = nextValue
      for (const notify of [...listeners]) notify()
      render(() => value)
    }
    return { source, set }
  })
  return [rendered, owner.set, owner.source] as const
}
