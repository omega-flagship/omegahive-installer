import type { ExploreArrangement, ExploreFacet, ExploreGroupDef, ExploreKind, ExploreResult, ExploreSpec, ExploreView } from '../../api/types'
import { shown } from '../../lib/displayName'
import { plural } from '../../lib/plural'
import type { ResourceLike } from '../../screens/resourceFacts'
import { withResource } from '../../screens/resourceFacts'
import type { ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import { moved } from './arrange'

/**
 * What the Explore screens are told (explore.metta): the values they draw (bound by path) and this moment's facts
 * (counts and flags) from which MeTTa composes them. Each of my groups is composed as its own small screen, and the
 * explore screen stacks them. Pure: composing and what this hive offers are handed in.
 */
export type Compose = (screen: string, facts: ScreenFacts) => ScreenPlan
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }

export const KINDS: { value: ExploreKind; label: string }[] = [
  { value: 'mind', label: 'Minds' }, { value: 'swarm', label: 'Swarms' }, { value: 'app', label: 'Apps' }, { value: 'room', label: 'Rooms' },
]
export const FACET_LABEL: Record<ExploreFacet, string> = {
  kind: 'Kind', where: 'Where', state: 'State', swarm: 'Swarm', purpose: 'Purpose', role: 'Role', owner: 'Owner',
  visibility: 'Visibility', health: 'Health', spend: 'Spend', active: 'Last active', tag: 'Tag', group: 'My groups',
}
/** The filter facets, in the order the side column lists them (explore.metta names each). */
export const SIDEBAR: ExploreFacet[] = ['group', 'tag', 'state', 'where', 'kind', 'swarm', 'purpose', 'role', 'health', 'visibility', 'owner', 'active', 'spend']
export const DEFAULT_SPEC: ExploreSpec = { kinds: ['mind', 'swarm', 'app', 'room'], filters: {}, q: '', group_by: ['kind'], sort: 'name' }
/** Most values a facet lists. */
const FACET_MOST = 12
const LAYOUTS = ['list', 'grid', 'tree'] as const
export type Layout = (typeof LAYOUTS)[number]
export const isLayout = (v: string): v is Layout => (LAYOUTS as readonly string[]).includes(v)

/** One tick box of a filter: the value, its label with its count, whether it is ticked, and the facet it filters. */
export interface Check { id: string; label: string; on: boolean; facet?: ExploreFacet }

/** One kind chip: the kind, its name, and how many there are (once the hive has answered). */
export interface KindChip { id: ExploreKind; label: string; count?: string }

/** What the explorer offers here, and how reading it stands. */
export interface ExploreInput {
  /** this hive offers the explorer */
  supported: boolean
  result: ExploreResult | null
  /** the last read's failure, while the last answer (if any) stays */
  error: string | null
  spec: ExploreSpec
  /** the words being typed (sent to the hive a moment later) */
  q: string
  layout: Layout
  viewId: string | null
  views: ExploreView[]
  groups: ExploreGroupDef[]
  groupsOpen: boolean
  can: { groups: boolean; rename: boolean; remove: boolean }
  /** the group being renamed, and why its new name will not do */
  renaming: string | null
  problem: string | null
}

/** How reading the explorer stands, as the one standard resource state the screens read. */
export function exploreResource(supported: boolean, result: ExploreResult | null, error: string | null): ResourceLike {
  if (!supported) return { status: 'unsupported' }
  if (!result) return error ? { status: 'error', error: new Error(error) } : { status: 'loading' }
  return { status: result.total === 0 ? 'empty' : 'ready', error: error ? new Error(error) : undefined }
}

/** One of my groups, as its own small screen. */
export function groupItem(g: ExploreGroupDef, x: Pick<ExploreInput, 'can' | 'renaming' | 'problem'>, compose: Compose): StackItem {
  const editing = x.renaming === g.id
  const problem = editing ? x.problem ?? '' : ''
  return {
    id: g.id,
    plan: compose('explore-group', {
      flags: { 'group.editing': editing, 'group.problem': problem !== '', 'can.rename': x.can.rename, 'can.remove': x.can.remove },
    }),
    data: { 'group.name': g.name, 'group.size': plural(g.members.length, 'member'), 'group.problem': problem },
  }
}

