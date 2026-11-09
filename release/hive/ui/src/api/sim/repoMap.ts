/**
 * Workbench Map in the simulator (?sim=1): Code's synthetic repo-map/1 fixture (fixtures/repo-map-1.synthetic.json,
 * byte-identical to FIXTURE_repo-map-1.synthetic.json) served through the SAME
 * routes, errors, ACL and cursor policy as Platform's Slice A contract §3, so the page reads it exactly as it would
 * read a hive. SYNTHETIC: a shape fixture only (placeholder digests); revision 0…02 is INVENTED here from it, so drift
 * has a pair to compare. Nothing here is a real repository.
 *
 * ?repomap= plays a host state: ready | stale | unavailable | failed (the fixture's state replaced, reason kept as a
 * plain sentence), newer (schema repo-map/2), extractor (an extractor outside the pin), denied (the map is visible
 * only to a swarm the sim person is not in: 404), absent (a hive without the routes: bare 404), expired (the first
 * cursor handed out is already more than an hour old), tight (pages of 2, so paging and truncation show), mountheld
 * (the header carries a held repo-space mount: status incomplete, atoms null), mounting (the first two header reads
 * say mounting with progress, as host 6e33535 does; then mounted).
 */
import { ApiError } from '../client'
import fixture from './fixtures/repo-map-1.synthetic.json'

export type SimRepoMapVariant = 'default' | 'ready' | 'stale' | 'unavailable' | 'failed' | 'newer' | 'extractor' | 'denied' | 'absent' | 'expired' | 'tight' | 'real' | 'mountheld' | 'mounting'
const VARIANTS: readonly SimRepoMapVariant[] = ['default', 'ready', 'stale', 'unavailable', 'failed', 'newer', 'extractor', 'denied', 'absent', 'expired', 'tight', 'real', 'mountheld', 'mounting']

/**
 * ?repomap=real: Code's REAL map of PhysixSNET omegahive@c8a9aed (REAL_repo-map-1.c8a9aed.json, 20.8 MB) served through
 * the same routes. It is NOT part of this source tree or any bundle: it is fetched, only for this option, from
 * `repo-map.real.json` beside the page, where a local smoke places it (from Code's repo-map intake).
 * Absent there, the sim answers as a hive without the routes (bare 404): nothing is invented in its place.
 */
export const REAL_MAP_FILE = 'repo-map.real.json'
export async function loadRealMap(base: string): Promise<SimRepoMaps> {
  try {
    const res = await fetch(new URL(REAL_MAP_FILE, base).toString())
    if (!res.ok) return new SimRepoMaps({ variant: 'absent' })
    return new SimRepoMaps({ variant: 'real', real: (await res.json()) as unknown })
  } catch {
    return new SimRepoMaps({ variant: 'absent' })
  }
}
export function simRepoMapVariant(search: string): SimRepoMapVariant {
  const v = new URLSearchParams(search).get('repomap') ?? 'default'
  return (VARIANTS as readonly string[]).includes(v) ? (v as SimRepoMapVariant) : 'default'
}

type Json = Record<string, unknown>
type Node = { id: string; kind: string; label: string; source_digest: string; refs: { path: string; line: number; excerpt: string }[] }
type Edge = { id: string; kind: string; from: string; to: string; basis: string; refs: { path: string; line: number; excerpt: string }[] }
interface SimMap {
  env: Json & { repo: string; sha: string; nodes: Node[]; edges: Edge[] }
  visibility: string
}

export const SIM_REPO = 'fixture-mini'
export const SIM_SHA_1 = '0000000000000000000000000000000000000001'
export const SIM_SHA_2 = '0000000000000000000000000000000000000002'
const HOUR = 3_600_000
const CAP_BYTES = 256 * 1024
const STATE_REASON: Record<string, string> = {
  ready: 'all 4 Python files parsed',
  stale: 'a newer revision exists; this map was not refreshed',
  unavailable: 'the snapshot artifact is not retained on this host',
  failed: 'the extractor stopped before writing any facts',
}

