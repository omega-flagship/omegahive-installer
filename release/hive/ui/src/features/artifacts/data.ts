// Purpose: what the Artifacts and findings screen is told, the values it draws and the facts MeTTa composes it from,
// and the artifacts it lists, which the page tells the Ask.
import type { ArtifactKind, ArtifactList, HiveArtifact } from '../../api/moneyWork'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { openInDesign, type Route } from '../../lib/router'
import type { ResourceStatus } from '../../lib/useResource'
import type { ScreenFacts } from '../../screens/screenSpace'
import { withResource } from '../../screens/resourceFacts'
import type { ChatAbout } from '../dot/chatAbout'
import { filterArtifacts, KIND_LABEL, NO_FILTER, type ArtifactFilter } from './artifacts'

/**
 * What the Artifacts and findings screen is told: the values it draws (bound by path) and this moment's facts (counts
 * and flags) from which MeTTa composes it (artifacts.metta). Pure: names and the clock come in as arguments.
 */
export interface Loaded {
  status: ResourceStatus
  list?: ArtifactList
  /** the last failure: the first read's (status error), or the latest refresh's while the last list stays on screen */
  error?: unknown
}

/** The names the rows show: minds (and their swarm), swarms, and apps. */
export interface Names {
  minds: Record<string, { name: string; swarm_id?: string | null } | undefined>
  swarms: Record<string, { name: string } | undefined>
  apps: Record<string, string | undefined>
}

const KIND_ICON: Record<ArtifactKind, string> = { creation: 'spark', review: 'doc', flow: 'graph', exhibit: 'layers', 'app-result': 'apps' }
const KINDS: (ArtifactKind | 'all')[] = ['all', 'creation', 'review', 'flow', 'exhibit', 'app-result']

/** One row as the screen draws it, with the place its button opens and, when that is its mind's chat, the artifact the
 * chat box carries there (features/dot/chatAbout). */
export interface ArtifactRow {
  id: string
  title: string
  kind: string
  icon: string
  state: string
  byline: string
  detail: string
  code: string
  action: string
  route: Route | null
  /** The saved revision the button opens in place on this page, when that is where the row opens: as text, or, for a
   *  view (`view`), as the interactive view it was made to be (features/views). */
  read: { artifact_id: string; revision: number; view?: boolean } | null
  about: ChatAbout | null
}

export interface Option { id: string; label: string }

const unique = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))]

/**
 * `listed`: the artifact ids of the rows shown, in their order, once each: what the Ask is told this page lists
 * (ArtifactsPage's view), which the hive names from its own data.
 */
export function artifactsScreen(loaded: Loaded, f: ArtifactFilter, names: Names, now = Date.now()): { data: Record<string, unknown>; facts: ScreenFacts; listed: string[] } {
  const items = loaded.list?.items ?? []
  const missing = loaded.list?.missing ?? []
  const swarmOfMind = (id: string) => names.minds[id]?.swarm_id ?? null
  const swarmOf = (a: HiveArtifact) => a.swarm_id ?? (a.mind_id ? swarmOfMind(a.mind_id) : null)
  const mindName = (id: string) => shown(names.minds[id]?.name ?? id)
  const swarmName = (id: string) => shown(names.swarms[id]?.name ?? id)
  const appName = (id: string) => shown(names.apps[id] ?? id)

  const counts: Record<string, number> = { all: items.length }
  for (const a of items) counts[a.kind] = (counts[a.kind] ?? 0) + 1
  const kinds = KINDS.map((k) => ({ id: k, label: k === 'all' ? 'Everything' : KIND_LABEL[k], count: counts[k] ?? 0 }))
  const swarms: Option[] = unique(items.map(swarmOf)).map((id) => ({ id, label: swarmName(id) }))
  const minds: Option[] = unique(items.map((a) => a.mind_id)).map((id) => ({ id, label: mindName(id) }))
  const apps: Option[] = unique(items.map((a) => a.app)).map((id) => ({ id, label: appName(id) }))

  const filtered = filterArtifacts(items, f, swarmOfMind)
  const rows: ArtifactRow[] = filtered.map((a) => {
    const swarm = swarmOf(a)
    const open = openFor(a, swarm, names, appName, mindName)
    return {
      id: a.key,
      title: a.title,
      kind: KIND_LABEL[a.kind],
      icon: KIND_ICON[a.kind],
      state: a.state ?? '',
      byline: [a.mind_id && `by ${mindName(a.mind_id)}`, a.app && `via ${appName(a.app)}`, swarm && `in ${swarmName(swarm)}`, a.at && ago(a.at, now)].filter(Boolean).join(' · '),
      detail: a.kind === 'creation' && !a.ref ? emptyWords(a, a.mind_id && names.minds[a.mind_id] ? mindName(a.mind_id) : null)
        : a.detail || a.artifact_id ? [a.to_swarm && `Sent to ${swarmName(a.to_swarm)}`, a.detail].filter(Boolean).join(' · ') : '',
      code: a.artifact_id ? `${a.artifact_id}${a.revision ? ` r${a.revision}` : ''}` : '',
      action: open?.label ?? '',
      route: open?.route ?? null,
      read: open?.read ?? null,
      about: open?.route?.name === 'dot' && open.route.tab === 'chat' && a.artifact_id ? { id: a.artifact_id, title: a.title } : null,
    }
  })

  return { ...withResource(loaded, {
    data: {
      'artifacts.kinds': kinds,
      'artifacts.swarms': swarms,
      'artifacts.minds': minds,
      'artifacts.apps': apps,
      'artifacts.shown': rows,
      'artifacts.missing.text': missing.length ? `Could not read ${missing.join(', ')} this time, so those are missing from the list.` : '',
      kind: f.kind,
      query: f.q,
      swarm: f.swarm,
      mind: f.mind,
      app: f.app,
    },
    facts: {
      counts: { 'artifacts.all': items.length, 'artifacts.shown': rows.length, 'artifacts.missing': missing.length, 'artifacts.apps': apps.length },
    },
  }), listed: unique(filtered.map((a) => a.artifact_id ?? a.ref?.artifact_id)) }
}

