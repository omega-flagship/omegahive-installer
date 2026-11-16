/**
 * Workbench Map: the repo-map Slice A routes, read as a signed-in member (PLATFORM_REPO_MAP_SLICE_A_CONTRACT_R1 §3).
 * The only module that builds those paths or reads their answers. Every answer is untrusted and checked strictly; an
 * answer that does not fit is `unreadable` (fail closed), never a guess, and nothing here fills in a missing value.
 *
 *   GET  /api/repo-maps                                      revisions visible to the caller
 *   GET  /api/repo-maps/{repo}/{sha}                         header + coverage + counts (no nodes or edges)
 *   GET  /api/repo-maps/{repo}/{sha}/nodes?kind=&path_prefix=&q=&limit=&cursor=
 *   GET  /api/repo-maps/{repo}/{sha}/nodes/{node_id}?limit=&cursor=   the node, a page of its edges and neighbours
 *   GET  /api/repo-maps/{repo}/presets                       presets and their parameters
 *   POST /api/repo-maps/{repo}/{sha}/query {preset, params, limit?, cursor?}
 *   GET  /api/repo-maps/{repo}/drift?from=&to=&limit=&cursor=
 *
 * The adapter pin (Surface reply §3): `schema` and `extractor.id`/`version`. Any other schema is "This map uses a
 * newer format" and nothing is drawn; an extractor outside the pin is refused the same way, with its own words.
 */
import { ApiError, type HiveClient } from './client'

export const REPO_MAP_SCHEMA = 'repo-map/1'
/**
 * The extractors this view reads, as exact id + version pairs (Code, PREDEGA_REAL_REPO_MAP_HANDOFF_R1: the real map is
 * `omegacode.repository_map` version `1`; the parser stays in `extractor.parser` and is not pinned). The second pair
 * is Code's hand-written SYNTHETIC shape fixture (version `fixture`), which no real map carries. Anything else is
 * refused as a newer format, never guessed at.
 */
export const EXTRACTOR_PIN: readonly { id: string; version: string }[] = [
  { id: 'omegacode.repository_map', version: '1' },
  { id: 'omegacode.repository_facts', version: 'fixture' },
]

export const PAGE_DEFAULT = 50
export const PAGE_MAX = 200

export const MAP_STATES = ['ready', 'partial', 'stale', 'unavailable', 'failed'] as const
export type MapState = (typeof MAP_STATES)[number]
export const PRESETS = ['imports', 'potential-dependents', 'defines', 'calls-expression', 'source-search', 'test-doc-links', 'drift'] as const
export type PresetName = (typeof PRESETS)[number]

export interface Ref {
  path: string
  line: number
  excerpt: string
}
export interface MapNode {
  id: string
  kind: string
  label: string
  source_digest: string
  refs: Ref[]
  /** explicit ambiguity from the extractor (top level or in `declaration`) */
  ambiguous?: boolean
  declaration?: Record<string, unknown>
  /** a potential-dependents result's distance from the chosen node (1 = a direct link); absent elsewhere */
  distance?: number
}
export interface MapEdge {
  id: string
  kind: string
  from: string
  to: string
  /** syntax | declared | heuristic | … as the extractor wrote it */
  basis: string
  /** the extractor's own words on the basis (e.g. "same-file or imported-module name candidate; …"), verbatim */
  basis_note?: string
  refs: Ref[]
}
export interface Extractor {
  id: string
  version: string
  parser: string | null
}
export interface Provenance {
  repo: string
  sha: string
  snapshot_digest: string | null
  extractor: Extractor
  generated_at: string | null
  receipt: { digest: string | null; artifact_ref: string | null } | null
}
export interface Coverage {
  kinds: string[]
  languages: string[]
  unresolved: { path: string; issue: string }[]
  /** every other coverage field the map states (test_doc_links, complete_runtime_impact, …), as written, in order */
  other: [string, string][]
  /** the extractor's note per edge kind (Code R2: coverage.edge_basis_notes), verbatim; null when not stated */
  edge_basis_notes: Record<string, string> | null
}
export interface MapHeader extends Provenance {
  schema: string
  /** verbatim; an unknown word stays as written and is shown as not drawable */
  state: string
  reason: string
  coverage: Coverage | null
  counts: MapCounts | null
  /** the source map's own state, verbatim (host r1.1); absent before it: the view falls back to `state` */
  revision_state?: string
  revision_reason?: string
  /** the repo space's mount, as the host reports it (r1.2); absent on older hosts */
  space?: RepoSpace
}
/**
 * The repo space mount (host r1.2 6e33535 `space`): `status` verbatim (queued, mounting, mounted, failed, incomplete,
 * unmounted), `atoms` (null = contents unknown, never 0), and while mounting `added` of `total`. Only `mounted` is
 * ready. Separate from the map's own state: the map's pages are read either way.
 */
