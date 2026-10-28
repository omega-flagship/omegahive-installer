import { useEffect, useRef, useSyncExternalStore } from 'react'

export type CreationReference = { artifact_id: string; revision: number; digest: string }
export function creationReference(value: unknown): CreationReference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const r = value as Record<string, unknown>
  if (Object.keys(r).sort().join(',') !== 'artifact_id,digest,revision' || typeof r.artifact_id !== 'string' || !r.artifact_id || typeof r.revision !== 'number' || !Number.isInteger(r.revision) || r.revision < 1 || typeof r.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(r.digest)) return undefined
  return { artifact_id: r.artifact_id, revision: r.revision, digest: r.digest }
}
export const sameCreation = (a?: CreationReference, b?: CreationReference) =>
  (!a && !b) || (!!a && !!b && a.artifact_id === b.artifact_id && a.revision === b.revision && a.digest === b.digest)
/** The "Open in Design" route for one exact artifact revision (validated; undefined when the reference is malformed). */
export function openInDesign(ref: unknown, swarm: string, program = 'omegadesign'): Route | undefined {
  const source = creationReference(ref)
  return source ? { name: 'program', id: program, swarm, source } : undefined
}
function sourceQuery(raw: string | null): CreationReference | undefined {
  try { return raw ? creationReference(JSON.parse(raw)) : undefined } catch { return undefined }
}

/** A swarm page opened at one place: its commons, members, vocabulary, connections (services), its settings, or its requests. */
export type SwarmTab = 'commons' | 'members' | 'vocab' | 'connections' | 'settings' | 'requests'
const SWARM_TABS: SwarmTab[] = ['commons', 'members', 'vocab', 'connections', 'settings', 'requests']
export type DotTab = 'chat' | 'mind' | 'memory' | 'schedule' | 'model' | 'tools'
export type ApprovalsTab = 'pending' | 'history' | 'rules'
const DOT_TABS: DotTab[] = ['chat', 'mind', 'memory', 'schedule', 'model', 'tools']
const APPROVAL_TABS: ApprovalsTab[] = ['pending', 'history', 'rules']

/** How the Tasks page shows its tasks: columns by status, or one list. */
export type TaskView = 'board' | 'list'

export type Route =
  /**
   * Tasks (the concrete work: today's goals, unchanged underneath), filtered by team, mind or motivation (`none` =
   * Unsorted); `task` opens that task's card. Replaces both Goals and Boards (Motivations above Tasks, 2026-10-05).
   */
  | { name: 'tasks'; swarm?: string; mind?: string; motivation?: string; view?: TaskView; task?: string }
  /** Motivations (the why above tasks); `id` opens one. */
  | { name: 'motivations'; id?: string }
  /** Legacy: Boards is now a view of Tasks. Kept so every older link and caller lands on Tasks (href and parse map it). */
  | { name: 'boards'; mind?: string; swarm?: string }
  /** `firstLight`: #/first-light[?beat=…] (the host's setup list links there): the hive, with First Light asked for */
  | { name: 'hive'; firstLight?: string }
  | { name: 'flow' }
  | { name: 'messages'; room?: string; message?: string }
  /** #/conversations: the minds this person chatted with lately, each opening its Chat tab (mind-chat r1) */
  | { name: 'conversations' }
  | { name: 'settings' }
  | { name: 'dot'; id: string; tab?: DotTab; program?: string }
  | { name: 'swarms' }
  | { name: 'swarm'; id: string; statement?: string; tab?: SwarmTab }
  | { name: 'lifecycle'; swarm: string }
  | { name: 'new'; swarm?: string }
  | { name: 'usage' }
  | { name: 'approvals'; tab?: ApprovalsTab; focus?: string }
  /** Legacy: Goals is now Tasks. `goal` opens that task's card. Kept so every older link and caller lands on Tasks. */
  | { name: 'goals'; swarm?: string; goal?: string }
  | { name: 'lab'; suite?: string; run?: string; tab?: LabTab; dimension?: string }
  | { name: 'programs' }
  /** `view: 'graph'` opens the app's graph view (the guided tour's apps chapter) rather than its own form */
  /** `view: 'studio'` (j3r43-o3 r1.13) opens the app's OWN native interface (not Surface's form over it), e.g. a live
   *  Studio session's canvas in the person's own Studio space */
  | { name: 'program'; id: string; swarm?: string; source?: CreationReference; view?: 'graph' | 'studio' }
  | { name: 'models'; provider?: string }
  /** #/me, and #/me/mind: You › your personal mind (Surface personal mind r1) */
  | { name: 'me'; view?: 'mind' }
  | { name: 'people' }
  /** #/health/idle opens Health at its Idle minds section */
  | { name: 'health'; section?: 'idle' }
  | { name: 'updates' }
  | { name: 'explore' }
  /** map: Workbench Map (#/code/map, #/code/map/<repo>, #/code/map/<repo>@<sha>); '' is the list of maps */
  | { name: 'code'; target?: string; task?: string; workspace?: string; repository?: string; map?: string }
  | { name: 'launch' }
  | { name: 'roles'; id?: string }
  | { name: 'connect'; swarm?: string }
  | { name: 'artifacts' }
  | { name: 'assets'; swarm?: string }
  | { name: 'setup' }