/** What a creation with nothing saved in it says under its title: who started it and that there is nothing to open.
 * A mind names it in one step and saves its text in another, and this is what is left when the second never came.
 * "Plan" (its kind) becomes "this plan"; the maker is named only when it is a mind this person sees. */
function emptyWords(a: HiveArtifact, maker: string | null): string {
  const what = `this ${(a.detail || 'artifact').toLowerCase()}`
  return maker ? `${maker} started ${what} but saved nothing in it, so there is nothing to open.` : `Nothing was saved in ${what}, so there is nothing to open.`
}

/** Design opens only what Studio keeps, its editable source (kind studio-source, hive/core/studio_sessions.py's
 * SOURCE_KIND); a plan a mind saved shows "This design could not be opened" there. A review row names no kind of its
 * own, so it keeps Design. */
const designOpens = (a: HiveArtifact) => a.kind !== 'creation' || a.creation_kind === 'studio-source'

/** Where a row's button goes: the place the thing lives, and only when that place opens for this person. An exact
 * revision Design can open opens there when the hive offers Design to them, a flow opens the flows, an exhibit who
 * sees it, and an
 * app's result the app when it is theirs to open. A saved view opens as the view it was made to be, in place on this
 * page. A saved creation Design can't open here is read in place on this
 * page. A row whose place does not open here (a creation with nothing saved in it, a review with no Design) opens the
 * chat of the mind that made it, the artifact on its box (the row's about), so what the person asks there is about it
 * and the mind can say what happened and save it again; with no such mind to ask, the row has no button. */
function openFor(a: HiveArtifact, swarm: string | null, names: Names, appName: (id: string) => string, mindName: (id: string) => string): { label: string; route?: Route; read?: ArtifactRow['read'] } | null {
  if (a.kind === 'creation' && a.ref && a.creation_kind === 'view') return { label: 'Open it', read: { artifact_id: a.ref.artifact_id, revision: a.ref.revision, view: true } }
  const design = a.ref && swarm && designOpens(a) ? openInDesign(a.ref, swarm) : undefined
  if (design?.name === 'program' && names.apps[design.id]) return { label: 'Open in Design', route: design }
  if (a.kind === 'flow') return { label: 'Open flows', route: { name: 'flow' } }
  if (a.kind === 'exhibit' && a.mind_id && names.minds[a.mind_id]) return { label: 'Who sees it', route: { name: 'dot', id: a.mind_id, tab: 'memory' } }
  if (a.app && names.apps[a.app]) return { label: `Open ${appName(a.app)}`, route: { name: 'program', id: a.app, swarm: a.swarm_id ?? undefined } }
  if (a.kind === 'creation' && a.ref) return { label: 'Read it', read: { artifact_id: a.ref.artifact_id, revision: a.ref.revision } }
  if (a.mind_id && names.minds[a.mind_id]) return { label: `Ask ${mindName(a.mind_id)}`, route: { name: 'dot', id: a.mind_id, tab: 'chat' } }
  return null
}

/** A filter after a person picks or types: `bind` names the field the screen bound. */
export function withInput(f: ArtifactFilter, bind: string, value: string): ArtifactFilter {
  switch (bind) {
    case 'kind': return KINDS.includes(value as ArtifactKind | 'all') ? { ...f, kind: value as ArtifactKind | 'all' } : f
    case 'query': return { ...f, q: value }
    case 'swarm': return { ...f, swarm: value }
    case 'mind': return { ...f, mind: value }
    case 'app': return { ...f, app: value }
    default: return f
  }
}

export { NO_FILTER }