export interface RepoSpace {
  id: string | null
  kind: string | null
  status: string
  atoms: number | null
  reason: string | null
  added: number | null
  total: number | null
}
/**
 * The host's counts (repo-map Slice A e4008ac): scalar totals (nodes, edges, refs, unresolved) plus the dictionaries
 * nodes_by_kind, edges_by_kind and edges_by_basis. Node kinds come only from nodes_by_kind; a total is never a kind.
 */
export interface MapCounts {
  totals: Record<string, number>
  nodes_by_kind: Record<string, number> | null
  edges_by_kind: Record<string, number> | null
  edges_by_basis: Record<string, number> | null
}
/** A row of GET /api/repo-maps. A row outside the pin keeps only its repo, sha and schema, and cannot be opened. */
export type Revision =
  | (Provenance & { schema: string; state: string; reason: string; counts: MapCounts | null; pin: null })
  | { repo: string; sha: string; schema: string; pin: MapFailure }
export interface Paged {
  truncated: boolean
  next_cursor: string | null
  /** a result's own state (a query past its time bound is `partial`, reason `time_bound`); absent when not given */
  state?: string
  reason?: string
  /** the source map's state on this answer (host r1.1), separate from the operation's own state */
  revision_state?: string
  revision_reason?: string
}
export interface NodePage extends Paged {
  nodes: MapNode[]
}
export interface NodeDetail extends Paged {
  node: MapNode
  edges: MapEdge[]
  neighbours: MapNode[]
}
export interface PresetParam {
  name: string
  type: 'string' | 'integer' | 'boolean'
  required: boolean
  description: string | null
  minimum?: number
  maximum?: number
}
export interface Preset {
  name: string
  params: PresetParam[]
  /** the schema's oneOf: exactly one of these groups of parameters must be given (e.g. [[node_id], [path]]) */
  oneOf: string[][]
  description: string | null
  basis_note: string | null
}
export interface QueryResult extends Paged {
  nodes: MapNode[]
  edges: MapEdge[]
  basis_note: string | null
}
/** A node as a drift record carries it (no refs: identity, kind, label, digest). */
export interface DriftNode {
  id: string
  kind: string | null
  label: string | null
  source_digest: string | null
}
/**
 * One drift record (host e4008ac): added/removed carry `node`; changed carries `id`, `from`, `to`; moved carries
 * `from` and `to`. Every record states its `basis` (e.g. "unique source_digest match" for a move).
 */
export interface DriftItem {
  id: string
  basis: string
  node: DriftNode | null
  from: DriftNode | null
  to: DriftNode | null
}
export interface DriftResult extends Paged {
  from: string
  to: string
  basis_note: string | null
  added: DriftItem[]
  removed: DriftItem[]
  changed: DriftItem[]
  moved: DriftItem[]
}

// ---------------------------------------------------------------------------------------------------- failures

export type MapFailure =
  | { kind: 'newer_format'; schema: string }
  | { kind: 'extractor_unpinned'; id: string; version: string }
  | { kind: 'not_found' }
  | { kind: 'denied' }
  | { kind: 'cursor_expired' }
  | { kind: 'invalid_cursor' }
  | { kind: 'unknown_preset'; message: string }
  | { kind: 'bad_request'; message: string }
  | { kind: 'too_large' }
  | { kind: 'map_exists' }
  | { kind: 'not_served' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'unreadable'; message: string }