export type LabTab = 'run' | 'history' | 'compare'

/**
 * Words a Code target id can never be, because #/code/<word> means something else: `map` is Workbench Map
 * (#/code/map…). The hive's target ids are "platform" or "<kind>:<id>" (hive/core/code.py _targets), so none is taken.
 */
export const RESERVED_CODE_TARGETS: readonly string[] = ['map']

/** `<repo>@<sha>` with each half encoded and the `@` kept readable (the repo may hold a `/`). */
function mapSegment(map: string): string {
  const at = map.lastIndexOf('@')
  return at > 0 ? `${encodeURIComponent(map.slice(0, at))}@${encodeURIComponent(map.slice(at + 1))}` : encodeURIComponent(map)
}

export function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/'
  const [path, query = ''] = raw.split('?')
  const q = new URLSearchParams(query)
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  switch (parts[0]) {
    case 'tasks':
      return tasksRoute({ swarm: q.get('swarm'), mind: q.get('mind'), motivation: q.get('motivation'), view: q.get('view'), task: q.get('task') })
    case 'motivations':
      return parts[1] ? { name: 'motivations', id: parts[1] } : { name: 'motivations' }
    // the old pages redirect: #/boards[?mind|swarm] and #/goals[/swarm][?goal] open Tasks with the same filter
    case 'boards':
      return tasksRoute({ mind: q.get('mind'), swarm: q.get('swarm') })
    case 'flow': return { name: 'flow' }
    case 'messages': return parts[1] ? { name: 'messages', room: parts[1], ...(q.get('m') ? { message: q.get('m')! } : {}) } : { name: 'messages' }
    case 'settings': return { name: 'settings' }
    case 'conversations': return { name: 'conversations' }
    case 'dot':
      if (parts[1] && parts[2] === 'program' && parts[3]) return { name: 'dot', id: parts[1], program: parts[3] }
      return parts[1] ? { name: 'dot', id: parts[1], tab: DOT_TABS.find((t) => t === parts[2]) } : { name: 'hive' }
    case 'programs':
      return { name: 'programs' }
    case 'models':
      return { name: 'models', provider: parts[1] }
    case 'me':
      return parts[1] === 'mind' ? { name: 'me', view: 'mind' } : { name: 'me' }
    case 'people':
      return { name: 'people' }
    case 'health':
      return parts[1] === 'idle' ? { name: 'health', section: 'idle' } : { name: 'health' }
    case 'updates':
      return { name: 'updates' }
    case 'explore':
      return { name: 'explore' }
    case 'code':
      if (parts[1] === 'map') return { name: 'code', map: parts.slice(2).join('/') }
      return { name: 'code', target: parts[1], task: q.get('task') ?? undefined, workspace: q.get('workspace') ?? undefined, repository: q.get('repository') ?? undefined }
    case 'roles':
      return { name: 'roles', id: parts[1] }
    case 'connect':
      return { name: 'connect', swarm: q.get('swarm') ?? undefined }
    case 'artifacts':
      return { name: 'artifacts' }
    case 'setup':
      return { name: 'setup' }
    case 'assets':
      return { name: 'assets', swarm: q.get('swarm') ?? undefined }
    case 'program':
      return parts[1] ? { name: 'program', id: parts[1], swarm: parts[2], ...(sourceQuery(q.get('source')) ? { source: sourceQuery(q.get('source')) } : {}), ...(q.get('view') === 'graph' ? { view: 'graph' as const } : q.get('view') === 'studio' ? { view: 'studio' as const } : {}) } : { name: 'programs' }
    case 'swarms':
      if (parts[1] === 'new') return { name: 'launch' }
      if (parts[1] && parts[2] === 'lifecycle') return { name: 'lifecycle', swarm: parts[1] }
      return parts[1] ? { name: 'swarm', id: parts[1], statement: q.get('b') ?? undefined, tab: SWARM_TABS.find((t) => t === q.get('tab')) } : { name: 'swarms' }
    case 'new':
      return { name: 'new', swarm: q.get('swarm') ?? undefined }
    case 'usage':
      return { name: 'usage' }
    case 'approvals':
      return { name: 'approvals', tab: APPROVAL_TABS.find((t) => t === parts[1]), focus: q.get('id') ?? undefined }
    case 'goals':
      return tasksRoute({ swarm: parts[1], task: parts[1] ? q.get('goal') : null })
    case 'lab':
      if (parts[1] === 'run' && parts[2]) return { name: 'lab', run: parts[2] }
      if (parts[1] === 'dim' && parts[2]) return { name: 'lab', dimension: parts[2] }
      return parts[1] ? { name: 'lab', suite: parts[1], tab: parts[2] === 'history' || parts[2] === 'compare' ? parts[2] : undefined } : { name: 'lab' }
    case 'first-light':
      return { name: 'hive', firstLight: /^[a-z]{1,12}$/.test(q.get('beat') ?? '') ? q.get('beat')! : '' }
    default:
      return { name: 'hive' }
  }
}