/** The Explore screen: the toolbar, kinds, groupings, my groups, how reading stands, and the filters. */
export function exploreScreen(x: ExploreInput, compose: Compose): Composed {
  const { result, spec } = x
  const groupBy = spec.group_by ?? []
  // the kinds, as chips pressed on and off: each with its count once the hive has answered; the chosen ones are bound apart
  const kinds: KindChip[] = KINDS.map((k) => (result ? { id: k.value, label: k.label, count: String(result.facets.kind?.[k.value] ?? 0) } : { id: k.value, label: k.label }))
  const kindsOn = KINDS.map((k) => k.value).filter((k) => (spec.kinds ?? []).includes(k))
  const counts: Record<string, number> = {}
  const data: Record<string, unknown> = {}
  for (const f of SIDEBAR) {
    const values = Object.entries(result?.facets[f] ?? {})
    const useful = values.length > 0 && !(values.length === 1 && values[0][0] === '(none)')
    const chosen = spec.filters?.[f] ?? []
    const checks: Check[] = useful ? values.slice(0, FACET_MOST).map(([v, n]) => ({ id: v, label: `${v} ${n}`, on: chosen.includes(v), facet: f })) : []
    data[`facet.${f}`] = checks
    counts[`facet.${f}`] = checks.length
  }
  groupBy.slice(0, 3).forEach((g, i) => { data[`groupby.${i + 1}.label`] = FACET_LABEL[g] })
  const unused = (result?.facet_names ?? []).filter((f) => !groupBy.includes(f)).map((f) => ({ id: f, label: FACET_LABEL[f] }))
  const filters = Object.values(spec.filters ?? {}).reduce((n, v) => n + (v?.length ?? 0), 0)
  const groups = x.can.groups ? x.groups.map((g) => groupItem(g, x, compose)) : []

  return withResource(exploreResource(x.supported, result, x.error), {
    data: {
      ...data,
      'explore.eyebrow': result ? `${result.total} shown` : 'Everything in this hive',
      'explore.kinds': kinds,
      'explore.kinds.on': kindsOn,
      'explore.views': x.views.map((v) => ({ id: v.id, label: shown(v.name) })),
      'explore.unused': unused,
      'explore.groups': groups,
      q: x.q,
      layout: x.layout,
      view: x.viewId ?? '',
      'add-grouping': '',
      'groups.open': x.groupsOpen,
    },
    facts: {
      counts: { ...counts, 'explore.groups': groups.length, 'explore.filters': filters },
      flags: {
        'view.saved': !!x.viewId,
        'can.groups': x.can.groups,
        'groups.open': x.groupsOpen,
        'explore.grouped': !!result?.groups,
        'groupby.1': groupBy.length >= 1,
        'groupby.2': groupBy.length >= 2,
        'groupby.3': groupBy.length >= 3,
        'groupby.room': groupBy.length < 3,
      },
    },
  })
}

// ---------- what a press does to the spec (pure)

/** A kind ticked on or off; the last kind ticked stays, so something is always shown. */
export function withKind(s: ExploreSpec, kind: string): ExploreSpec {
  if (!KINDS.some((k) => k.value === kind)) return s
  const cur = s.kinds ?? []
  const kinds = cur.includes(kind as ExploreKind) ? cur.filter((k) => k !== kind) : [...cur, kind as ExploreKind]
  return { ...s, kinds: kinds.length ? kinds : s.kinds }
}

/** A filter value ticked on or off; a facet with nothing ticked is dropped. */
export function withFilter(s: ExploreSpec, facet: ExploreFacet, value: string): ExploreSpec {
  const cur = s.filters?.[facet] ?? []
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
  const filters = { ...s.filters, [facet]: next }
  if (!next.length) delete filters[facet]
  return { ...s, filters }
}

/** The grouping in place `at` (1, 2 or 3) moved one place earlier. */
export function groupedEarlier(s: ExploreSpec, at: number): ExploreSpec {
  const groupBy = s.group_by ?? []
  const g = groupBy[at - 1]
  return g && at > 1 ? { ...s, group_by: moved(groupBy, g, at - 2) as ExploreFacet[] } : s
}

/** The grouping in place `at` (1, 2 or 3) dropped. */
export function ungrouped(s: ExploreSpec, at: number): ExploreSpec {
  const groupBy = s.group_by ?? []
  return at >= 1 && at <= groupBy.length ? { ...s, group_by: groupBy.filter((_, i) => i !== at - 1) } : s
}

/** A grouping added at the end (at most three, never twice). */
export function grouped(s: ExploreSpec, facet: string): ExploreSpec {
  const groupBy = s.group_by ?? []
  if (!(facet in FACET_LABEL) || groupBy.includes(facet as ExploreFacet) || groupBy.length >= 3) return s
  return { ...s, group_by: [...groupBy, facet as ExploreFacet] }
}

/** The arrangement a saved view brings, or a fresh one. */
export function arrangementOf(v: ExploreView | undefined, empty: ExploreArrangement): ExploreArrangement {
  return v ? { ...empty, ...v.arrangement } : empty
}