export type Read<T> = { ok: true; value: T } | { ok: false; failure: MapFailure }

/** The contract's error codes (§3) as what the view does with them. Anything else is unavailable, never data. */
export function classify(e: unknown): MapFailure {
  if (!(e instanceof ApiError)) return { kind: 'unavailable', message: e instanceof Error ? e.message : String(e) }
  switch (e.code) {
    case 'schema_unsupported':
      return { kind: 'newer_format', schema: '' }
    case 'not_found':
      return { kind: 'not_found' }
    case 'cursor_expired':
      return { kind: 'cursor_expired' }
    case 'invalid_cursor':
      return { kind: 'invalid_cursor' }
    case 'unknown_preset':
      return { kind: 'unknown_preset', message: e.message }
    case 'bad_request':
      return { kind: 'bad_request', message: e.message }
    case 'too_large':
      return { kind: 'too_large' }
    case 'map_exists':
      return { kind: 'map_exists' }
  }
  if (e.status === 401 || e.status === 403) return { kind: 'denied' }
  if (e.status === 410) return { kind: 'cursor_expired' }
  if (e.status === 422) return { kind: 'newer_format', schema: '' }
  // a response over the 256 KiB bound refused by the host (413, whatever its code word): too large, never empty
  if (e.status === 413 || /too_large|response_bound|over_bound/.test(e.code)) return { kind: 'too_large' }
  // a 404 without the contract's code: the hive has no Slice A routes (or hides the map); either way, nothing to draw
  if (e.status === 404) return { kind: 'not_served' }
  return { kind: 'unavailable', message: e.message || `HTTP ${e.status}` }
}

/** Plain words for a failure, for the view. */
export function failureWords(f: MapFailure): { title: string; body: string } {
  switch (f.kind) {
    case 'newer_format':
      return { title: 'This map uses a newer format', body: `This view reads ${REPO_MAP_SCHEMA} only${f.schema ? `; this map is ${f.schema}` : ''}. Nothing is drawn rather than guessed.` }
    case 'extractor_unpinned':
      return { title: 'This map uses a newer format', body: `It was made by ${f.id} ${f.version}, which this view does not read yet. Nothing is drawn rather than guessed.` }
    case 'not_found':
      return { title: 'Repository map unavailable', body: 'This map does not exist here, or you can’t see it.' }
    case 'denied':
      return { title: 'Repository map unavailable', body: 'You can’t see this map with the sign-in you have now. Nothing from it is shown.' }
    case 'not_served':
      return { title: 'Repository maps aren’t served here yet', body: 'This hive does not answer the repository map routes. Nothing is shown in their place.' }
    case 'cursor_expired':
      return { title: 'The list expired', body: 'Its page marker was more than an hour old, so it was read again from the start.' }
    case 'invalid_cursor':
      return { title: 'The page marker no longer matches', body: 'It belongs to a different query or person. Start again from the first page.' }
    case 'unknown_preset':
      return { title: 'This hive has no such preset', body: f.message }
    case 'bad_request':
      return { title: 'The hive could not read that request', body: f.message }
    case 'too_large':
      return { title: 'Result too large for one page', body: 'The hive refused to send it as one page (over its 256 KiB bound). Nothing from it is drawn, and this is not an empty result.' }
    case 'map_exists':
      return { title: 'Already loaded', body: 'That revision is already loaded with different content.' }
    case 'unavailable':
      return { title: 'Repository map unavailable', body: f.message }
    case 'unreadable':
      return { title: 'The hive’s answer could not be read', body: f.message }
  }
}

// ---------------------------------------------------------------------------------------------------- readers

class Unreadable extends Error {}
const bad = (what: string): never => {
  throw new Unreadable(what)
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : bad(`${what} is not text`))
const optStr = (v: unknown, what: string): string | null => (v === undefined || v === null ? null : str(v, what))
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : bad(`${what} is not true or false`))
const arr = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : bad(`${what} is not a list`))

function readRef(v: unknown): Ref {
  if (!isObj(v)) return bad('a ref is not an object')
  const line = v.line
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) return bad('a ref line is not a whole number')
  return { path: str(v.path, 'a ref path'), line, excerpt: str(v.excerpt ?? '', 'a ref excerpt') }
}
const readRefs = (v: unknown): Ref[] => (v === undefined ? [] : arr(v, 'refs').map(readRef))