/** A Tasks route from query values, dropping empty ones (so equal filters give equal routes). */
function tasksRoute(v: { swarm?: string | null; mind?: string | null; motivation?: string | null; view?: string | null; task?: string | null }): Route {
  const r: Extract<Route, { name: 'tasks' }> = { name: 'tasks' }
  if (v.swarm) r.swarm = v.swarm
  if (v.mind) r.mind = v.mind
  if (v.motivation) r.motivation = v.motivation
  if (v.view === 'list' || v.view === 'board') r.view = v.view
  if (v.task) r.task = v.task
  return r
}

export function href(r: Route): string {
  switch (r.name) {
    case 'tasks': {
      const q = [
        r.swarm ? `swarm=${encodeURIComponent(r.swarm)}` : '',
        r.mind ? `mind=${encodeURIComponent(r.mind)}` : '',
        r.motivation ? `motivation=${encodeURIComponent(r.motivation)}` : '',
        r.view && r.view !== 'board' ? `view=${r.view}` : '',
        r.task ? `task=${encodeURIComponent(r.task)}` : '',
      ].filter(Boolean).join('&')
      return `#/tasks${q ? `?${q}` : ''}`
    }
    case 'motivations':
      return `#/motivations${r.id ? `/${encodeURIComponent(r.id)}` : ''}`
    case 'boards':
      return href({ name: 'tasks', ...(r.mind ? { mind: r.mind } : r.swarm ? { swarm: r.swarm } : {}) })
    case 'flow': return '#/flow'
    case 'messages': return '#/messages' + (r.room ? '/' + encodeURIComponent(r.room) + (r.message ? '?m=' + encodeURIComponent(r.message) : '') : '')
    case 'settings': return '#/settings'
    case 'conversations': return '#/conversations'
    case 'hive':
      return '#/'
    case 'dot':
      if (r.program) return `#/dot/${encodeURIComponent(r.id)}/program/${encodeURIComponent(r.program)}`
      return `#/dot/${encodeURIComponent(r.id)}${r.tab && r.tab !== 'chat' ? `/${r.tab}` : ''}`
    case 'programs':
      return '#/programs'
    case 'me':
      return r.view === 'mind' ? '#/me/mind' : '#/me'
    case 'people':
      return '#/people'
    case 'health':
      return r.section === 'idle' ? '#/health/idle' : '#/health'
    case 'updates':
      return '#/updates'
    case 'explore':
      return '#/explore'
    case 'launch':
      return '#/swarms/new'
    case 'connect':
      return `#/connect${r.swarm ? `?swarm=${encodeURIComponent(r.swarm)}` : ''}`
    case 'artifacts':
      return '#/artifacts'
    case 'setup':
      return '#/setup'
    case 'assets':
      return `#/assets${r.swarm ? `?swarm=${encodeURIComponent(r.swarm)}` : ''}`
    case 'roles':
      return `#/roles${r.id ? `/${encodeURIComponent(r.id)}` : ''}`
    case 'code':
      if (r.map !== undefined) return `#/code/map${r.map ? `/${mapSegment(r.map)}` : ''}`
      return `#/code${r.target ? `/${encodeURIComponent(r.target)}` : ''}${r.workspace ? `?task=${encodeURIComponent(r.task ?? '')}&workspace=${encodeURIComponent(r.workspace)}&repository=${encodeURIComponent(r.repository ?? '')}` : r.task ? `?task=${encodeURIComponent(r.task)}${r.repository ? `&repository=${encodeURIComponent(r.repository)}` : ''}` : ''}`
    case 'models':
      return `#/models${r.provider ? `/${encodeURIComponent(r.provider)}` : ''}`
    case 'program':
      {
        const q = [r.source ? `source=${encodeURIComponent(JSON.stringify(r.source))}` : '', r.view === 'graph' ? 'view=graph' : r.view === 'studio' ? 'view=studio' : ''].filter(Boolean).join('&')
        return `#/program/${encodeURIComponent(r.id)}${r.swarm ? `/${encodeURIComponent(r.swarm)}` : ''}${q ? `?${q}` : ''}`
      }
    case 'swarms':
      return '#/swarms'
    case 'swarm':
      {
        const q = [r.statement ? `b=${encodeURIComponent(r.statement)}` : '', r.tab ? `tab=${r.tab}` : ''].filter(Boolean).join('&')
        return `#/swarms/${encodeURIComponent(r.id)}${q ? `?${q}` : ''}`
      }
    case 'lifecycle':
      return `#/swarms/${encodeURIComponent(r.swarm)}/lifecycle`
    case 'new':
      return `#/new${r.swarm ? `?swarm=${encodeURIComponent(r.swarm)}` : ''}`
    case 'usage':
      return '#/usage'
    case 'approvals':
      return `#/approvals${r.tab && r.tab !== 'pending' ? `/${r.tab}` : ''}${r.focus ? `?id=${encodeURIComponent(r.focus)}` : ''}`
    case 'goals':
      return href({ name: 'tasks', ...(r.swarm ? { swarm: r.swarm } : {}), ...(r.swarm && r.goal ? { task: r.goal } : {}) })
    case 'lab':
      if (r.run) return `#/lab/run/${encodeURIComponent(r.run)}`
      if (r.dimension) return `#/lab/dim/${encodeURIComponent(r.dimension)}`
      return `#/lab${r.suite ? `/${encodeURIComponent(r.suite)}${r.tab === 'history' || r.tab === 'compare' ? `/${r.tab}` : ''}` : ''}`
  }
}

