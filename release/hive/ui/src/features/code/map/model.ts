/**
 * Workbench Map, the pure part: what the view says and draws from a repo-map/1 answer, and nothing it did not contain.
 * - `state` and `reason` are shown verbatim; partial, stale, unavailable and failed are never drawn as complete or
 *   empty (an unknown state word is not drawable: fail closed).
 * - Heuristic edges (basis `heuristic`, and the `calls-expression` / `potential-dependents` kinds whatever their
 *   basis) are dashed and labelled "heuristic"; a heuristic link is never presented as a call.
 * - A node is ambiguous when the extractor says so, or when two nodes share one id; each is kept separate.
 * - Drift: `moved` only with explicit rename correspondence or identity evidence and both ends; anything else is shown
 *   as removed + added. The plain verdict comes first.
 * Copy: OmegaDesign predega-observatory-r2/copy.json (`repository`), verbatim.
 */
import { packCircles, type Placed } from '../../../scene/rings'
import type { DriftItem, DriftResult, MapCounts, RepoSpace, MapEdge, MapHeader, MapNode, Paged, Ref } from '../../../api/repoMap'

export const COPY = {
  title: 'Repository map',
  askContext: 'About this repository revision',
  relatedTests: 'Related tests',
  previousUnavailable: 'Previous revision unavailable',
  partial: 'Partial extraction — some source relationships could not be read.',
  sourceUnavailable: 'Source unavailable here. Its recorded identity and revision are retained.',
  empty: 'No items in this view. Choose another scope or revision.',
  failure: 'Repository map unavailable. Extraction did not complete.',
  narrowed: 'This view is scoped. Open another subsystem to see more.',
} as const

export const TESTS_NOTE = 'declared and static links only, not runtime coverage'
export const short = (sha: string): string => (/^[0-9a-f]{8,}$/i.test(sha) ? sha.slice(0, 7) : sha)

// ---------------------------------------------------------------------------------------------------- state

export type Tone = 'ok' | 'amber' | 'rose'
export interface StateView {
  /** the state word exactly as the host sent it */
  state: string
  /** the reason exactly as the host sent it */
  reason: string
  tone: Tone
  /** whether anything may be drawn from this map */
  drawable: boolean
  /** whether what is drawn may be presented as complete */
  complete: boolean
  /** the plain note shown beside the state (null for ready) */
  note: string | null
}

export function stateView(state: string, reason: string): StateView {
  const base = { state, reason }
  switch (state) {
    case 'ready':
      return { ...base, tone: 'ok', drawable: true, complete: true, note: null }
    case 'partial':
      return { ...base, tone: 'amber', drawable: true, complete: false, note: COPY.partial }
    case 'stale':
      return { ...base, tone: 'amber', drawable: true, complete: false, note: 'Stale — this map may no longer match its repository. What is drawn is as it was recorded.' }
    case 'unavailable':
      return { ...base, tone: 'amber', drawable: false, complete: false, note: 'Repository map unavailable. Nothing is drawn in its place.' }
    case 'failed':
      return { ...base, tone: 'rose', drawable: false, complete: false, note: COPY.failure }
    default:
      return { ...base, tone: 'amber', drawable: false, complete: false, note: 'This map’s state is not one this view knows, so nothing is drawn.' }
  }
}

/**
 * The REVISION's state: what the source map is (host r1.1 `revision_state`, verbatim), shown on every view of that
 * revision. An answer's own `revision_state` wins over the header's; without it, the header's `revision_state`, and
 * before r1.1 the header's `state`. A `ready` operation never hides a partial source.
 */
export function revisionState(h: Pick<MapHeader, 'state' | 'reason' | 'revision_state' | 'revision_reason'>, op?: Pick<Paged, 'revision_state' | 'revision_reason'> | null): StateView {
  if (op?.revision_state !== undefined) return stateView(op.revision_state, op.revision_reason ?? '')
  if (h.revision_state !== undefined) return stateView(h.revision_state, h.revision_reason ?? '')
  return stateView(h.state, h.reason)
}
/**
 * An operation's line when its own state and the revision's differ, or the revision is not ready: both said, e.g.
 * "Query complete · map is partial: <reason>". Null when both are ready (nothing to add).
 */