export function readNode(v: unknown): MapNode {
  if (!isObj(v)) return bad('a node is not an object')
  const decl = isObj(v.declaration) ? v.declaration : undefined
  const ambiguous = v.ambiguous === true || decl?.ambiguous === true
  const distance = v.distance === undefined || v.distance === null ? undefined : whole(v.distance, 'a node distance')
  return {
    ...(distance !== undefined ? { distance } : {}),
    id: str(v.id, 'a node id'),
    kind: str(v.kind, 'a node kind'),
    label: str(v.label, 'a node label'),
    source_digest: str(v.source_digest ?? '', 'a node source digest'),
    refs: readRefs(v.refs),
    ...(ambiguous ? { ambiguous: true } : {}),
    ...(decl ? { declaration: decl } : {}),
  }
}
export function readEdge(v: unknown): MapEdge {
  if (!isObj(v)) return bad('an edge is not an object')
  const note = optStr(v.basis_note, 'an edge basis note')
  return { id: str(v.id, 'an edge id'), kind: str(v.kind, 'an edge kind'), from: str(v.from, 'an edge end'), to: str(v.to, 'an edge end'), basis: str(v.basis, 'an edge basis'), ...(note ? { basis_note: note } : {}), refs: readRefs(v.refs) }
}
function readExtractor(v: unknown): Extractor {
  if (!isObj(v)) return bad('extractor is missing')
  return { id: str(v.id, 'extractor.id'), version: str(v.version, 'extractor.version'), parser: optStr(v.parser, 'extractor.parser') }
}
function readProvenance(v: Record<string, unknown>): Provenance {
  const receipt = v.receipt
  return {
    repo: str(v.repo, 'repo'),
    sha: str(v.sha, 'sha'),
    snapshot_digest: optStr(v.snapshot_digest, 'snapshot_digest'),
    extractor: readExtractor(v.extractor),
    generated_at: optStr(v.generated_at, 'generated_at'),
    receipt: isObj(receipt) ? { digest: optStr(receipt.digest, 'receipt.digest'), artifact_ref: optStr(receipt.artifact_ref, 'receipt.artifact_ref') } : receipt == null ? null : bad('receipt is not an object'),
  }
}
const whole = (n: unknown, what: string): number => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : bad(`${what} is not a whole number`))
function readTally(v: unknown, what: string): Record<string, number> | null {
  if (v === undefined || v === null) return null
  if (!isObj(v)) return bad(`${what} is not an object`)
  return Object.fromEntries(Object.entries(v).map(([k, n]) => [k, whole(n, `${what}.${k}`)]))
}
const TALLIES = ['nodes_by_kind', 'edges_by_kind', 'edges_by_basis'] as const
function readCounts(v: unknown): MapCounts | null {
  if (v === undefined || v === null) return null
  if (!isObj(v)) return bad('counts is not an object')
  const totals: Record<string, number> = {}
  for (const [k, n] of Object.entries(v)) {
    if ((TALLIES as readonly string[]).includes(k)) continue
    // an unknown nested tally is not a total and not a kind: left out rather than misread
    if (isObj(n)) continue
    totals[k] = whole(n, `count ${k}`)
  }
  return { totals, nodes_by_kind: readTally(v.nodes_by_kind, 'nodes_by_kind'), edges_by_kind: readTally(v.edges_by_kind, 'edges_by_kind'), edges_by_basis: readTally(v.edges_by_basis, 'edges_by_basis') }
}
/** revision_state / revision_reason when the host sends them (r1.1). */
function readRevisionState(v: Record<string, unknown>): { revision_state?: string; revision_reason?: string } {
  return {
    ...(v.revision_state !== undefined && v.revision_state !== null ? { revision_state: str(v.revision_state, 'revision_state') } : {}),
    ...(v.revision_reason !== undefined && v.revision_reason !== null ? { revision_reason: str(v.revision_reason, 'revision_reason') } : {}),
  }
}
function readCoverage(v: unknown): Coverage | null {
  if (v === undefined || v === null) return null
  if (!isObj(v)) return bad('coverage is not an object')
  return {
    kinds: arr(v.kinds ?? [], 'coverage.kinds').map((k) => str(k, 'a covered kind')),
    languages: arr(v.languages ?? [], 'coverage.languages').map((k) => str(k, 'a covered language')),
    unresolved: arr(v.unresolved ?? [], 'coverage.unresolved').map((u) => (isObj(u) ? { path: str(u.path, 'an unresolved path'), issue: str(u.issue, 'an unresolved issue') } : bad('an unresolved entry is not an object'))),
    edge_basis_notes: isObj(v.edge_basis_notes) && Object.values(v.edge_basis_notes).every((x) => typeof x === 'string') ? (v.edge_basis_notes as Record<string, string>) : null,
    other: Object.entries(v)
      .filter(([k]) => k !== 'kinds' && k !== 'languages' && k !== 'unresolved')
      .map(([k, x]): [string, string] => [k, typeof x === 'string' ? x : JSON.stringify(x)]),
  }
}
function readPaged(v: Record<string, unknown>): Paged {
  const truncated = v.truncated === undefined ? false : bool(v.truncated, 'truncated')
  const next = optStr(v.next_cursor, 'next_cursor')
  return { truncated, next_cursor: next, ...(v.state !== undefined && v.state !== null ? { state: str(v.state, 'state') } : {}), ...(v.reason !== undefined && v.reason !== null ? { reason: str(v.reason, 'reason') } : {}), ...readRevisionState(v) }
}