/** The INVENTED second revision: add() moved to pkg/maths.py (same bytes), broken.py fixed, docs renamed (new bytes: no move). */
function revisionTwo(one: SimMap['env']): SimMap['env'] {
  const nodes: Node[] = one.nodes
    .filter((n) => n.id !== 'def:pkg/core.py::add' && n.id !== 'doc:docs/core.md')
    .map((n) => (n.id === 'file:pkg/broken.py' ? { ...n, source_digest: 'sha256:c3b', refs: [{ path: 'pkg/broken.py', line: 1, excerpt: 'def fixed():' }] } : n))
    // the test gained an import above it: same excerpt, two lines lower (a stale anchor re-anchors with a warning)
    .map((n) => (n.id === 'test:tests/test_core.py::test_add' ? { ...n, source_digest: 'sha256:d4b', refs: [{ path: 'tests/test_core.py', line: 5, excerpt: 'def test_add():' }] } : n))
  nodes.push(
    { id: 'file:pkg/maths.py', kind: 'file', label: 'pkg/maths.py', source_digest: 'sha256:f6', refs: [{ path: 'pkg/maths.py', line: 1, excerpt: '"""Maths."""' }] },
    // the same definition bytes as before (sha256:a1), unique among definitions: the host's move evidence
    { id: 'def:pkg/maths.py::add', kind: 'def', label: 'add', source_digest: 'sha256:a1', refs: [{ path: 'pkg/maths.py', line: 3, excerpt: 'def add(a, b):' }] },
    { id: 'doc:docs/maths.md', kind: 'doc', label: 'docs/maths.md', source_digest: 'sha256:e6', refs: [{ path: 'docs/maths.md', line: 2, excerpt: 'See `pkg/maths.py:3`.' }] },
  )
  const edges: Edge[] = [
    { id: 'e1', kind: 'imports', from: 'file:pkg/util.py', to: 'file:pkg/maths.py', basis: 'syntax', refs: [{ path: 'pkg/util.py', line: 1, excerpt: 'from pkg.maths import add' }] },
    { id: 'e2', kind: 'defines', from: 'file:pkg/maths.py', to: 'def:pkg/maths.py::add', basis: 'syntax', refs: [{ path: 'pkg/maths.py', line: 3, excerpt: 'def add(a, b):' }] },
    { id: 'e3', kind: 'calls-expression', from: 'file:pkg/util.py', to: 'def:pkg/maths.py::add', basis: 'syntax', refs: [{ path: 'pkg/util.py', line: 6, excerpt: 'return add(x, 1)' }] },
    { id: 'e4', kind: 'test-doc-link', from: 'test:tests/test_core.py::test_add', to: 'def:pkg/maths.py::add', basis: 'heuristic', refs: [{ path: 'tests/test_core.py', line: 6, excerpt: 'assert add(1, 2) == 3' }] },
    { id: 'e5', kind: 'test-doc-link', from: 'doc:docs/maths.md', to: 'def:pkg/maths.py::add', basis: 'declared', refs: [{ path: 'docs/maths.md', line: 2, excerpt: 'See `pkg/maths.py:3`.' }] },
  ]
  return {
    ...one,
    sha: SIM_SHA_2,
    snapshot_digest: 'sha256:synthetic-fixture-rev2-not-a-real-digest',
    generated_at: '2026-10-11T19:30:00Z',
    receipt: { digest: 'sha256:synthetic-rev2', artifact_ref: 'fixture://repo-map/fixture-mini@0000002' },
    state: 'ready',
    reason: 'all 5 Python files parsed (invented revision)',
    coverage: { kinds: ['file', 'module', 'def', 'import', 'test', 'doc'], languages: ['python'], unresolved: [] },
    nodes,
    edges,
  }
}

