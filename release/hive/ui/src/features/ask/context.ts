/**
 * What the Ask knows about where it is: the fast path's world (minds, swarms, apps, looks, the offered experiences),
 * the page context sent with each mind turn (Host §1.1 `context`, with `view`), and who will answer (Jon's ruling: the
 * orchestrator of the addressed mind's swarm, else the page's swarm, else the person's default swarm).
 */
import { plural } from '../../lib/plural'
import { useMemo, useSyncExternalStore } from 'react'
import type { AskContext } from '../../api/ask'
import { EXPERIENCES } from '../../experiences/registry'
import { targetFor } from '../../experiences/targets'
import { FEATURES } from '../registry'
import { shown } from '../../lib/displayName'
import type { Named, World } from '../../lib/intent'
import type { ScopedFeatures } from '../../lib/intent'
import type { Route } from '../../lib/router'
import { SEED_VARIANTS } from '../../shell/uiVariant'
import { routeLabel } from '../../store/ask'
import { useHive } from '../../store/store'
import { currentView, fitView, isPrivateApp, isPrivateHash, type PageView } from './view'
import { listFields } from './fields'
import { appShown } from './words'
import type { Agent, Swarm } from '../../api/types'
import { useArchivedNames } from '../swarm/deleteRequest'
import { useScene } from '../../scene/sceneStore'
import { useViewer } from '../../scene/viewer'
import { visibleSet } from '../../scene/visibleSet'
import { askFlags, readAskFlags } from '../../api/idleMinds'   // Surface: the host's Remind / Sleep flags (Platform r2.4)

/** Features that live on one mind's or one swarm's page (they need a subject first). */
export const SCOPED: ScopedFeatures = Object.fromEntries(
  FEATURES.map((f) => [f.id, targetFor(f)?.kind] as const).filter((x): x is [string, 'mind' | 'swarm'] => x[1] === 'mind' || x[1] === 'swarm'),
)

const readGalaxies = () => useScene.getState().galaxies
const awake = (a: Pick<Agent, 'status'>) => a.status === 'awake' || a.status === 'starting'
const SEP = '\u0001'

/** The fast path's world, stable until a name, status or swarm actually changes. */
export function useAskWorld(): World {
  const sig = useHive((s) => {
    let out = ''
    for (const id in s.agents) {
      const a = s.agents[id]
      // the host's flags (Platform r2.4): absent is no
      out += `m${SEP}${a.id}${SEP}${a.name}${SEP}${awake(a) ? 1 : 0}${SEP}${a.swarm_id ?? ''}${SEP}${askFlags(a, !!(a.swarm_id && s.swarms[a.swarm_id]?.personal_of))}\n`
    }
    for (const id in s.swarms) out += `s${SEP}${id}${SEP}${s.swarms[id].name}\n`
    for (const p of s.programs ?? []) out += `p${SEP}${p.id}${SEP}${p.name ?? p.id}\n`
    let pending = 0
    for (const id in s.approvals) if (s.approvals[id].status === 'pending') pending++
    return `${out}#${pending}`
  })
  // archived swarms, once read for the delete words (features/swarm/deleteRequest)
  const archived = useArchivedNames()
  // the hives on the map (shown hives only), for "show me Ada's hive" (lib/intent/hiveMap)
  const galaxies = useSyncExternalStore(useScene.subscribe, readGalaxies, readGalaxies)
  return useMemo(() => {
    const minds: Named[] = []
    const swarms: Named[] = []
    const apps: Named[] = []
    const swarmName: Record<string, string> = {}
    const lines = sig.split('\n')
    for (const l of lines) {
      const [k, id, name] = l.split(SEP)
      if (k === 's') {
        swarms.push({ id, name: shown(name) })
        swarmName[id] = shown(name)
      }
      if (k === 'p') apps.push({ id, name })
    }
    for (const l of lines) {
      const [k, id, name, aw, sw, fl] = l.split(SEP)
      if (k === 'm') minds.push({ id, name: shown(name), awake: aw === '1', swarm: sw ? swarmName[sw] ?? '' : '', ...readAskFlags(fl) })
    }
    minds.sort((a, b) => Number(b.awake) - Number(a.awake) || a.name.localeCompare(b.name))
    swarms.sort((a, b) => a.name.localeCompare(b.name))
    const pending = Number(sig.slice(sig.lastIndexOf('#') + 1)) || 0
    return { minds, swarms, apps, pending, experiences: EXPERIENCES.map((e) => ({ id: e.id, name: e.name })), looks: SEED_VARIANTS.map((v) => ({ id: v.id, name: v.name })), archivedSwarms: (archived ?? []).map((s) => ({ id: s.id, name: shown(s.name) })), hives: galaxies.map((g) => ({ id: g.id, name: shown(g.label), mine: g.mine, cloud: g.cloud, aliases: g.aliases.map(shown) })) }
  }, [sig, archived, galaxies])
}