/** The pin: the schema first (so an unknown envelope is never read further), then the extractor. */
export function pinFailure(v: { schema?: unknown; extractor?: unknown }): MapFailure | null {
  if (v.schema !== REPO_MAP_SCHEMA) return { kind: 'newer_format', schema: typeof v.schema === 'string' ? v.schema : '' }
  const ex = isObj(v.extractor) ? v.extractor : {}
  const id = typeof ex.id === 'string' ? ex.id : ''
  const version = typeof ex.version === 'string' ? ex.version : ''
  if (!EXTRACTOR_PIN.some((p) => p.id === id && p.version === version)) return { kind: 'extractor_unpinned', id: id || 'an unnamed extractor', version: version || '(no version)' }
  return null
}

export function readSpace(v: unknown): RepoSpace | undefined {
  if (v === undefined || v === null) return undefined
  if (!isObj(v)) return bad('space is not an object')
  const atoms = v.atoms === null || v.atoms === undefined ? null : whole(v.atoms, 'space.atoms')
  const num = (x: unknown, what: string) => (x === undefined || x === null ? null : whole(x, what))
  return { id: optStr(v.id, 'space.id'), kind: optStr(v.kind, 'space.kind'), status: str(v.status, 'space.status'), atoms, reason: optStr(v.reason, 'space.reason'), added: num(v.added, 'space.added'), total: num(v.total, 'space.total') }
}
export function readHeader(v: unknown): MapHeader {
  if (!isObj(v)) return bad('the map header is not an object')
  const space = readSpace(v.space)
  return { ...readProvenance(v), schema: str(v.schema, 'schema'), state: str(v.state, 'state'), reason: str(v.reason ?? '', 'reason'), coverage: readCoverage(v.coverage), counts: readCounts(v.counts), ...readRevisionState(v), ...(space ? { space } : {}) }
}
export function readRevisions(v: unknown): Revision[] {
  const rows = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.revisions) ? v.revisions : isObj(v) && Array.isArray(v.maps) ? v.maps : bad('the revision list is not a list')
  return rows.map((r): Revision => {
    if (!isObj(r)) return bad('a revision is not an object')
    const pin = pinFailure(r)
    if (pin) return { repo: str(r.repo, 'repo'), sha: str(r.sha, 'sha'), schema: typeof r.schema === 'string' ? r.schema : '', pin }
    return { ...readProvenance(r), schema: str(r.schema, 'schema'), state: str(r.state, 'state'), reason: str(r.reason ?? '', 'reason'), counts: readCounts(r.counts), pin: null }
  })
}
export function readNodePage(v: unknown): NodePage {
  if (!isObj(v)) return bad('the node page is not an object')
  return { ...readPaged(v), nodes: arr(v.nodes, 'nodes').map(readNode) }
}
export function readNodeDetail(v: unknown): NodeDetail {
  if (!isObj(v)) return bad('the node detail is not an object')
  // the host's neighbours are `nodes` (e4008ac); `neighbours` is read only when `nodes` is absent
  return { ...readPaged(v), node: readNode(v.node), edges: arr(v.edges ?? [], 'edges').map(readEdge), neighbours: arr(v.nodes ?? v.neighbours ?? [], 'nodes').map(readNode) }
}
function readParam(name: string, v: unknown, required: boolean): PresetParam {
  if (!isObj(v)) return bad(`parameter ${name} is not an object`)
  const t = v.type
  const type = t === 'string' || t === 'integer' || t === 'boolean' ? t : bad(`parameter ${name} has an unknown type`)
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
  const lo = num(v.minimum)
  const hi = num(v.maximum)
  return { name, type, required, description: optStr(v.description, `parameter ${name} description`), ...(lo !== undefined ? { minimum: lo } : {}), ...(hi !== undefined ? { maximum: hi } : {}) }
}
/**
 * Presets as the host sends them (e4008ac): `preset` names it; `params` is a JSON Schema object (properties, required,
 * oneOf). The oneOf groups are kept, so "exactly one of node_id or path" stays a rule the composer enforces.
 */