export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  const h = href(r)
  if (window.location.hash === h) return
  if (opts.replace) {
    // keep the entry's in-app index (see below) so closing a page can still step back past it
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${h}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = h
  }
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}
const snapshot = () => window.location.hash

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '')
  return parse(hash)
}

// ---------------------------------------------------------------- closing a page

/**
 * The page family a route belongs to: closing a page leaves its family, so a Lab run, its suite and the
 * Lab overview all close together, and the inbox's tabs close as one.
 */
export const pageKey = (r: Route): string => (r.name === 'goals' || r.name === 'boards' ? 'tasks' : r.name)

/** Routes that open a full page: the HUD's top bar hides on these and the navigation sits higher. One list for the app and its navigation. */
export const PAGE_ROUTES: readonly Route['name'][] = ['tasks', 'motivations', 'boards', 'flow', 'messages', 'settings', 'swarms', 'swarm', 'usage', 'approvals', 'goals', 'lab', 'programs', 'program', 'models', 'me', 'people', 'health', 'updates', 'explore', 'lifecycle', 'code', 'launch', 'roles', 'connect', 'artifacts', 'assets', 'setup', 'conversations']
export const isPageRoute = (name: Route['name']): boolean => PAGE_ROUTES.includes(name)

/** Where a page goes when there is no in-app history to return to (a deep link, a fresh tab). */
export function parentOf(r: Route): Route {
  switch (r.name) {
    case 'lifecycle':
      return { name: 'swarm', id: r.swarm }
    case 'swarm':
    case 'launch':
      return { name: 'swarms' }
    case 'connect':
      return r.swarm ? { name: 'swarm', id: r.swarm } : { name: 'swarms' }
    case 'program':
      return { name: 'programs' }
    case 'motivations':
      return r.id ? { name: 'motivations' } : { name: 'hive' }
    case 'lab':
      return r.suite || r.run || r.dimension ? { name: 'lab' } : { name: 'hive' }
    case 'roles':
      return r.id ? { name: 'roles' } : { name: 'hive' }
    case 'models':
      return r.provider ? { name: 'models' } : { name: 'hive' }
    case 'code':
      if (r.map) return { name: 'code', map: '' }
      return r.target || r.map !== undefined ? { name: 'code' } : { name: 'hive' }
    case 'approvals':
      return r.tab || r.focus ? { name: 'approvals' } : { name: 'hive' }
    case 'dot':
      return r.program ? { name: 'dot', id: r.id } : { name: 'hive' }
    default:
      return { name: 'hive' }
  }
}