const err = (status: number, code: string, message: string): ApiError => new ApiError(status, code, message)
const pathOf = (n: Node): string => n.refs[0]?.path ?? (n.kind === 'file' ? n.label : '')
const tally = (xs: string[]) => {
  const out: Record<string, number> = {}
  for (const x of xs) out[x] = (out[x] ?? 0) + 1
  return out
}
const lite = (n: Node) => ({ id: n.id, kind: n.kind, label: n.label, source_digest: n.source_digest })

/**
 * Drift exactly as the host computes it (Platform e4008ac hive/core/repomap.py drift_entries): identity is the logical
 * id; a node is moved only when one removed and one added node of the same kind carry a source_digest unique to each
 * of them within that kind in both revisions; identical content in two places stays added + removed.
 */
export function driftEntries(before: Node[], after: Node[]): Json[] {
  const b = new Map(before.map((n) => [n.id, n]))
  const a = new Map(after.map((n) => [n.id, n]))
  const added = after.filter((n) => !b.has(n.id))
  const removed = before.filter((n) => !a.has(n.id))
  const changed: Json[] = []
  for (const [id, old] of b) {
    const nu = a.get(id)
    if (!nu) continue
    const what = (['kind', 'label', 'source_digest'] as const).filter((f) => old[f] !== nu[f])
    if (what.length) changed.push({ change: 'changed', id, from: lite(old), to: lite(nu), basis: `${what.join(' and ')} changed` })
  }
  const unique = (nodes: Node[], n: Node) => nodes.filter((x) => x.kind === n.kind && x.source_digest === n.source_digest).length === 1
  const moved: Json[] = []
  const gone = new Set<string>()
  const came = new Set<string>()
  for (const old of removed) {
    if (!old.source_digest || !unique(before, old)) continue
    const m = added.filter((n) => n.kind === old.kind && n.source_digest === old.source_digest)
    if (m.length === 1 && unique(after, m[0])) {
      moved.push({ change: 'moved', from: lite(old), to: lite(m[0]), basis: 'unique source_digest match' })
      gone.add(old.id)
      came.add(m[0].id)
    }
  }
  return [
    ...added.filter((n) => !came.has(n.id)).map((n) => ({ change: 'added', node: lite(n), basis: 'id absent in from' })),
    ...removed.filter((n) => !gone.has(n.id)).map((n) => ({ change: 'removed', node: lite(n), basis: 'id absent in to' })),
    ...changed,
    ...moved,
  ]
}

const NODE_PARAMS = {
  type: 'object',
  properties: { node_id: { type: 'string', maxLength: 512 }, path: { type: 'string', maxLength: 512 } },
  additionalProperties: false,
  required: [],
  oneOf: [{ required: ['node_id'] }, { required: ['path'] }],
}
/** The preset list in the host's shape (e4008ac; potential-dependents as host r1.1: transitive, optional max_depth). */
export const PRESET_LIST: Json[] = [
  { preset: 'imports', description: 'what the chosen nodes import (outgoing imports edges)', params: NODE_PARAMS, basis_note: 'syntactic import statements only; an import is not a resolved runtime dependency' },
  {
    preset: 'potential-dependents',
    description: 'what imports or calls the chosen nodes, directly or through others (incoming imports and calls-expression edges, cycle-safe)',
    params: { ...NODE_PARAMS, properties: { ...NODE_PARAMS.properties, max_depth: { type: 'integer', minimum: 1, maximum: 16 } } },
    basis_note: 'static links, not runtime impact',
  },
  { preset: 'defines', description: 'what the chosen nodes define (outgoing defines edges)', params: NODE_PARAMS, basis_note: 'syntactic definitions only' },
  { preset: 'calls-expression', description: 'call expressions written in the chosen nodes (outgoing calls-expression edges)', params: NODE_PARAMS, basis_note: 'call expressions by name; not resolved calls' },
  {
    preset: 'source-search',
    description: 'nodes whose id, label, paths or excerpts contain q (case-insensitive)',
    params: { type: 'object', properties: { q: { type: 'string', maxLength: 512 }, kind: { type: 'string', maxLength: 512 }, path_prefix: { type: 'string', maxLength: 512 } }, additionalProperties: false, required: ['q'] },
    basis_note: 'lexical match on ids, labels, paths and excerpts only',
  },
  { preset: 'test-doc-links', description: 'test and doc links to or from the chosen nodes, each with its basis', params: NODE_PARAMS, basis_note: 'declared and static links only; not runtime coverage' },
  { preset: 'drift', description: "nodes added, removed, changed or moved between revision 'from' and this one", params: { type: 'object', properties: { from: { type: 'string', maxLength: 512 } }, additionalProperties: false, required: ['from'] }, basis_note: "node identity is the map's logical id; moved only with unique source_digest evidence" },
]