export function readPresets(v: unknown): Preset[] {
  const rows = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.presets) ? v.presets : bad('the preset list is not a list')
  return rows.map((p) => {
    if (!isObj(p)) return bad('a preset is not an object')
    const name = str(p.preset ?? p.name, 'a preset name')
    const schema = p.params ?? { type: 'object', properties: {} }
    if (!isObj(schema) || (schema.type !== undefined && schema.type !== 'object')) return bad(`preset ${name} parameters are not a JSON Schema object`)
    const props = schema.properties === undefined ? {} : isObj(schema.properties) ? schema.properties : bad(`preset ${name} properties are not an object`)
    const required = arr(schema.required ?? [], `preset ${name} required`).map((r) => str(r, `preset ${name} required entry`))
    const oneOf = arr(schema.oneOf ?? [], `preset ${name} oneOf`).map((g) => (isObj(g) ? arr(g.required ?? [], `preset ${name} oneOf entry`).map((r) => str(r, `preset ${name} oneOf name`)) : bad(`preset ${name} oneOf entry is not an object`)))
    for (const g of oneOf) for (const k of g) if (!(k in props)) bad(`preset ${name} oneOf names an unknown parameter ${k}`)
    const params = Object.entries(props).map(([k, x]) => readParam(k, x, required.includes(k)))
    return { name, params, oneOf, description: optStr(p.description, `preset ${name} description`), basis_note: optStr(p.basis_note, `preset ${name} basis_note`) }
  })
}
export function readQuery(v: unknown): QueryResult {
  if (!isObj(v)) return bad('the query result is not an object')
  return { ...readPaged(v), nodes: arr(v.nodes ?? [], 'nodes').map(readNode), edges: arr(v.edges ?? [], 'edges').map(readEdge), basis_note: optStr(v.basis_note, 'basis_note') }
}
function readDriftNode(v: unknown, what: string): DriftNode | null {
  if (v === undefined || v === null) return null
  if (!isObj(v)) return bad(`${what} is not a node`)
  return { id: str(v.id, `${what} id`), kind: optStr(v.kind, `${what} kind`), label: optStr(v.label, `${what} label`), source_digest: optStr(v.source_digest, `${what} source_digest`) }
}
function readDriftItem(v: unknown, list: string): DriftItem {
  // a bare string (or anything not a record) is never read as a change, least of all as a move
  if (!isObj(v)) return bad(`a ${list} record is not an object`)
  const node = readDriftNode(v.node, `a ${list} node`)
  const from = readDriftNode(v.from, `a ${list} from`)
  const to = readDriftNode(v.to, `a ${list} to`)
  const id = typeof v.id === 'string' ? v.id : (node?.id ?? to?.id ?? from?.id ?? bad(`a ${list} record names no node`))
  return { id, basis: typeof v.basis === 'string' ? v.basis : '', node, from, to }
}
export function readDrift(v: unknown, from: string, to: string): DriftResult {
  if (!isObj(v)) return bad('the drift result is not an object')
  const list = (k: string) => arr(v[k] ?? [], k).map((x) => readDriftItem(x, k))
  return { ...readPaged(v), from, to, basis_note: optStr(v.basis_note, 'basis_note'), added: list('added'), removed: list('removed'), changed: list('changed'), moved: list('moved') }
}