export function operationWords(what: string, op: Pick<Paged, 'state' | 'reason'>, rev: StateView): string | null {
  const opState = op.state ?? 'ready'
  if (opState === 'ready' && rev.state === 'ready') return null
  const head = opState === 'ready' ? `${what} complete` : `${what} ${opState}${op.reason ? `: ${op.reason}` : ''}`
  return `${head} · map is ${rev.state}${rev.reason ? `: ${rev.reason}` : ''}`
}

/**
 * The repo space's mount in plain words: the status verbatim; atoms null = "contents unknown" (never "0"); mounting
 * shows its progress; queued and unmounted say what they are rather than a count. Only `mounted` is settled.
 */
export function spaceWords(sp: RepoSpace): { status: string; contents: string; reason: string | null; settled: boolean; waiting: boolean } {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const atoms = (n: number) => `${fmt(n)} ${n === 1 ? 'atom' : 'atoms'}`
  const contents =
    sp.atoms === null ? 'contents unknown'
    : sp.status === 'mounting' ? (sp.added !== null && sp.total !== null ? `${fmt(sp.added)} of ${fmt(sp.total)} atoms` : 'progress not reported')
    : sp.status === 'queued' ? 'waiting to mount'
    : sp.status === 'unmounted' ? 'not mounted yet'
    : atoms(sp.atoms)
  return { status: sp.status, contents, reason: sp.reason, settled: sp.status === 'mounted', waiting: SPACE_WAITING.includes(sp.status) }
}
/** Mount states the view re-reads the header for (bounded): the header read itself starts an unmounted revision's mount. */
export const SPACE_WAITING: readonly string[] = ['queued', 'mounting', 'unmounted']
/**
 * Re-reads while the native space settles (Platform ruling 2 on r1.1): 3 s rising by 0.5 s a read to 15 s, at most 25
 * reads (225 s, about 3¾ minutes, enough for a real-size mount of 75–145 s), then "Check again". The space never decides
 * whether the map is complete: the map's reads answer from the host's database (ruling 1), so there is no withSpace.
 */
export const SPACE_POLL_MAX = 25
export const spacePollDelay = (n: number): number => Math.min(15000, 3000 + 500 * n)

export const TONE_COLOR: Record<Tone, string> = { ok: 'var(--color-good)', amber: 'var(--color-warn)', rose: 'var(--color-bad)' }

/** What an empty scope says: only a complete map may say "no items"; anything else says why it may be missing. */
export function emptyWords(v: StateView): string {
  if (v.complete) return COPY.empty
  return `Nothing was read in this scope. The map is ${v.state}${v.reason ? `: ${v.reason}` : ''}. This is not the same as having no items.`
}

export const scopedCount = (n: number): string => `${n} ${n === 1 ? 'item' : 'items'} in this view`
export const truncatedWords = (n: number, truncated: boolean): string | null => (truncated ? `showing first ${n}; more available` : null)

// ---------------------------------------------------------------------------------------------------- counts, coverage

export const KIND_ORDER = ['file', 'module', 'def', 'import', 'test', 'doc'] as const
const KIND_WORD: Record<string, [string, string]> = {
  file: ['file', 'files'],
  module: ['module', 'modules'],
  def: ['definition', 'definitions'],
  import: ['import', 'imports'],
  test: ['test', 'tests'],
  doc: ['doc', 'docs'],
  edges: ['relationship', 'relationships'],
}
export const kindWord = (kind: string, n: number): string => (KIND_WORD[kind] ? KIND_WORD[kind][n === 1 ? 0 : 1] : kind)