export class SimRepoMaps {
  private readonly variant: SimRepoMapVariant
  private readonly now: () => number
  private readonly maps: SimMap[]
  private expiredOnce = false
  // ?repomap=mounting: header-route reads per revision (the list route does not start or advance a mount)
  private headerReads = new Map<string, number>()

  constructor(opts: { variant?: SimRepoMapVariant; now?: () => number; real?: unknown } = {}) {
    this.variant = opts.variant ?? 'default'
    this.now = opts.now ?? (() => Date.now())
    if (this.variant === 'real') {
      const env = opts.real as SimMap['env'] | undefined
      this.maps = env && typeof env === 'object' && Array.isArray(env.nodes) && Array.isArray(env.edges) ? [{ env, visibility: 'hive' }] : []
      return
    }
    const one = JSON.parse(JSON.stringify(fixture)) as SimMap['env']
    const v = this.variant
    if (v === 'ready' || v === 'stale' || v === 'unavailable' || v === 'failed') Object.assign(one, { state: v, reason: STATE_REASON[v] })
    if (v === 'ready') Object.assign(one, { coverage: { ...(one.coverage as Json), unresolved: [] } })
    if (v === 'unavailable' || v === 'failed') Object.assign(one, { nodes: [], edges: [] })
    if (v === 'newer') Object.assign(one, { schema: 'repo-map/2' })
    if (v === 'extractor') Object.assign(one, { extractor: { id: 'omegacode.repository_facts', version: '9.9.9', parser: 'python-ast-3.12' } })
    const visibility = v === 'denied' ? 'swarm:s_sim_private_maps' : 'hive'
    this.maps = [{ env: one, visibility }, { env: revisionTwo(JSON.parse(JSON.stringify(fixture)) as SimMap['env']), visibility }]
  }