// ---------------------------------------------------------------------------------------------------- routes

const enc = encodeURIComponent
export const clampLimit = (n?: number): number => Math.max(1, Math.min(PAGE_MAX, Math.floor(n ?? PAGE_DEFAULT) || PAGE_DEFAULT))
const qs = (o: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}
export const routes = {
  list: () => '/api/repo-maps',
  header: (repo: string, sha: string) => `/api/repo-maps/${enc(repo)}/${enc(sha)}`,
  nodes: (repo: string, sha: string, o: { kind?: string; path_prefix?: string; q?: string; limit?: number; cursor?: string | null } = {}) =>
    `/api/repo-maps/${enc(repo)}/${enc(sha)}/nodes${qs({ kind: o.kind, path_prefix: o.path_prefix, q: o.q, limit: clampLimit(o.limit), cursor: o.cursor })}`,
  node: (repo: string, sha: string, id: string, o: { limit?: number; cursor?: string | null } = {}) => `/api/repo-maps/${enc(repo)}/${enc(sha)}/nodes/${enc(id)}${qs({ limit: clampLimit(o.limit), cursor: o.cursor })}`,
  presets: (repo: string) => `/api/repo-maps/${enc(repo)}/presets`,
  query: (repo: string, sha: string) => `/api/repo-maps/${enc(repo)}/${enc(sha)}/query`,
  drift: (repo: string, from: string, to: string, o: { limit?: number; cursor?: string | null } = {}) => `/api/repo-maps/${enc(repo)}/drift${qs({ from, to, limit: clampLimit(o.limit), cursor: o.cursor })}`,
}

export interface QueryBody {
  preset: string
  params: Record<string, string | number | boolean>
  limit?: number
  cursor?: string | null
}

async function call<T>(client: Pick<HiveClient, 'repoMapRequest'> | null | undefined, method: 'GET' | 'POST', path: string, read: (v: unknown) => T, body?: unknown): Promise<Read<T>> {
  if (!client?.repoMapRequest) return { ok: false, failure: { kind: 'not_served' } }
  let raw: unknown
  try {
    raw = await client.repoMapRequest(method, path, body)
  } catch (e) {
    return { ok: false, failure: classify(e) }
  }
  try {
    return { ok: true, value: read(raw) }
  } catch (e) {
    if (e instanceof Unreadable) return { ok: false, failure: { kind: 'unreadable', message: e.message } }
    throw e
  }
}

/** Header reads check the pin before anything else is read. */
const pinned = <T,>(read: (v: unknown) => T) => (v: unknown): T => {
  const f = isObj(v) ? pinFailure(v) : { kind: 'unreadable' as const, message: 'the map header is not an object' }
  if (f) throw new PinRefused(f)
  return read(v)
}
class PinRefused extends Error {
  constructor(readonly failure: MapFailure) {
    super(failure.kind)
  }
}