/** Node counts by kind, from nodes_by_kind only, in the order Code lists kinds, then any other kind the host sent. */
export function countRows(counts: MapCounts | null): { kind: string; n: number; words: string }[] {
  const by = counts?.nodes_by_kind
  if (!by) return []
  const keys = [...KIND_ORDER.filter((k) => k in by), ...Object.keys(by).filter((k) => !(KIND_ORDER as readonly string[]).includes(k)).sort()]
  return keys.map((k) => ({ kind: k, n: by[k], words: `${by[k]} ${kindWord(k, by[k])}` }))
}
/** The scalar totals as written (nodes, edges, refs, unresolved, …): totals, never kinds. */
export const totalRows = (counts: MapCounts | null): string[] => (counts ? Object.entries(counts.totals).map(([k, n]) => `${k} ${n}`) : [])
/** A tally (edges_by_kind / edges_by_basis) as "name n" words, biggest first. */
export const tallyWords = (t: Record<string, number> | null): string[] => (t ? Object.entries(t).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`) : [])

export interface CoverageLines {
  supported: string
  unresolved: { path: string; issue: string }[]
  /** unresolved entries by issue, biggest first (the issue words verbatim) */
  byIssue: { issue: string; n: number }[]
  other: [string, string][]
  known: boolean
}
export function coverageLines(h: Pick<MapHeader, 'coverage'>): CoverageLines {
  const c = h.coverage
  if (!c) return { supported: 'Coverage not stated by this map.', unresolved: [], byIssue: [], other: [], known: false }
  const kinds = c.kinds.length ? c.kinds.join(', ') : 'no kinds stated'
  const langs = c.languages.length ? c.languages.join(', ') : 'no languages stated'
  const by = new Map<string, number>()
  for (const u of c.unresolved) by.set(u.issue, (by.get(u.issue) ?? 0) + 1)
  const byIssue = [...by.entries()].map(([issue, n]) => ({ issue, n })).sort((a, b) => b.n - a.n || a.issue.localeCompare(b.issue))
  return { supported: `Reads ${kinds} in ${langs}.`, unresolved: c.unresolved, byIssue, other: c.other ?? [], known: true }
}
/** How many unresolved entries are listed one by one before the rest are counted (all stay countable by issue). */
export const UNRESOLVED_SHOWN = 40

// ---------------------------------------------------------------------------------------------------- nodes, modules

/** The node's repository path as the answer gives it: its first ref, or a file/module's own label. */
export const pathOf = (n: MapNode): string | null => n.refs[0]?.path ?? (n.kind === 'file' || n.kind === 'module' ? n.label : null)
export const TOP_LEVEL = '(top level)'
export const NO_PATH = '(no path given)'
export const topOf = (path: string | null): string => (path === null ? NO_PATH : path.includes('/') ? path.slice(0, path.indexOf('/')) : TOP_LEVEL)

/**
 * The kinds the overview reads in full to find the top-level modules: every kind the map counts except the fine-grained
 * ones (definitions, imports), which are read per module when the person opens it. Without counts: the covered kinds.
 */
export function overviewKinds(h: Pick<MapHeader, 'counts' | 'coverage'>): string[] {
  const all = h.counts?.nodes_by_kind ? Object.keys(h.counts.nodes_by_kind) : (h.coverage?.kinds ?? [])
  return all.filter((k) => k !== 'def' && k !== 'import')
}
/** The overview's page bound (200 per page): past it the overview says it is truncated and stops. */
export const OVERVIEW_MAX_PAGES = 60

/** Index positions of ambiguous nodes: flagged by the extractor, or sharing an id with another node. */
export function ambiguousAt(nodes: MapNode[]): Set<number> {
  const seen = new Map<string, number[]>()
  nodes.forEach((n, i) => seen.set(n.id, [...(seen.get(n.id) ?? []), i]))
  const out = new Set<number>()
  nodes.forEach((n, i) => {
    if (n.ambiguous || (seen.get(n.id)?.length ?? 0) > 1) out.add(i)
  })
  return out
}

export interface ModuleGroup {
  module: string
  /** indexes into the node list */
  items: number[]
  counts: Record<string, number>
}
/** Top-level modules of the nodes read so far, biggest first (a path's first segment; nothing merged by name). */
export function moduleGroups(nodes: MapNode[]): ModuleGroup[] {
  const by = new Map<string, ModuleGroup>()
  nodes.forEach((n, i) => {
    const m = topOf(pathOf(n))
    const g = by.get(m) ?? { module: m, items: [], counts: {} }
    g.items.push(i)
    g.counts[n.kind] = (g.counts[n.kind] ?? 0) + 1
    by.set(m, g)
  })
  return [...by.values()].sort((a, b) => b.items.length - a.items.length || a.module.localeCompare(b.module))
}

export interface FileGroup {
  path: string
  items: number[]
}
/** Inside one module: the nodes grouped by their path (a file and what the answer places in it). */
export function fileGroups(nodes: MapNode[], group: ModuleGroup): FileGroup[] {
  const by = new Map<string, FileGroup>()
  for (const i of group.items) {
    const p = pathOf(nodes[i]) ?? NO_PATH
    const g = by.get(p) ?? { path: p, items: [] }
    g.items.push(i)
    by.set(p, g)
  }
  return [...by.values()].sort((a, b) => b.items.length - a.items.length || a.path.localeCompare(b.path))
}

/** A mark at one level of the map: a directory (opens a deeper level) or a file (and what the answer places in it). */
export interface ChildGroup {
  key: string
  label: string
  kind: 'dir' | 'file'
  items: number[]
}
/** The directory a path sits in (TOP_LEVEL for a path with no directory). */
export const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : TOP_LEVEL)
/** One level up from a scope (null = the repository). */
export const scopeUp = (scope: string): string | null => (scope === TOP_LEVEL || scope === NO_PATH || !scope.includes('/') ? null : scope.slice(0, scope.lastIndexOf('/')))
/**
 * What one level shows: at the repository, the top-level modules; inside a directory, its subdirectories and its files
 * (repository → subsystem → file, Design r2), biggest first. Paths are the answer's; nothing is grouped by name.
 */
export function childGroups(nodes: MapNode[], scope: string | null): ChildGroup[] {
  if (scope === null) return moduleGroups(nodes).map((g) => ({ key: g.module, label: g.module, kind: 'dir' as const, items: g.items }))
  const by = new Map<string, ChildGroup>()
  nodes.forEach((n, i) => {
    const p = pathOf(n)
    let key: string
    let kind: 'dir' | 'file'
    if (scope === NO_PATH) {
      if (p !== null) return
      key = n.id
      kind = 'file'
    } else if (scope === TOP_LEVEL) {
      if (p === null || p.includes('/')) return
      key = p
      kind = 'file'
    } else {
      if (p === null || !p.startsWith(`${scope}/`)) return
      const rest = p.slice(scope.length + 1)
      kind = rest.includes('/') ? 'dir' : 'file'
      key = kind === 'dir' ? `${scope}/${rest.slice(0, rest.indexOf('/'))}` : p
    }
    const g = by.get(key) ?? { key, label: key.slice(key.lastIndexOf('/') + 1), kind, items: [] }
    g.items.push(i)
    by.set(key, g)
  })
  return [...by.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label))
}
/** At most this many marks at one level; the rest are counted and listed (Show as list), never silently dropped. */
export const MAX_MARKS = 36

/** The hive view's packing (scene/rings packCircles): bigger groups take more room; the same approach at every level. */
export const groupRadius = (n: number): number => 30 + Math.sqrt(Math.max(1, n)) * 16
export function packGroups<T extends { items: number[] }>(groups: T[], key: (g: T) => string): { places: Placed[]; radius: number } {
  return packCircles(groups.map((g) => ({ id: key(g), r: groupRadius(g.items.length) })))
}

// ---------------------------------------------------------------------------------------------------- edges

const HEURISTIC_KINDS = new Set(['calls-expression', 'calls_expression', 'potential-dependents', 'potential_dependents'])
export interface EdgeLook {
  heuristic: boolean
  dashed: boolean
  /** the edge's plain name */
  name: string
  /** the tag drawn on it: "heuristic", or its basis */
  tag: string
}
const EDGE_NAME: Record<string, string> = {
  imports: 'imports',
  defines: 'defines',
  'calls-expression': 'call expression',
  calls_expression: 'call expression',
  'potential-dependents': 'potential dependent (static, transitive)',
  potential_dependents: 'potential dependent (static, transitive)',
  'test-doc-link': 'related test or doc',
  test_doc_link: 'related test or doc',
}
export function edgeLook(e: Pick<MapEdge, 'kind' | 'basis'>): EdgeLook {
  const heuristic = e.basis === 'heuristic' || HEURISTIC_KINDS.has(e.kind)
  return { heuristic, dashed: heuristic, name: EDGE_NAME[e.kind] ?? e.kind, tag: heuristic ? 'heuristic' : e.basis }
}

export interface EdgeGroup {
  kind: string
  name: string
  rows: { edge: MapEdge; look: EdgeLook; outward: boolean; other: string; otherNode: MapNode | null }[]
}
/** A node's edges by kind, each with the node at its other end (from the neighbours the answer carried, or its id). */
export function edgesByKind(nodeId: string, edges: MapEdge[], neighbours: MapNode[]): EdgeGroup[] {
  const byId = new Map(neighbours.map((n) => [n.id, n]))
  const out = new Map<string, EdgeGroup>()
  for (const edge of edges) {
    const outward = edge.from === nodeId
    const other = outward ? edge.to : edge.from
    const look = edgeLook(edge)
    const g = out.get(edge.kind) ?? { kind: edge.kind, name: look.name, rows: [] }
    g.rows.push({ edge, look, outward, other, otherNode: byId.get(other) ?? null })
    out.set(edge.kind, g)
  }
  return [...out.values()]
}

// ---------------------------------------------------------------------------------------------------- refs

export type Anchor =
  | { state: 'exact'; ref: Ref }
  | { state: 'moved'; ref: Ref; was: Ref; warning: string }
  | { state: 'unavailable'; was: Ref; words: string }

/**
 * Where a ref opens. A ref read at the revision on screen opens at its own line. A ref recorded at another revision is
 * re-anchored by its excerpt among the refs the answer gave for this revision: same path and the same excerpt (the
 * line may differ: "this line has moved since <sha>"). With no such ref it does not open (never unrelated text).
 */
export function anchorRef(ref: Ref, refSha: string, viewSha: string, current: Ref[]): Anchor {
  if (refSha === viewSha) return { state: 'exact', ref }
  const same = current.find((r) => r.path === ref.path && r.excerpt === ref.excerpt && r.excerpt.trim() !== '')
  if (!same) return { state: 'unavailable', was: ref, words: COPY.sourceUnavailable }
  if (same.line === ref.line) return { state: 'exact', ref: same }
  return { state: 'moved', ref: same, was: ref, warning: `this line has moved since ${short(refSha)}` }
}

// ---------------------------------------------------------------------------------------------------- drift

export interface DriftView {
  verdict: string
  added: DriftItem[]
  removed: DriftItem[]
  changed: DriftItem[]
  moved: DriftItem[]
  /** moved records shown as removed + added because they stated no basis or lacked an end */
  demoted: number
  complete: boolean
}

/**
 * A moved record counts as moved only with both ends (two different nodes) and a stated basis (the host's "unique
 * source_digest match"). Anything less is never drawn as a move.
 */
export const hasMoveEvidence = (m: DriftItem): boolean => !!m.from && !!m.to && m.from.id !== m.to.id && m.basis.trim() !== ''
export const driftLabel = (it: DriftItem): string => it.node?.label ?? it.to?.label ?? it.from?.label ?? it.id

const plural = (n: number, w: string) => `${n} ${w}`
export function driftView(d: DriftResult): DriftView {
  const moved: DriftItem[] = []
  const added = [...d.added]
  const removed = [...d.removed]
  let demoted = 0
  for (const m of d.moved) {
    if (hasMoveEvidence(m)) {
      moved.push(m)
      continue
    }
    demoted++
    if (m.from) removed.push({ id: m.from.id, basis: m.basis, node: m.from, from: null, to: null })
    if (m.to) added.push({ id: m.to.id, basis: m.basis, node: m.to, from: null, to: null })
    if (!m.from && !m.to) added.push({ ...m, from: null, to: null })
  }
  const bases = [...new Set(moved.map((m) => m.basis))]
  const parts = [
    added.length ? plural(added.length, 'added') : '',
    removed.length ? plural(removed.length, 'removed') : '',
    d.changed.length ? plural(d.changed.length, 'changed') : '',
    moved.length ? `${moved.length} moved (basis: ${bases.join('; ')})` : '',
  ].filter(Boolean)
  const complete = !d.truncated && (d.state === undefined || d.state === 'ready')
  const head = parts.length ? `Since ${short(d.from)}: ${parts.join(', ')}.` : complete ? `No changes between ${short(d.from)} and ${short(d.to)}.` : `No changes read between ${short(d.from)} and ${short(d.to)} so far.`
  const qual = d.state && d.state !== 'ready' ? ` The comparison is ${d.state}${d.reason ? `: ${d.reason}` : ''}.` : ''
  const more = d.truncated ? ' Showing the first records; more available.' : ''
  return { verdict: head + qual + more, added, removed, changed: d.changed, moved, demoted, complete }
}

export const evidenceWords = (m: DriftItem): string => (m.basis ? `basis: ${m.basis}` : 'no basis stated')