/** The swarm a route is about, if any. */
export function routeSwarm(r: Route): string | undefined {
  if (r.name === 'swarm') return r.id
  if (r.name === 'lifecycle') return r.swarm
  if (r.name === 'goals' || r.name === 'assets' || r.name === 'connect' || r.name === 'new' || r.name === 'program') return r.swarm
  if (r.name === 'boards') return r.swarm
  // Tasks (where #/goals and #/boards now open): its swarm filter, else the swarm of the mind it is filtered by
  if (r.name === 'tasks') return r.swarm ?? (r.mind ? useHive.getState().agents[r.mind]?.swarm_id ?? undefined : undefined)
  if (r.name === 'dot') return useHive.getState().agents[r.id]?.swarm_id ?? undefined
  return undefined
}

/** "on Goals", "on the paper". */
export function whereOf(r: Route, experience: string): string {
  if (experience === 'still' && r.name === 'hive') return 'on the paper'
  if (r.name === 'hive') return experience === 'classic' ? 'on the hive' : `in ${experience[0].toUpperCase()}${experience.slice(1)}`
  const sw = routeSwarm(r)
  const swName = sw ? shown(useHive.getState().swarms[sw]?.name) : ''
  if (r.name === 'program') return `in ${appShown(r.id, shown(useHive.getState().programs?.find((p) => p.id === r.id)?.name))}`
  if (r.name === 'dot') return `with ${shown(useHive.getState().agents[r.id]?.name) || 'a mind'}`
  return `on ${routeLabel(r)}${swName ? ` · ${swName}` : ''}`
}

/** A small default view from the route and what the store already shows, when the page did not export one. */
export function defaultView(r: Route, where: string): PageView {
  const s = useHive.getState()
  const v: PageView = { title: where.replace(/^(on|in|with) /, ''), refs: [], acts: [] }
  if (r.name === 'swarm' || r.name === 'goals' || r.name === 'tasks') {
    const sw = routeSwarm(r)
    if (sw && s.swarms[sw]) v.refs!.push({ kind: 'swarm', ref: sw, label: shown(s.swarms[sw].name) })
    // Tasks lists what its filters show: its swarm, and its mind (assignee, holder or creator, as TasksPage filters)
    const inSwarm = r.name === 'tasks' ? r.swarm : sw
    const mind = r.name === 'tasks' ? r.mind : undefined
    const goals = Object.values(s.goals)
      .filter((g) => (!inSwarm || g.swarm_id === inSwarm) && (!mind || g.assignee === mind || g.claimed_by === mind || g.created_by === `agent:${mind}`))
      .filter((g) => g.status !== 'done')
    for (const g of goals.slice(0, 20)) v.refs!.push({ kind: 'goal', ref: g.id, label: g.title.slice(0, 60) })
    v.summary = `${goals.length} open task${goals.length === 1 ? '' : 's'}${inSwarm && s.swarms[inSwarm] ? ` in ${shown(s.swarms[inSwarm].name)}` : ''}${mind && s.agents[mind] ? ` for ${shown(s.agents[mind].name)}` : ''}`
  } else if (r.name === 'dot' && s.agents[r.id]) {
    v.refs!.push({ kind: 'mind', ref: r.id, label: shown(s.agents[r.id].name) })
    v.summary = `${shown(s.agents[r.id].name)} is ${s.agents[r.id].status}`
  } else if (r.name === 'approvals') {
    const pending = Object.values(s.approvals).filter((a) => a.status === 'pending')
    v.summary = `${pending.length} decision${pending.length === 1 ? '' : 's'} waiting`
  } else if (r.name === 'program') {
    v.refs!.push({ kind: 'feature', ref: `app:${r.id}` })
  } else if (r.name === 'hive') {
    // from the shown set only (scene/visibleSet): nothing hidden from this viewer is counted, and the hive in view is a
    // shown hive's id, as context (it never routes the Ask: the host does)
    const shownSet = visibleSet(Object.values(s.swarms), Object.values(s.agents), useViewer.getState().viewer, { map: true })
    const inView = useScene.getState().engine?.galaxyInView() ?? null
    const inHive = (a: Agent) => (a.swarm_id && shownSet.hiveOf[a.swarm_id] ? shownSet.hiveOf[a.swarm_id] : shownSet.wanderHive) === inView
    const minds = inView ? shownSet.agents.filter(inHive) : shownSet.agents
    if (inView) v.refs!.push({ kind: 'item', ref: inView })
    v.summary = `${minds.filter(awake).length} of ${plural(minds.length, 'mind')} awake`
  }
  return v
}