  /** One request, as the signed-in principal. Throws ApiError with the contract's envelope codes. */
  handle(method: 'GET' | 'POST', path: string, body: unknown, principal: string): unknown {
    if (this.variant === 'absent') throw err(404, 'http_404', 'Not Found')
    const url = new URL(path, 'http://sim.invalid')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts[0] !== 'api' || parts[1] !== 'repo-maps') throw err(404, 'http_404', 'Not Found')
    const q = url.searchParams
    const [, , repo, second, third, fourth] = parts
    const visible = (m: SimMap) => m.visibility === 'hive' || (m.visibility.startsWith('swarm:') && this.memberOf(principal, m.visibility.slice(6)))
    const find = (r: string, sha: string) => {
      const m = this.maps.find((x) => x.env.repo === r && x.env.sha === sha)
      // a map the caller cannot see answers exactly like an unknown one
      if (!m || !visible(m)) throw err(404, 'not_found', 'No such repository map.')
      if (m.env.schema !== 'repo-map/1') throw err(422, 'schema_unsupported', 'Unknown envelope version.')
      return m
    }
    if (method === 'GET' && parts.length === 2) return this.maps.filter(visible).map((m) => ({ ...this.headerOf(m), coverage: undefined }))
    if (!repo) throw err(400, 'bad_request', 'A repository is required.')
    if (method === 'GET' && second === 'presets' && parts.length === 4) {
      if (!this.maps.some((m) => m.env.repo === repo && visible(m))) throw err(404, 'not_found', 'No such repository map.')
      return { repo, presets: PRESET_LIST, limit: { default: 50, max: 200 } }
    }
    if (method === 'GET' && second === 'drift' && parts.length === 4) return this.drift(repo, q, principal, find)
    if (!second) throw err(400, 'bad_request', 'A revision is required.')
    const m = this.maps.find((x) => x.env.repo === repo && x.env.sha === second)
    if (method === 'GET' && parts.length === 4) {
      // the header of a newer-schema map is still served (the page refuses it by its pin)
      if (m && visible(m) && m.env.schema !== 'repo-map/1') return this.headerOf(m)
      return this.headerOf(find(repo, second), true)
    }
    const map = find(repo, second)
    const rev = this.revisionOf(map)
    const limit = this.limit(q.get('limit') ?? (body as Json | null)?.limit)
    if (method === 'GET' && third === 'nodes' && parts.length === 5) {
      const kind = q.get('kind') || ''
      const prefix = q.get('path_prefix') || ''
      const text = (q.get('q') || '').toLowerCase()
      const all = map.env.nodes.filter((n) => (!kind || n.kind === kind) && (!prefix || pathOf(n).startsWith(prefix)) && (!text || n.label.toLowerCase().includes(text) || n.id.toLowerCase().includes(text)))
      const bind = { p: principal, repo, sha: second, preset: 'nodes', params: { kind, prefix, text } }
      const { items, truncated, next_cursor } = this.page(all, limit, q.get('cursor'), bind)
      // the operation itself completed (ready); the revision's own state travels beside it
      return { repo, sha: second, nodes: items, truncated, next_cursor, state: 'ready', reason: null, ...rev }
    }
    if (method === 'GET' && third === 'nodes' && fourth !== undefined && parts.length === 6) {
      const node = map.env.nodes.find((n) => n.id === fourth)
      if (!node) throw err(404, 'not_found', 'No such node.')
      const edges = map.env.edges.filter((e) => e.from === node.id || e.to === node.id)
      const bind = { p: principal, repo, sha: second, preset: 'node', params: { id: node.id } }
      const { items, truncated, next_cursor } = this.page(edges, limit, q.get('cursor'), bind)
      const ids = new Set(items.flatMap((e) => [e.from, e.to]).filter((id) => id !== node.id))
      return { repo, sha: second, node, truncated, next_cursor, state: 'ready', reason: null, ...rev, nodes: map.env.nodes.filter((n) => ids.has(n.id)), edges: items }
    }
    if (method === 'POST' && third === 'query' && parts.length === 5) return this.query(map, body, principal)
    throw err(400, 'bad_request', 'No such repository map route.')
  }

  private memberOf(_principal: string, _swarm: string): boolean {
    return false
  }

  private revisionOf(m: SimMap): Json {
    return { revision_state: m.env.state, revision_reason: m.env.reason ?? null }
  }

  private headerOf(m: SimMap, headerRoute = false): Json {
    const { nodes, edges, truncated: _t, next_cursor: _n, ...head } = m.env
    const counts = {
      nodes: nodes.length,
      edges: edges.length,
      refs: nodes.reduce((k, n) => k + n.refs.length, 0) + edges.reduce((k, e) => k + e.refs.length, 0),
      unresolved: Array.isArray((m.env.coverage as Json | undefined)?.unresolved) ? ((m.env.coverage as Json).unresolved as unknown[]).length : 0,
      nodes_by_kind: tally(nodes.map((n) => n.kind)),
      edges_by_kind: tally(edges.map((e) => e.kind)),
      edges_by_basis: tally(edges.map((e) => e.basis)),
    }
    // ?repomap=mountheld: the repo space as host r1.2 reports a held mount (Code's 2b423a9 capture): contents unknown
    const id = `repo:${m.env.repo}@${m.env.sha}`
    const total = m.env.nodes.length + m.env.edges.length
    const reads = this.variant === 'mounting' && headerRoute ? (this.headerReads.get(m.env.sha) ?? 0) : 0
    if (this.variant === 'mounting' && headerRoute) this.headerReads.set(m.env.sha, reads + 1)
    const space =
      this.variant === 'mountheld' ? { id, kind: 'read-only', status: 'incomplete', atoms: null, reason: 'mount failed and the space was not cleared; contents unknown' }
      : this.variant === 'mounting' ? (reads < 2 ? { id, kind: 'read-only', status: 'mounting', atoms: 0, added: Math.floor((total * reads) / 2), total } : { id, kind: 'read-only', status: 'mounted', atoms: total })
      : undefined
    return { ...head, counts, visibility: m.visibility, pinned: false, ...this.revisionOf(m), ...(space ? { space } : {}) }
  }

  private limit(v: unknown): number {
    if (this.variant === 'tight' || this.variant === 'expired') return 2
    const n = v === undefined || v === null || v === '' ? 50 : Number(v)
    if (!Number.isInteger(n) || n < 1 || n > 200) throw err(400, 'bad_request', 'limit must be 1 to 200.')
    return n
  }

  /** Opaque cursors bound to principal + repo + sha + preset + params; 1 hour; checked before anything is read. */
  private page<T>(all: T[], limit: number, cursor: string | null, bind: Json): { items: T[]; truncated: boolean; next_cursor: string | null } {
    let off = 0
    if (cursor) {
      let c: Json
      try {
        c = JSON.parse(atob(cursor)) as Json
      } catch {
        throw err(400, 'invalid_cursor', 'This cursor does not match this query.')
      }
      if (JSON.stringify(c.b) !== JSON.stringify(bind)) throw err(400, 'invalid_cursor', 'This cursor does not match this query.')
      if (typeof c.t !== 'number' || this.now() - c.t > HOUR) throw err(410, 'cursor_expired', 'This cursor is more than an hour old.')
      off = typeof c.o === 'number' ? c.o : 0
    }
    let items = all.slice(off, off + limit)
    // the 256 KiB response cap: fewer items, then truncated + a cursor
    while (items.length > 1 && JSON.stringify(items).length > CAP_BYTES) items = items.slice(0, Math.ceil(items.length / 2))
    const end = off + items.length
    const truncated = end < all.length
    let t = this.now()
    if (this.variant === 'expired' && !this.expiredOnce && truncated) {
      this.expiredOnce = true
      t -= 2 * HOUR
    }
    return { items, truncated, next_cursor: truncated ? btoa(JSON.stringify({ b: bind, o: end, t })) : null }
  }

  private query(map: SimMap, body: unknown, principal: string): Json {
    if (!body || typeof body !== 'object') throw err(400, 'bad_request', 'A JSON body is required.')
    const b = body as { preset?: unknown; params?: unknown; limit?: unknown; cursor?: unknown }
    const preset = PRESET_LIST.find((p) => p.preset === b.preset)
    if (!preset) throw err(400, 'unknown_preset', `No preset named ${String(b.preset)}.`)
    const params = (b.params && typeof b.params === 'object' ? b.params : {}) as Record<string, unknown>
    const schema = preset.params as { properties: Json; required: string[]; oneOf?: { required: string[] }[] }
    for (const k of Object.keys(params)) if (!(k in schema.properties)) throw err(400, 'bad_request', `unknown parameter ${k}`)
    for (const k of schema.required) if (params[k] === undefined || params[k] === '') throw err(400, 'bad_request', `${k} is required`)
    if (schema.oneOf && schema.oneOf.filter((g) => g.required.every((k) => params[k] !== undefined && params[k] !== '')).length !== 1) throw err(400, 'bad_request', 'give exactly one of node_id or path')
    const limit = this.limit(b.limit)
    const env = map.env
    const name = String(preset.preset)
    const chosen = new Set(env.nodes.filter((n) => (params.node_id !== undefined ? n.id === params.node_id : params.path !== undefined ? pathOf(n) === params.path : false)).map((n) => n.id))
    let nodes: (Node & { distance?: number })[]
    let edges: Edge[] = []
    if (name === 'drift') throw err(400, 'bad_request', 'drift is read with GET /api/repo-maps/{repo}/drift.')
    if (name === 'source-search') {
      const text = String(params.q).toLowerCase()
      nodes = env.nodes.filter((n) => (!params.kind || n.kind === params.kind) && (!params.path_prefix || pathOf(n).startsWith(String(params.path_prefix))) && (n.id.toLowerCase().includes(text) || n.label.toLowerCase().includes(text) || n.refs.some((r) => r.path.toLowerCase().includes(text) || r.excerpt.toLowerCase().includes(text))))
    } else if (name === 'potential-dependents') {
      // incoming imports + calls-expression, breadth first, cycle-safe; each result with its distance
      const max = params.max_depth === undefined ? Infinity : Number(params.max_depth)
      const into = new Map<string, Edge[]>()
      for (const e of env.edges) if (e.kind === 'imports' || e.kind === 'calls-expression') into.set(e.to, [...(into.get(e.to) ?? []), e])
      const dist = new Map<string, number>([...chosen].map((id) => [id, 0]))
      let frontier = [...chosen]
      for (let d = 1; frontier.length && d <= max; d++) {
        const next: string[] = []
        for (const id of frontier)
          for (const e of into.get(id) ?? []) {
            edges.push(e)
            if (!dist.has(e.from)) {
              dist.set(e.from, d)
              next.push(e.from)
            }
          }
        frontier = next
      }
      nodes = env.nodes.filter((n) => (dist.get(n.id) ?? 0) > 0).map((n) => ({ ...n, distance: dist.get(n.id)! })).sort((x, y) => x.distance - y.distance)
    } else {
      const dir: Record<string, [string[], 'out' | 'in' | 'both']> = { imports: [['imports'], 'out'], defines: [['defines'], 'out'], 'calls-expression': [['calls-expression'], 'out'], 'test-doc-links': [['test-doc-link'], 'both'] }
      const [ks, way] = dir[name]
      edges = env.edges.filter((e) => ks.includes(e.kind) && ((way !== 'in' && chosen.has(e.from)) || (way !== 'out' && chosen.has(e.to))))
      const other = new Set(edges.map((e) => (chosen.has(e.from) ? e.to : e.from)))
      nodes = env.nodes.filter((n) => other.has(n.id))
    }
    const bind = { p: principal, repo: env.repo, sha: env.sha, preset: name, params }
    const page = this.page(nodes, limit, typeof b.cursor === 'string' ? b.cursor : null, bind)
    const shown = new Set(page.items.map((n) => n.id))
    return { repo: env.repo, sha: env.sha, preset: name, nodes: page.items, edges: edges.filter((e) => shown.has(e.from) || shown.has(e.to)), truncated: page.truncated, next_cursor: page.next_cursor, state: 'ready', reason: null, ...this.revisionOf(map), basis_note: preset.basis_note }
  }

  private drift(repo: string, q: URLSearchParams, principal: string, find: (r: string, sha: string) => SimMap): Json {
    const from = q.get('from') ?? ''
    const to = q.get('to') ?? ''
    if (!from || !to) throw err(400, 'bad_request', 'from and to are required.')
    const a = find(repo, from)
    const z = find(repo, to)
    const limit = this.limit(q.get('limit'))
    const rows = driftEntries(a.env.nodes, z.env.nodes)
    const page = this.page(rows, limit, q.get('cursor'), { p: principal, repo, sha: `${from}..${to}`, preset: 'drift', params: {} })
    const out: Json = { repo, from, to, basis_note: "node identity is the map's logical id; moved only with unique source_digest evidence", truncated: page.truncated, next_cursor: page.next_cursor, state: 'ready', reason: null, ...this.revisionOf(z), added: [], removed: [], changed: [], moved: [] }
    for (const r of page.items) {
      const { change, ...rest } = r
      ;(out[String(change)] as unknown[]).push(rest)
    }
    return out
  }
}