export function repoMapApi(client: Pick<HiveClient, 'repoMapRequest'> | null | undefined) {
  const guard = async <T,>(p: Promise<Read<T>>): Promise<Read<T>> => {
    try {
      return await p
    } catch (e) {
      if (e instanceof PinRefused) return { ok: false, failure: e.failure }
      throw e
    }
  }
  return {
    list: () => call(client, 'GET', routes.list(), readRevisions),
    header: (repo: string, sha: string) => guard(call(client, 'GET', routes.header(repo, sha), pinned(readHeader))),
    nodes: (repo: string, sha: string, o: Parameters<typeof routes.nodes>[2] = {}) => call(client, 'GET', routes.nodes(repo, sha, o), readNodePage),
    node: (repo: string, sha: string, id: string, o: Parameters<typeof routes.node>[3] = {}) => call(client, 'GET', routes.node(repo, sha, id, o), readNodeDetail),
    presets: (repo: string) => call(client, 'GET', routes.presets(repo), readPresets),
    query: (repo: string, sha: string, body: QueryBody) => call(client, 'POST', routes.query(repo, sha), readQuery, { preset: body.preset, params: body.params, limit: clampLimit(body.limit), ...(body.cursor ? { cursor: body.cursor } : {}) }),
    drift: (repo: string, from: string, to: string, o: Parameters<typeof routes.drift>[3] = {}) => call(client, 'GET', routes.drift(repo, from, to, o), (v) => readDrift(v, from, to)),
  }
}
export type RepoMapApi = ReturnType<typeof repoMapApi>

// ---------------------------------------------------------------------------------------------------- paging

/** A paged list as shown: what was read, whether more is available, and a note when it had to be read again. */
export interface PagedList<T> {
  items: T[]
  truncated: boolean
  next: string | null
  /** set when an expired cursor (410) made the list read again from the start */
  note: string | null
}
/** The host's cursors always advance (r1.2): the same marker handed back is an error, never a reason to loop. */
export const STUCK: MapFailure = { kind: 'unreadable', message: 'The hive handed back the same page marker; the list stops here rather than repeat.' }
export const EXPIRED_NOTE = 'The page marker expired after an hour, so the list was read again from the start.'

/**
 * The next page. A 410 `cursor_expired` reads the list again from the first page, replacing (never appending to) what
 * was shown, with a note. Any other failure is returned as is (an invalid cursor is not retried: the person starts
 * again). Never retries more than once.
 */
export async function nextPage<T>(cur: PagedList<T>, fetch: (cursor: string | null) => Promise<Read<{ items: T[]; truncated: boolean; next_cursor: string | null }>>): Promise<Read<PagedList<T>>> {
  if (!cur.next) return { ok: true, value: cur }
  const r = await fetch(cur.next)
  if (r.ok && r.value.next_cursor !== null && r.value.next_cursor === cur.next) return { ok: false, failure: STUCK }
  if (r.ok) return { ok: true, value: { items: [...cur.items, ...r.value.items], truncated: r.value.truncated, next: r.value.next_cursor, note: null } }
  if (r.failure.kind !== 'cursor_expired') return r
  const again = await fetch(null)
  if (!again.ok) return again
  return { ok: true, value: { items: again.value.items, truncated: again.value.truncated, next: again.value.next_cursor, note: EXPIRED_NOTE } }
}
export const firstPage = <T,>(p: { items: T[]; truncated: boolean; next_cursor: string | null }): PagedList<T> => ({ items: p.items, truncated: p.truncated, next: p.next_cursor, note: null })

/**
 * Read a list to its end, page by page, at most `maxPages` pages (then it stays truncated, with its cursor). A 410
 * mid-way reads it again from the start once, with the note; any other failure is returned as is.
 */
export async function readAll<T>(fetch: (cursor: string | null) => Promise<Read<{ items: T[]; truncated: boolean; next_cursor: string | null }>>, maxPages: number): Promise<Read<PagedList<T>>> {
  let restarted = false
  for (;;) {
    const first = await fetch(null)
    if (!first.ok) return first
    let cur = firstPage(first.value)
    let pages = 1
    let expired = false
    while (cur.next && pages < maxPages) {
      const r = await fetch(cur.next)
      pages++
      if (!r.ok) {
        if (r.failure.kind === 'cursor_expired' && !restarted) {
          expired = true
          break
        }
        return r
      }
      if (r.value.next_cursor !== null && r.value.next_cursor === cur.next) return { ok: false, failure: STUCK }
      cur = { items: [...cur.items, ...r.value.items], truncated: r.value.truncated, next: r.value.next_cursor, note: null }
    }
    if (!expired) return { ok: true, value: { ...cur, note: restarted ? EXPIRED_NOTE : null } }
    restarted = true
  }
}