/**
 * How many history steps back the nearest in-app entry from another page family is, as a negative
 * `history.go` delta, or null when there is none (the person arrived here directly).
 * `trail[i]` is the hash of in-app history entry i; `cur` is the current entry.
 */
export function closeDelta(trail: readonly (string | undefined)[], cur: number, here: Route): number | null {
  const key = pageKey(here)
  for (let j = cur - 1; j >= 0; j--) {
    const h = trail[j]
    if (h === undefined) return null
    if (pageKey(parse(h)) !== key) return j - cur
  }
  return null
}

// Every history entry this app visits is stamped with its index in history.state, and the hash of each
// index is kept for the session, so a page knows whether "back" stays in the app and where it lands.
const TRAIL_KEY = 'omegadots.nav.trail'
let trail: (string | undefined)[] = []
let cur = 0

function saveTrail() {
  try {
    window.sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail.slice(0, cur + 1)))
  } catch {
    /* storage unavailable: closing falls back to the parent after a reload */
  }
}

function stamp() {
  const st = history.state as { hiveIdx?: unknown } | null
  if (typeof st?.hiveIdx === 'number') {
    cur = st.hiveIdx
  } else {
    cur = trail.length ? cur + 1 : 0
    trail = trail.slice(0, cur)
    history.replaceState({ ...(st && typeof st === 'object' ? st : {}), hiveIdx: cur }, '')
  }
  trail[cur] = window.location.hash
  saveTrail()
}

if (typeof window !== 'undefined' && typeof history !== 'undefined') {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(TRAIL_KEY) ?? '[]') as unknown
    if (Array.isArray(saved) && typeof (history.state as { hiveIdx?: unknown } | null)?.hiveIdx === 'number') {
      trail = saved.map((x) => (typeof x === 'string' ? x : undefined))
    }
  } catch {
    trail = []
  }
  stamp()
  window.addEventListener('hashchange', stamp)
}

/**
 * A surface's X: always the home screen (the experience's own hive), never whatever surface was open before it
 * (the owner 2026-10-08). The open surface's history entry is replaced by home, so nothing is reopened, while Back and Esc
 * keep stepping through the person's in-app history as before.
 */
export function closeToHome(): void {
  navigate({ name: 'hive' }, { replace: true })
  // home is clean: every experience closes the panels it keeps open under a shared page (sheet, deck, room, …)
  for (const fn of [...homeListeners]) {
    try {
      fn()
    } catch (e) {
      console.error('home:requested listener failed', e)
    }
  }
}

const homeListeners = new Set<() => void>()
/** home:requested — a surface's X sent the person home. Returns the unsubscribe. */
export function onHomeRequested(fn: () => void): () => void {
  homeListeners.add(fn)
  return () => {
    homeListeners.delete(fn)
  }
}
/** An experience's answer to home:requested: close its own panels so the X lands on a clean home screen. */
export function useHomeRequested(fn: () => void): void {
  const latest = useRef(fn)
  useEffect(() => {
    latest.current = fn
  })
  useEffect(() => onHomeRequested(() => latest.current()), [])
}

/**
 * Esc on a page (Back semantics, not the X): back to where the person came from when that was elsewhere in the app,
 * otherwise `fallback` (by default the route's logical parent).
 */
export function closePage(fallback?: () => void): void {
  const here = parse(window.location.hash)
  const d = closeDelta(trail, cur, here)
  if (d !== null) history.go(d)
  else if (fallback) fallback()
  else navigate(parentOf(here))
}
