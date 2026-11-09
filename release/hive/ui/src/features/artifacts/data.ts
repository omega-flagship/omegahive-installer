import type { ArtifactKind, ArtifactList, HiveArtifact } from '../../api/moneyWork'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { openInDesign, type Route } from '../../lib/router'
import type { ResourceStatus } from '../../lib/useResource'
import type { ScreenFacts } from '../../screens/screenSpace'
import { withResource } from '../../screens/resourceFacts'
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

const KIND_ICON: Record<ArtifactKind, string> = { review: 'doc', flow: 'graph', exhibit: 'layers', 'app-result': 'apps' }
const KINDS: (ArtifactKind | 'all')[] = ['all', 'review', 'flow', 'exhibit', 'app-result']

/** One row as the screen draws it, with the place its button opens. */
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
}

export interface Option { id: string; label: string }

const unique = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))]

export function artifactsScreen(loaded: Loaded, f: ArtifactFilter, names: Names, now = Date.now()): { data: Record<string, unknown>; facts: ScreenFacts } {
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

  const rows: ArtifactRow[] = filterArtifacts(items, f, swarmOfMind).map((a) => {
    const swarm = swarmOf(a)
    const open = openFor(a, swarm, names, appName)
    return {
      id: a.key,
      title: a.title,
      kind: KIND_LABEL[a.kind],
      icon: KIND_ICON[a.kind],
      state: a.state ?? '',
      byline: [a.mind_id && `by ${mindName(a.mind_id)}`, a.app && `via ${appName(a.app)}`, swarm && `in ${swarmName(swarm)}`, a.at && ago(a.at, now)].filter(Boolean).join(' · '),
      detail: a.detail || a.artifact_id ? [a.to_swarm && `Sent to ${swarmName(a.to_swarm)}`, a.detail].filter(Boolean).join(' · ') : '',
      code: a.artifact_id ? `${a.artifact_id}${a.revision ? ` r${a.revision}` : ''}` : '',
      action: open?.label ?? '',
      route: open?.route ?? null,
    }
  })

  return withResource(loaded, {
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
  })
}

/** Where a row's button goes: the exact revision in Design, the flows, who sees an exhibit, or the app that made it. */
function openFor(a: HiveArtifact, swarm: string | null, names: Names, appName: (id: string) => string): { label: string; route: Route } | null {
  const design = a.ref && swarm ? openInDesign(a.ref, swarm) : undefined
  if (design) return { label: 'Open in Design', route: design }
  if (a.kind === 'flow') return { label: 'Open flows', route: { name: 'flow' } }
  if (a.kind === 'exhibit' && a.mind_id && names.minds[a.mind_id]) return { label: 'Who sees it', route: { name: 'dot', id: a.mind_id, tab: 'memory' } }
  if (a.app) return { label: `Open ${appName(a.app)}`, route: { name: 'program', id: a.app, swarm: a.swarm_id ?? undefined } }
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