/** The named regions on screen now (`data-presence-region`), in document order, once each. */
export function domRegions(root: Pick<Document, 'querySelectorAll'> | null = typeof document === 'undefined' ? null : document): string[] {
  if (!root) return []
  const out = new Set<string>()
  for (const el of Array.from(root.querySelectorAll('[data-presence-region]'))) {
    const name = (el as Element).getAttribute?.('data-presence-region')
    if (name && /^[a-z][a-z0-9-]{0,40}$/.test(name) && !(el as Element).closest?.('[inert],[aria-hidden="true"]')) out.add(name)
  }
  return [...out]
}

/**
 * A private app's page (Atlas, Truth): nothing of it reaches the conductor. The app id is decoded and lowercased
 * before comparing (view.ts isPrivateApp; an unreadable one is private), and the page's raw hash is read as well, so
 * an encoded route (`%61tlas`, `%2561tlas`, `%41TLAS`) cannot get past it.
 */
export const isPrivateAppRoute = (r: Route): boolean => (r.name === 'program' && isPrivateApp(r.id)) || (r.name === 'dot' && !!r.program && isPrivateApp(r.program))
/** The page now (`r` is the current route): its route, or the raw hash it came from. */
export const isPrivateRoute = (r: Route): boolean => isPrivateAppRoute(r) || (typeof window !== 'undefined' && !!window.location && isPrivateHash(window.location.hash || ''))

/** The route as the context names it: a route name, or programs/<app>. */
export const contextRoute = (r: Route): string => (r.name === 'program' ? `programs/${r.id}`.slice(0, 120) : r.name)

/** The page's view as sent (≤ 2 KB): its export or the default, with the fillable fields and regions on screen now. */
export function pageView(r: Route, where: string): ReturnType<typeof fitView> {
  const exported = currentView()?.view
  const v = exported ?? defaultView(r, where)
  return fitView({ ...v, fields: [...(v.fields ?? []), ...listFields()], regions: [...(v.regions ?? []), ...domRegions()] }, { privateApp: isPrivateRoute(r) })
}

/**
 * The context sent with a mind turn: route, experience, the app and swarm in view, and the view export. On a private
 * app's page (Atlas, Truth) exactly `{ private: true }`: no route, ids, kinds or view (Platform r2 Q6).
 */
export function askContext(r: Route, experience: string, where: string, mind?: string): AskContext {
  if (isPrivateRoute(r)) return { private: true }
  const program = r.name === 'program' ? r.id : undefined
  const sw = routeSwarm(r)
  const view = pageView(r, where)
  return { route: contextRoute(r), experience, ...(program ? { program } : {}), ...(sw ? { swarm_id: sw } : {}), ...(mind ? { mind } : {}), view }
}

/**
 * j0-fixes r1: the parts of the context that decide who answers (askContext without the view, which reads the page):
 * what the chip and the paid row plan from, so they plan from what the send will carry.
 */
export function routingContext(r: Route, experience: string, mind?: string): AskContext {
  if (isPrivateRoute(r)) return { private: true }
  const program = r.name === 'program' ? r.id : undefined
  const sw = routeSwarm(r)
  return { route: contextRoute(r), experience, ...(program ? { program } : {}), ...(sw ? { swarm_id: sw } : {}), ...(mind ? { mind } : {}) }
}

/** Who will answer, before the host says (it decides; this is only the label): the orchestrator of the swarm. */
export function expectedAnswerer(swarms: Record<string, Swarm>, agents: Record<string, Agent>, opts: { to?: string; swarm?: string; defaultSwarm?: string | null }): { id: string; name: string; swarm: string } | null {
  const swarmId = opts.to ? agents[opts.to]?.swarm_id : opts.swarm ?? opts.defaultSwarm ?? undefined
  const sw = swarmId ? swarms[swarmId] : undefined
  const c = sw?.coordinator_id ? agents[sw.coordinator_id] : undefined
  return sw && c ? { id: c.id, name: shown(c.name), swarm: shown(sw.name) } : null
}
