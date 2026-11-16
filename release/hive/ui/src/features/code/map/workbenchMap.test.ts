import { describe, expect, it } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../../../api/client'
import { EXPIRED_NOTE, STUCK, PRESETS, REPO_MAP_SCHEMA, classify, firstPage, nextPage, pinFailure, readAll, readDrift, readHeader, readNodeDetail, readPresets, readQuery, readRevisions, repoMapApi, routes, type DriftItem, type DriftResult, type MapNode, type Read } from '../../../api/repoMap'
import { PRESET_LIST, SIM_REPO, SIM_SHA_1, SIM_SHA_2, SimRepoMaps, driftEntries, simRepoMapVariant, type SimRepoMapVariant } from '../../../api/sim/repoMap'
import fixture from '../../../api/sim/fixtures/repo-map-1.synthetic.json'
import wire from '../../../api/sim/fixtures/repo-map-host-wire.e4008ac.json'
import wire2b from '../../../api/sim/fixtures/repo-map-host-wire.2b423a9.json'
import wire0d from '../../../api/sim/fixtures/repo-map-host-wire.0d32f8a.json'
import cap6e from '../../../api/sim/fixtures/repo-map-host-space.6e33535.json'
import { RESERVED_CODE_TARGETS, href, parse } from '../../../lib/router'
import { codeView } from '../codeView'
import { DIRECT_ONLY, NO_FIT, RAW_REFUSED, planBody, planFromWords, presetTitle } from './ask'
import { COPY, MAX_MARKS, SPACE_POLL_MAX, spacePollDelay, spaceWords, TESTS_NOTE, ambiguousAt, childGroups, scopeUp, anchorRef, countRows, coverageLines, driftView, edgeLook, emptyWords, hasMoveEvidence, moduleGroups, operationWords, overviewKinds, revisionState, stateView, totalRows, truncatedWords } from './model'
import { DriftCard, FailureCard, ItemList, MapGraph, NodeCard, Overview, PresetComposer, QueryCard, SourceCard, StateBand } from './parts'

/**
 * Workbench Map r1 (repo-map Slice A viewer). Two sources of truth, both SYNTHETIC repositories:
 * - the RAW host responses Code captured from Platform's engine at e4008ac (UI_WIRE_HOST_e4008ac.json, copied
 *   byte-identical), read by the same readers the page uses;
 * - Code's fixture served by the sim host, which answers in those same shapes (plus host r1.1's revision_state,
 *   distance and max_depth), through the contract's routes, ACL, cursors and error codes.
 * Parts are rendered to markup. No live hive, no network, no real repository.
 */

const PERSON = 'user:p_test'
function hostFor(variant: SimRepoMapVariant = 'default', now?: () => number) {
  const host = new SimRepoMaps({ variant, now })
  const client = {
    repoMapRequest: (method: 'GET' | 'POST', path: string, body?: unknown) => {
      try {
        return Promise.resolve(host.handle(method, path, body, PERSON))
      } catch (e) {
        return Promise.reject(e)
      }
    },
  }
  return { host, api: repoMapApi(client), client }
}
const html = (el: ReactElement) => renderToStaticMarkup(el)
const ok = <T,>(r: Read<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.failure)}`)
  return r.value
}
const noop = () => undefined
const presets = readPresets({ presets: PRESET_LIST })

describe('the host wire (Platform e4008ac, raw responses captured by Code)', () => {
  it('header and revisions: scalar totals, and node kinds only from nodes_by_kind', () => {
    const h = readHeader(wire.header)
    expect(h.counts?.totals).toEqual({ edges: 5, nodes: 6, refs: 10, unresolved: 1 })
    expect(h.counts?.nodes_by_kind).toEqual({ def: 1, doc: 1, file: 3, test: 1 })
    expect(h.counts?.edges_by_basis).toEqual({ declared: 1, heuristic: 1, syntax: 3 })
    expect(countRows(h.counts).map((r) => r.kind)).toEqual(['file', 'def', 'test', 'doc'])
    expect(countRows(h.counts).some((r) => r.kind === 'refs' || r.kind === 'edges')).toBe(false)
    expect(totalRows(h.counts)).toContain('refs 10')
    expect(overviewKinds(h)).toEqual(['doc', 'file', 'test'])
    const revs = readRevisions(wire.revisions)
    expect(revs.map((r) => r.sha)).toEqual([SIM_SHA_2, SIM_SHA_1])
    expect(revs.every((r) => r.pin === null)).toBe(true)
  })
  it('presets: `preset` names it; params are JSON Schema; exactly-one-of node_id/path is kept', () => {
    const ps = readPresets(wire.presets)
    expect(ps.map((p) => p.name)).toEqual([...PRESETS])
    const imports = ps.find((p) => p.name === 'imports')!
    expect(imports.params.map((x) => x.name)).toEqual(['node_id', 'path'])
    expect(imports.oneOf).toEqual([['node_id'], ['path']])
    expect(imports.basis_note).toBe('syntactic import statements only; an import is not a resolved runtime dependency')
    const search = ps.find((p) => p.name === 'source-search')!
    expect(search.oneOf).toEqual([])
    expect(search.params.find((x) => x.name === 'q')?.required).toBe(true)
  })
  it('node detail: neighbours are the host’s `nodes` (2, not 0)', () => {
    const d = readNodeDetail(wire.node_detail)
    expect(wire.node_detail.nodes).toHaveLength(2)
    expect(d.neighbours.map((n) => n.id)).toEqual(['file:pkg/core.py', 'def:pkg/core.py::add'])
  })
  it('drift: nested node/from/to records; the move carries its stated basis', () => {
    const d = readDrift(wire.drift, wire.drift.from, wire.drift.to)
    expect(d.added.map((a) => a.node?.id)).toEqual(['doc:extra.md'])
    expect(d.moved[0]).toMatchObject({ basis: 'unique source_digest match', from: { id: 'file:pkg/util.py' }, to: { id: 'file:pkg/newutil.py' } })
    expect(d.basis_note).toBe("node identity is the map's logical id; moved only with unique source_digest evidence")
    const v = driftView(d)
    expect(v.moved).toHaveLength(1)
    expect(v.verdict).toBe('Since 0000000: 1 added, 1 moved (basis: unique source_digest match).')
  })
})

describe('the sim host answers in the host’s shapes', () => {
  it('serves Code’s fixture unchanged through the header and nodes routes', async () => {
    const { api } = hostFor()
    const h = ok(await api.header(SIM_REPO, SIM_SHA_1))
    expect(h.schema).toBe(REPO_MAP_SCHEMA)
    expect([h.state, h.reason]).toEqual([fixture.state, fixture.reason])
    expect(h.extractor).toEqual(fixture.extractor)
    expect(h.counts).toEqual(readHeader(wire.header).counts)
    const page = ok(await api.nodes(SIM_REPO, SIM_SHA_1, { limit: 200 }))
    expect(page.nodes.map((n) => n.id)).toEqual(fixture.nodes.map((n) => n.id))
  })
  it('the sim’s drift is the host’s rule (same bytes unique within kind = moved; new bytes = added + removed)', async () => {
    const { api } = hostFor()
    const d = ok(await api.drift(SIM_REPO, SIM_SHA_1, SIM_SHA_2))
    const v = driftView(d)
    expect(v.moved.map((m) => [m.from?.id, m.to?.id])).toEqual([['def:pkg/core.py::add', 'def:pkg/maths.py::add']])
    expect(v.added.map((m) => m.node?.id).sort()).toEqual(['doc:docs/maths.md', 'file:pkg/maths.py'])
    expect(v.removed.map((m) => m.node?.id)).toEqual(['doc:docs/core.md'])
    // identical content in two places is never a move
    const twin = { id: 'b', kind: 'def', label: 'x', source_digest: 'same', refs: [] }
    const e = driftEntries([{ ...twin, id: 'a' }, { ...twin, id: 'c' }], [twin, { ...twin, id: 'c' }])
    expect(e.filter((x) => x.change === 'moved')).toEqual([])
  })
  it('lists revisions, the presets, and ?repomap= picks a variant', async () => {
    const { api } = hostFor()
    expect(ok(await api.list()).map((r) => r.sha)).toEqual([SIM_SHA_1, SIM_SHA_2])
    expect(ok(await api.presets(SIM_REPO)).map((p) => p.name)).toEqual([...PRESETS])
    expect(simRepoMapVariant('?sim=1&repomap=real')).toBe('real')
    expect(simRepoMapVariant('?repomap=nonsense')).toBe('default')
  })
  it('routes are the contract’s, and the limit is clamped to 1…200 (default 50)', () => {
    expect(routes.header('a/b', 'c')).toBe('/api/repo-maps/a%2Fb/c')
    expect(routes.nodes('r', 's')).toBe('/api/repo-maps/r/s/nodes?limit=50')
    expect(routes.node('r', 's', 'def:x.py::f', { limit: 999 })).toBe('/api/repo-maps/r/s/nodes/def%3Ax.py%3A%3Af?limit=200')
    expect(routes.drift('r', 'a', 'b')).toBe('/api/repo-maps/r/drift?from=a&to=b&limit=50')
  })
})

describe('every state renders verbatim and is never drawn as complete or empty unless ready', () => {
  const cases: [SimRepoMapVariant, string, boolean, boolean][] = [
    ['ready', 'ready', true, true],
    ['default', 'partial', true, false],
    ['stale', 'stale', true, false],
    ['unavailable', 'unavailable', false, false],
    ['failed', 'failed', false, false],
  ]
  for (const [variant, state, drawable, complete] of cases)
    it(`${state}`, async () => {
      const { api } = hostFor(variant)
      const h = ok(await api.header(SIM_REPO, SIM_SHA_1))
      const v = revisionState(h)
      expect(v.state).toBe(state)
      expect([v.drawable, v.complete]).toEqual([drawable, complete])
      const band = html(createElement(StateBand, { v }))
      expect(band).toContain(`data-map-state="${state}"`)
      expect(band).toContain(`<span data-map-state-word="true">${state}</span>`)
      expect(band).toContain(h.reason)
      if (complete) expect(emptyWords(v)).toBe(COPY.empty)
      else expect(emptyWords(v)).not.toBe(COPY.empty)
      const o = html(createElement(Overview, { header: h, v, nodes: drawable ? [] : null, truncated: false, scope: null, onScope: noop }))
      if (!complete) expect(o).not.toContain(COPY.empty)
      if (!drawable) expect(o).not.toContain('Top-level modules')
    })
  it('partial shows the design copy and the unresolved file; failed shows the failure copy', async () => {
    expect(stateView('partial', 'x').note).toBe(COPY.partial)
    expect(stateView('failed', 'x').note).toBe(COPY.failure)
    const { api } = hostFor()
    const h = ok(await api.header(SIM_REPO, SIM_SHA_1))
    const o = html(createElement(Overview, { header: h, v: revisionState(h), nodes: fixture.nodes as MapNode[], truncated: false, scope: null, onScope: noop }))
    expect(o).toContain('pkg/broken.py')
    expect(o).toContain('SyntaxError line 3')
    expect(o).toContain('6 items in this view')
    expect(o).toContain('3 files')
  })
  it('the repo space mount, from the host’s own header (2b423a9: incomplete, atoms null; 0d32f8a: failed, 0)', () => {
    const h = readHeader(wire2b.header)
    expect(h.space).toEqual({ id: 'repo:fixture-mini@0000000000000000000000000000000000000001', kind: 'read-only', status: 'incomplete', atoms: null, reason: 'mount failed and the space was not cleared; contents unknown', added: null, total: null })
    const v = revisionState(h)
    expect(v.state).toBe('partial')
    const band = html(createElement(StateBand, { v, space: h.space }))
    expect(band).toContain('data-map-space="incomplete"')
    expect(band).toContain('<span data-map-space-status="true">incomplete</span>')
    expect(band).toContain('<span data-map-space-contents="true">contents unknown</span>')
    expect(band).toContain('mount failed and the space was not cleared; contents unknown')
    expect(band).not.toMatch(/\b0 atoms\b/)
    const h0 = readHeader(wire0d.header)
    const band0 = html(createElement(StateBand, { v: revisionState(h0), space: h0.space }))
    expect(band0).toContain('<span data-map-space-status="true">failed</span>')
    expect(band0).toContain('<span data-map-space-contents="true">0 atoms</span>')
    // an older host without `space` shows no mount line at all (nothing invented)
    expect(readHeader(wire.header).space).toBeUndefined()
    expect(html(createElement(StateBand, { v }))).not.toContain('Native space')
  })
  it('host 6e33535 (frozen r1.2), real header responses: mounting with progress, then mounted; unmounted before any read', () => {
    const [mounting, mounted] = cap6e.header_sequence_new_revision.map((x) => readHeader(x))
    expect(mounting.space).toMatchObject({ status: 'mounting', atoms: 0, added: 0, total: 23 })
    expect(spaceWords(mounting.space!)).toMatchObject({ contents: '0 of 23 atoms', settled: false, waiting: true })
    const band = html(createElement(StateBand, { v: revisionState(mounting), space: mounting.space }))
    expect(band.replace(/<[^>]+>/g, '')).toContain('Native space: mounting 0 of 23 atoms')
    expect(spaceWords({ ...mounting.space!, added: 12000, total: 74674 }).contents).toBe('12,000 of 74,674 atoms')
    expect(mounted.space).toMatchObject({ status: 'mounted', atoms: 23 })
    expect(spaceWords(mounted.space!)).toMatchObject({ contents: '23 atoms', settled: true, waiting: false })
    const unmounted = { ...cap6e.space_before_any_read_older, reason: null, added: null, total: null }
    expect(unmounted.status).toBe('unmounted')
    expect(spaceWords(unmounted)).toMatchObject({ contents: 'not mounted yet', waiting: true, settled: false })
    expect(spaceWords({ ...unmounted, status: 'queued' }).contents).toBe('waiting to mount')
  })
  it('Platform ruling 1: completeness comes from revision_state only; the native space never marks the map partial or complete', () => {
    const head = (revision_state: string, status: string, atoms: number | null) => readHeader({ ...wire.header, revision_state, revision_reason: 'r', space: { id: 's', kind: 'read-only', status, atoms } })
    for (const status of ['queued', 'mounting', 'failed', 'incomplete', 'unmounted', 'mounted']) {
      const ready = head('ready', status, status === 'incomplete' ? null : 0)
      expect(revisionState(ready)).toMatchObject({ state: 'ready', complete: true, tone: 'ok' })
      const partial = head('partial', status, 0)
      expect(revisionState(partial)).toMatchObject({ state: 'partial', complete: false })
    }
    const h = head('ready', 'incomplete', null)
    const band = html(createElement(StateBand, { v: revisionState(h), space: h.space })).replace(/<[^>]+>/g, '')
    expect(band).toContain('state: ready')
    expect(band).toContain('Native space: incomplete · contents unknown')
  })
  it('Platform ruling 2: the re-read backs off from 3 s to 15 s, at most 25 reads (about 3¾ minutes)', () => {
    const delays = Array.from({ length: SPACE_POLL_MAX }, (_, n) => spacePollDelay(n))
    expect(delays[0]).toBe(3000)
    expect(delays.at(-1)).toBe(15000)
    expect(delays.every((d, i) => i === 0 || d >= delays[i - 1])).toBe(true)
    expect(Math.max(...delays)).toBe(15000)
    const total = delays.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(180_000)
    expect(total).toBeLessThanOrEqual(240_000)
  })
  it('the sim plays a mount through the header route only: mounting with progress, then mounted (?repomap=mounting)', async () => {
    const { api } = hostFor('mounting')
    ok(await api.list())
    ok(await api.list())
    const seen = []
    for (let k = 0; k < 3; k++) seen.push(ok(await api.header(SIM_REPO, SIM_SHA_1)).space)
    expect(seen.map((x) => x?.status)).toEqual(['mounting', 'mounting', 'mounted'])
    expect(seen[1]).toMatchObject({ added: 5, total: 11 })
    expect(ok(await api.header(SIM_REPO, SIM_SHA_2)).space?.status).toBe('mounting')
  })
  it('a cursor that does not advance is an error, never a loop (host r1.2: cursors always advance)', async () => {
    let calls = 0
    const same = async () => (calls++, { ok: true as const, value: { items: [1], truncated: true, next_cursor: 'c1' } })
    expect(await nextPage({ items: [], truncated: true, next: 'c1', note: null }, same)).toEqual({ ok: false, failure: STUCK })
    calls = 0
    const r = await readAll(async (c) => (calls++, { ok: true as const, value: { items: [1], truncated: true, next_cursor: c ?? 'c1' } }), 50)
    expect(r).toEqual({ ok: false, failure: STUCK })
    expect(calls).toBe(2)
  })
  it('unknown REVISION words (not mount state): verbatim with the reason, not ready, never empty or complete', () => {
    for (const word of ['incomplete', 'unknown', 'held']) {
      const v = revisionState({ state: 'ready', reason: '', revision_state: word, revision_reason: 'native mount held: 0 atoms verified' })
      expect([v.state, v.reason, v.drawable, v.complete]).toEqual([word, 'native mount held: 0 atoms verified', false, false])
      expect(emptyWords(v)).not.toBe(COPY.empty)
      const band = html(createElement(StateBand, { v }))
      expect(band).toContain(`<span data-map-state-word="true">${word}</span>`)
      expect(band).toContain('native mount held: 0 atoms verified')
      expect(band).toContain('not one this view knows, so nothing is drawn')
      const o = html(createElement(Overview, { header: readHeader(wire.header), v, nodes: null, truncated: false, scope: null, onScope: noop }))
      expect(o).not.toContain(COPY.empty)
      expect(o).not.toContain('Top-level modules')
    }
  })
  it('an unknown state word is not drawable (fail closed) and stays verbatim', () => {
    const v = stateView('half-baked', 'r')
    expect(v.drawable).toBe(false)
    expect(html(createElement(StateBand, { v }))).toContain('half-baked')
  })
})

describe('revision state vs operation state (Platform ruling, host r1.1)', () => {
  const head = { state: 'ready', reason: '' }
  it('revision_state wins for the badge; the header’s state is the fallback when it is absent', () => {
    expect(revisionState({ ...head, revision_state: 'partial', revision_reason: 'bounded syntax coverage' })).toMatchObject({ state: 'partial', reason: 'bounded syntax coverage', complete: false })
    expect(revisionState({ state: 'partial', reason: 'r' })).toMatchObject({ state: 'partial', reason: 'r' })
    // an answer's own revision_state wins over the header's
    expect(revisionState({ ...head, revision_state: 'ready' }, { revision_state: 'stale', revision_reason: 's' }).state).toBe('stale')
  })
  it('a ready operation never hides a partial source: both are said', async () => {
    const { api } = hostFor()
    const h = ok(await api.header(SIM_REPO, SIM_SHA_1))
    const q = ok(await api.query(SIM_REPO, SIM_SHA_1, { preset: 'imports', params: { path: 'pkg/util.py' } }))
    expect([q.state, q.revision_state]).toEqual(['ready', 'partial'])
    const line = operationWords('Query', q, revisionState(h, q))
    expect(line).toBe('Query complete · map is partial: 1 of 4 Python files failed to parse')
    const card = html(createElement(QueryCard, { preset: 'imports', params: { path: 'pkg/util.py' }, basisNote: q.basis_note, state: q.state, opLine: line, nodes: q.nodes, edges: q.edges, truncated: q.truncated, note: null, onSelect: noop, onClose: noop }))
    expect(card).toContain('Query complete · map is partial: 1 of 4 Python files failed to parse')
    expect(operationWords('Query', { state: 'ready' }, stateView('ready', ''))).toBeNull()
    expect(operationWords('Query', { state: 'partial', reason: 'time_bound' }, stateView('ready', ''))).toBe('Query partial: time_bound · map is ready')
  })
  it('without revision_state on an answer, the header’s revision state still shows (fallback)', () => {
    const h = readHeader(wire.header)
    const q = readQuery({ nodes: [], edges: [], truncated: false, next_cursor: null, state: 'ready', basis_note: 'x' })
    expect(q.revision_state).toBeUndefined()
    expect(operationWords('Query', q, revisionState(h, q))).toBe('Query complete · map is partial: 1 of 4 Python files failed to parse')
  })
})

describe('the adapter pin: an unknown schema draws nothing', () => {
  it('a newer schema is refused before anything is read', async () => {
    const { api } = hostFor('newer')
    expect(await api.header(SIM_REPO, SIM_SHA_1)).toEqual({ ok: false, failure: { kind: 'newer_format', schema: 'repo-map/2' } })
    const nodes = await api.nodes(SIM_REPO, SIM_SHA_1)
    expect(!nodes.ok && nodes.failure.kind).toBe('newer_format')
    expect(html(createElement(FailureCard, { f: { kind: 'newer_format', schema: 'repo-map/2' } }))).toContain('This map uses a newer format')
    expect(ok(await api.list())[0].pin?.kind).toBe('newer_format')
  })
  it('an extractor outside the pin is refused the same way', async () => {
    const { api } = hostFor('extractor')
    const r = await api.header(SIM_REPO, SIM_SHA_1)
    expect(!r.ok && r.failure).toEqual({ kind: 'extractor_unpinned', id: 'omegacode.repository_facts', version: '9.9.9' })
    expect(pinFailure({ schema: undefined })?.kind).toBe('newer_format')
    expect(classify(new ApiError(422, 'schema_unsupported', 'x')).kind).toBe('newer_format')
  })
  it('the real map’s extractor is pinned exactly: omegacode.repository_map version 1, parser not pinned', () => {
    expect(pinFailure({ schema: 'repo-map/1', extractor: { id: 'omegacode.repository_map', version: '1', parser: 'python-ast-module-facts-v1/python-3.12.13' } })).toBeNull()
    expect(pinFailure({ schema: 'repo-map/1', extractor: { id: 'omegacode.repository_map', version: '2' } })?.kind).toBe('extractor_unpinned')
    expect(pinFailure({ schema: 'repo-map/1', extractor: { id: 'omegacode.repository_map', version: 'fixture' } })?.kind).toBe('extractor_unpinned')
    expect(pinFailure({ schema: 'repo-map/1', extractor: { id: 'omegacode.repository_facts', version: '1' } })?.kind).toBe('extractor_unpinned')
  })
})

describe('coverage and declarations at the real map’s shape (synthetic values)', () => {
  it('unresolved entries are counted by issue; every other coverage field is shown as written', () => {
    const h = readHeader({ ...wire.header, coverage: { kinds: ['file', 'doc', 'def'], languages: ['python'], unresolved: [{ path: 'a.py', issue: 'python_file_limit' }, { path: 'b.py', issue: 'python_file_limit' }, { path: 'c.py', issue: 'unresolved_call_bindings' }], test_doc_links: 'not extracted', complete_runtime_impact: false } })
    const c = coverageLines(h)
    expect(c.byIssue).toEqual([{ issue: 'python_file_limit', n: 2 }, { issue: 'unresolved_call_bindings', n: 1 }])
    expect(c.other).toEqual([['test_doc_links', 'not extracted'], ['complete_runtime_impact', 'false']])
    const r2 = readHeader({ ...wire.header, coverage: { kinds: [], languages: [], unresolved: [], edge_basis_notes: { 'calls-expression': 'same-file or imported-module name candidate; scope and runtime binding unresolved' } } })
    expect(r2.coverage?.edge_basis_notes).toEqual({ 'calls-expression': 'same-file or imported-module name candidate; scope and runtime binding unresolved' })
    const card = html(createElement(NodeCard, { node: { id: 'def:x', kind: 'def', label: 'x', source_digest: '', refs: [] }, ambiguous: false, edges: [{ id: 'e', kind: 'calls-expression', from: 'file:a', to: 'def:x', basis: 'heuristic', refs: [] }], neighbours: [], truncated: false, note: null, kindNotes: r2.coverage?.edge_basis_notes, onSelect: noop, onOpenRef: noop, onClose: noop }))
    expect(card).toContain('data-map-kind-note="calls-expression"')
    expect(card).toContain('same-file or imported-module name candidate')
    const o = html(createElement(Overview, { header: h, v: stateView('partial', 'r'), nodes: [], truncated: false, scope: null, onScope: noop }))
    expect(o).toContain('3 unresolved entries')
    expect(o).toContain('not extracted')
  })
  it('a declaration and an edge basis note are shown verbatim', () => {
    const node: MapNode = { id: 'def:h', kind: 'def', label: '__init__', source_digest: '', refs: [], ambiguous: true, declaration: { ambiguous: true, identity_basis: 'path-name-occurrence', occurrence: 1, qualification: 'unknown' } }
    const card = html(createElement(NodeCard, { node, ambiguous: false, edges: [{ id: 'e', kind: 'calls-expression', from: 'file:x', to: 'def:h', basis: 'heuristic', basis_note: 'same-file or imported-module name candidate; scope and runtime binding unresolved', refs: [] }], neighbours: [], truncated: false, note: null, onSelect: noop, onOpenRef: noop, onClose: noop }))
    expect(card).toContain('qualification: unknown')
    expect(card).toContain('ambiguous</span>')
    expect(card).toContain('same-file or imported-module name candidate; scope and runtime binding unresolved')
  })
})

describe('drift: moved only with a stated basis and both ends; verdict first', () => {
  const n = (id: string) => ({ id, kind: 'def', label: id, source_digest: 'd' })
  const base: DriftResult = { from: SIM_SHA_1, to: SIM_SHA_2, basis_note: null, added: [], removed: [], changed: [], moved: [], truncated: false, next_cursor: null }
  const moved = (o: Partial<DriftItem>): DriftItem => ({ id: 'b', basis: '', node: null, from: n('a'), to: n('b'), ...o })
  it('a moved record without a basis is shown as removed + added, never moved', () => {
    const v = driftView({ ...base, moved: [moved({ basis: '' })] })
    expect(v.moved).toEqual([])
    expect(v.removed.map((x) => x.node?.id)).toEqual(['a'])
    expect(v.added.map((x) => x.node?.id)).toEqual(['b'])
    expect(v.demoted).toBe(1)
    expect(html(createElement(DriftCard, { view: v, from: 'a', to: 'b', onOpen: noop, onClose: noop }))).not.toContain('data-drift-list="Moved"')
  })
  it('a bare moved string is not read at all (unreadable, never a move)', () => {
    expect(() => readDrift({ moved: ['file:pkg/util.py'] }, 'a', 'b')).toThrow()
    const r = repoMapApi({ repoMapRequest: async () => ({ moved: ['x'] }) })
    return r.drift('r', 'a', 'b').then((x) => expect(!x.ok && x.failure.kind).toBe('unreadable'))
  })
  it('evidence = both ends, two different nodes, and a basis', () => {
    expect(hasMoveEvidence(moved({ basis: 'unique source_digest match' }))).toBe(true)
    expect(hasMoveEvidence(moved({ basis: '  ' }))).toBe(false)
    expect(hasMoveEvidence(moved({ basis: 'x', from: null }))).toBe(false)
    expect(hasMoveEvidence(moved({ basis: 'x', to: n('a') }))).toBe(false)
  })
  it('the card shows the basis on each move and the comparison’s basis note', async () => {
    const { api } = hostFor()
    const d = ok(await api.drift(SIM_REPO, SIM_SHA_1, SIM_SHA_2))
    const card = html(createElement(DriftCard, { view: driftView(d), from: SIM_SHA_1, to: SIM_SHA_2, basisNote: d.basis_note, onOpen: noop, onClose: noop }))
    expect(card.indexOf('data-drift-verdict')).toBeLessThan(card.indexOf('data-drift-list'))
    expect(card).toContain('basis: unique source_digest match')
    expect(card).toContain('moved only with unique source_digest evidence')
  })
  it('an unknown earlier revision is "Previous revision unavailable", never "no changes"', async () => {
    const { api } = hostFor()
    const r = await api.drift(SIM_REPO, 'feedbeef', SIM_SHA_2)
    expect(!r.ok && r.failure.kind).toBe('not_found')
    expect(COPY.previousUnavailable).toBe('Previous revision unavailable')
    expect(driftView({ ...base, truncated: true }).verdict).not.toContain('No changes between')
  })
})

describe('edges: heuristic is dashed and labelled; ambiguous nodes stay separate', () => {
  it('calls-expression and potential-dependents are heuristic whatever their basis; syntax is solid', () => {
    expect(edgeLook({ kind: 'calls-expression', basis: 'syntax' })).toMatchObject({ heuristic: true, dashed: true, tag: 'heuristic' })
    expect(edgeLook({ kind: 'potential-dependents', basis: 'syntax' }).dashed).toBe(true)
    expect(edgeLook({ kind: 'test-doc-link', basis: 'heuristic' }).dashed).toBe(true)
    expect(edgeLook({ kind: 'imports', basis: 'syntax' })).toMatchObject({ heuristic: false, dashed: false, tag: 'syntax' })
    expect(edgeLook({ kind: 'test-doc-link', basis: 'declared' })).toMatchObject({ dashed: false, tag: 'declared' })
  })
  it('the node card and the focus picture label heuristic edges and show the basis', async () => {
    const { api } = hostFor()
    const d = ok(await api.node(SIM_REPO, SIM_SHA_1, 'def:pkg/core.py::add'))
    expect(d.neighbours.length).toBeGreaterThan(0)
    const card = html(createElement(NodeCard, { node: d.node, ambiguous: false, edges: d.edges, neighbours: d.neighbours, truncated: d.truncated, note: null, onSelect: noop, onOpenRef: noop, onClose: noop }))
    expect(card).toContain('heuristic')
    expect(card).toContain('basis: syntax')
    expect(card).toContain('basis: declared')
    expect(card).toContain(COPY.relatedTests)
    expect(card).toContain(TESTS_NOTE)
    const pic = html(createElement(MapGraph, { nodes: [], scope: null, focus: { node: d.node, edges: d.edges, neighbours: d.neighbours }, selectedId: d.node.id, onScope: noop, onSelect: noop, height: 400 }))
    expect(pic).toContain('data-edge-kind="calls-expression" data-edge-dashed="1"')
    expect(pic).toContain('data-edge-kind="defines" data-edge-dashed="0"')
    expect(pic).toContain('call expression · heuristic')
  })
  it('duplicate ids and flagged nodes are ambiguous and drawn as separate marks', () => {
    const mk = (id: string, extra: Partial<MapNode> = {}): MapNode => ({ id, kind: 'def', label: 'f', source_digest: '', refs: [{ path: 'pkg/a.py', line: 1, excerpt: 'def f():' }], ...extra })
    const nodes = [mk('def:pkg/a.py::f'), mk('def:pkg/a.py::f'), mk('def:pkg/a.py::g', { ambiguous: true }), mk('def:pkg/a.py::h')]
    expect([...ambiguousAt(nodes)]).toEqual([0, 1, 2])
    expect(moduleGroups(nodes)[0].items).toEqual([0, 1, 2, 3])
    const pic = html(createElement(MapGraph, { nodes, scope: 'pkg', focus: null, selectedId: null, onScope: noop, onSelect: noop, height: 400 }))
    expect(pic.match(/, ambiguous\. Open/g)?.length).toBe(3)
  })
})

describe('levels: repository → subsystem → file, at scale', () => {
  const f = (path: string): MapNode => ({ id: `file:${path}`, kind: 'file', label: path, source_digest: '', refs: [] })
  it('a directory shows its subdirectories and its own files; a top-level file stays top level', () => {
    const nodes = [f('hive/core/app.py'), f('hive/core/hive.py'), f('hive/ui/x.ts'), f('hive/run.sh'), f('README.md')]
    expect(childGroups(nodes, null).map((g) => [g.key, g.kind, g.items.length])).toEqual([['hive', 'dir', 4], ['(top level)', 'dir', 1]])
    expect(childGroups(nodes, 'hive').map((g) => [g.key, g.kind, g.items.length])).toEqual([['hive/core', 'dir', 2], ['hive/run.sh', 'file', 1], ['hive/ui', 'dir', 1]])
    expect(childGroups(nodes, '(top level)').map((g) => g.key)).toEqual(['README.md'])
    expect([scopeUp('hive/core'), scopeUp('hive'), scopeUp('(top level)')]).toEqual(['hive', null, null])
  })
  it('past MAX_MARKS the picture counts the rest and points to the list; the list shows every entry', () => {
    const nodes = Array.from({ length: MAX_MARKS + 5 }, (_, i) => f(`big/m${String(i).padStart(2, '0')}.py`))
    const pic = html(createElement(MapGraph, { nodes, scope: 'big', focus: null, selectedId: null, onScope: noop, onSelect: noop, height: 400 }))
    expect(pic.match(/data-map-mark="file"/g)?.length).toBe(MAX_MARKS)
    expect(pic).toContain('data-map-marks-hidden="5"')
    expect(pic).toContain('5 smaller entries are not drawn here: Show as list')
    const list = html(createElement(ItemList, { nodes, scope: 'big', selectedId: null, onScope: noop, onSelect: noop }))
    expect(list.match(/data-map-row="file"/g)?.length).toBe(MAX_MARKS + 5)
  })
})

describe('paging, truncation and the 1-hour cursor', () => {
  const fetcher = (api: ReturnType<typeof hostFor>['api']) => async (cursor: string | null) => {
    const r = await api.nodes(SIM_REPO, SIM_SHA_1, { cursor })
    return r.ok ? { ok: true as const, value: { items: r.value.nodes, truncated: r.value.truncated, next_cursor: r.value.next_cursor } } : r
  }
  it('a tight host truncates; the next page appends; "showing first N; more available"', async () => {
    const { api } = hostFor('tight')
    const p1 = ok(await api.nodes(SIM_REPO, SIM_SHA_1))
    expect([p1.nodes.length, p1.truncated]).toEqual([2, true])
    expect(truncatedWords(p1.nodes.length, p1.truncated)).toBe('showing first 2; more available')
    const two = ok(await nextPage(firstPage({ items: p1.nodes, truncated: p1.truncated, next_cursor: p1.next_cursor }), fetcher(api)))
    expect(two.items.map((n) => n.id)).toEqual(fixture.nodes.slice(0, 4).map((n) => n.id))
    expect(two.note).toBeNull()
  })
  it('readAll reads to the end page by page, and stops truncated at its page bound', async () => {
    const { api } = hostFor('tight')
    const all = ok(await readAll(fetcher(api), 10))
    expect(all.items.map((n) => n.id)).toEqual(fixture.nodes.map((n) => n.id))
    const bounded = ok(await readAll(fetcher(api), 2))
    expect([bounded.items.length, bounded.truncated]).toEqual([4, true])
  })
  it('410 cursor_expired reads again from the start, with a note, replacing (not appending)', async () => {
    const { api } = hostFor('expired')
    const p1 = ok(await api.nodes(SIM_REPO, SIM_SHA_1))
    const raw = await api.nodes(SIM_REPO, SIM_SHA_1, { cursor: p1.next_cursor })
    expect(!raw.ok && raw.failure.kind).toBe('cursor_expired')
    const { api: api2 } = hostFor('expired')
    const q1 = ok(await api2.nodes(SIM_REPO, SIM_SHA_1))
    const again = ok(await nextPage(firstPage({ items: q1.nodes, truncated: true, next_cursor: q1.next_cursor }), fetcher(api2)))
    expect(again.note).toBe(EXPIRED_NOTE)
    expect(again.items.map((n) => n.id)).toEqual(fixture.nodes.slice(0, 2).map((n) => n.id))
  })
  it('a cursor older than an hour is 410 by the clock too; a cursor for another query is invalid and not retried', async () => {
    let t = 1_000_000
    const { api } = hostFor('tight', () => t)
    const p1 = ok(await api.nodes(SIM_REPO, SIM_SHA_1))
    t += 3_600_001
    const late = await api.nodes(SIM_REPO, SIM_SHA_1, { cursor: p1.next_cursor })
    expect(!late.ok && late.failure.kind).toBe('cursor_expired')
    t = 1_000_000
    const other = await api.nodes(SIM_REPO, SIM_SHA_1, { kind: 'file', cursor: p1.next_cursor })
    expect(!other.ok && other.failure.kind).toBe('invalid_cursor')
    let calls = 0
    const r = await nextPage({ items: [], truncated: true, next: 'x', note: null }, async () => (calls++, { ok: false, failure: { kind: 'invalid_cursor' } }))
    expect([r.ok, calls]).toEqual([false, 1])
  })
  it('the node card shows truncation with a More control', () => {
    const node: MapNode = { id: 'n', kind: 'file', label: 'n', source_digest: '', refs: [] }
    const card = html(createElement(NodeCard, { node, ambiguous: false, edges: [{ id: 'e', kind: 'imports', from: 'n', to: 'm', basis: 'syntax', refs: [] }], neighbours: [], truncated: true, note: EXPIRED_NOTE, onSelect: noop, onOpenRef: noop, onMore: noop, onClose: noop }))
    expect(card).toContain('showing first 1; more available')
    expect(card).toContain(EXPIRED_NOTE)
    expect(card).toContain('>More<')
  })
})

describe('access: fail closed', () => {
  it('a map visible only to another swarm answers exactly like an unknown map, everywhere', async () => {
    const { api } = hostFor('denied')
    expect(ok(await api.list())).toEqual([])
    for (const r of [await api.header(SIM_REPO, SIM_SHA_1), await api.nodes(SIM_REPO, SIM_SHA_1), await api.node(SIM_REPO, SIM_SHA_1, 'file:pkg/core.py'), await api.presets(SIM_REPO), await api.query(SIM_REPO, SIM_SHA_1, { preset: 'imports', params: { path: 'x' } }), await api.drift(SIM_REPO, SIM_SHA_1, SIM_SHA_2)])
      expect(!r.ok && r.failure.kind).toBe('not_found')
  })
  it('401/403 are a denial; a bare 404 (no routes) is not served; nothing is drawn for any of them', async () => {
    expect(classify(new ApiError(403, 'forbidden', 'x')).kind).toBe('denied')
    expect(classify(new ApiError(401, 'unauthorized', 'x')).kind).toBe('denied')
    expect(classify(new ApiError(404, 'http_404', 'Not Found')).kind).toBe('not_served')
    const r = await hostFor('absent').api.list()
    expect(!r.ok && r.failure.kind).toBe('not_served')
    const card = html(createElement(FailureCard, { f: { kind: 'denied' } }))
    expect(card).toContain('Nothing from it is shown')
    expect(card).not.toContain('pkg/')
  })
  it('every contract error code has a reading', () => {
    const codes: [number, string, string][] = [
      [400, 'bad_request', 'bad_request'],
      [400, 'unknown_preset', 'unknown_preset'],
      [400, 'invalid_cursor', 'invalid_cursor'],
      [404, 'not_found', 'not_found'],
      [409, 'map_exists', 'map_exists'],
      [410, 'cursor_expired', 'cursor_expired'],
      [413, 'too_large', 'too_large'],
      [413, 'http_413', 'too_large'],
      [400, 'response_too_large', 'too_large'],
      [422, 'schema_unsupported', 'newer_format'],
      [0, 'network', 'unavailable'],
    ]
    for (const [status, code, kind] of codes) expect(classify(new ApiError(status, code, 'm')).kind).toBe(kind)
  })
  it('a client without the routes is not served; an answer that does not fit is unreadable', async () => {
    const r = await repoMapApi({}).header('r', 's')
    expect(!r.ok && r.failure.kind).toBe('not_served')
    const bad = await repoMapApi({ repoMapRequest: async () => ({ nodes: [{ id: 1 }], truncated: false, next_cursor: null }) }).nodes('r', 's')
    expect(!bad.ok && bad.failure.kind).toBe('unreadable')
  })
})

describe('the Ask: plain words → a visible, editable preset (host presets)', () => {
  const resolve = (name: string) => (name === 'add' ? { id: 'def:pkg/core.py::add' } : name === 'f' ? { many: 2 } : null)
  const cases: [string, string, Record<string, string>][] = [
    ['which tests cover add?', 'test-doc-links', { node_id: 'def:pkg/core.py::add' }],
    ['what calls add', 'potential-dependents', { node_id: 'def:pkg/core.py::add' }],
    ['what directly depends on pkg/core.py', 'potential-dependents', { path: 'pkg/core.py', max_depth: '1' }],
    ['what does pkg/util.py call', 'calls-expression', { path: 'pkg/util.py' }],
    ['what does pkg/util.py import', 'imports', { path: 'pkg/util.py' }],
    ['what does file:pkg/core.py define', 'defines', { node_id: 'file:pkg/core.py' }],
    ['find SyntaxError', 'source-search', { q: 'SyntaxError' }],
    ['what changed since 0000000000000000000000000000000000000001', 'drift', { from: '0000000000000000000000000000000000000001' }],
  ]
  for (const [words, preset, params] of cases)
    it(`"${words}" → ${preset}`, () => {
      const r = planFromWords(words, presets, resolve)
      expect(r.ok && r.plan.preset).toBe(preset)
      expect(r.ok && r.plan.params).toEqual(params)
    })
  it('a name that is not one node is left visible with a note, never guessed', () => {
    const r = planFromWords('what calls f', presets, resolve)
    expect(r.ok && r.plan.params).toEqual({ node_id: 'f' })
    expect(r.ok && r.plan.note).toContain('2 nodes are named f')
  })
  it('"which tests cover X" says declared and static links only, not runtime coverage', async () => {
    const r = planFromWords('which tests cover add', presets, resolve)
    expect(r.ok && r.plan.note).toBe('declared and static links only, not runtime coverage')
    const { api } = hostFor()
    const q = ok(await api.query(SIM_REPO, SIM_SHA_1, { preset: 'test-doc-links', params: { node_id: 'def:pkg/core.py::add' } }))
    expect(q.basis_note).toBe('declared and static links only; not runtime coverage')
    const card = html(createElement(QueryCard, { preset: 'test-doc-links', params: { node_id: 'def:pkg/core.py::add' }, basisNote: q.basis_note, nodes: q.nodes, edges: q.edges, truncated: q.truncated, note: null, onSelect: noop, onClose: noop }))
    expect(card).toContain(TESTS_NOTE)
    expect(card).toContain('basis: declared and static links only; not runtime coverage')
  })
  it('the composer shows the preset, its exactly-one-of choice and parameters, editable, before anything runs', () => {
    const r = planFromWords('what does pkg/util.py import', presets, resolve)
    const out = html(createElement(PresetComposer, { words: 'what does pkg/util.py import', onWords: noop, plan: r.ok ? r.plan : null, why: null, presets, onPlan: noop, onRun: noop, busy: false, runWhy: null }))
    for (const p of PRESETS) expect(out).toContain(`<option value="${p}"`)
    expect(out).toMatch(/<option value="imports" selected=""/)
    expect(out).toContain('data-map-oneof="node_id|path"')
    expect(out).toMatch(/data-map-oneof-pick="path" aria-pressed="true"|aria-pressed="true"[^>]*data-map-oneof-pick="path"/)
    expect(out).toMatch(/data-map-param="path"[^>]*value="pkg\/util.py"/)
    expect(out).not.toContain('data-map-param="node_id"')
    expect(out).toContain('basis: syntactic import statements only')
    expect(out).toContain('data-map-run')
    expect(out).toContain('raw MeTTa queries are not offered')
  })
  it('the body keeps exactly one of node_id / path', () => {
    expect(planBody({ preset: 'imports', params: { path: ' pkg/util.py ' }, note: null }, presets)).toEqual({ ok: true, preset: 'imports', params: { path: 'pkg/util.py' } })
    expect(planBody({ preset: 'imports', params: { path: 'a', node_id: 'b' }, note: null }, presets)).toEqual({ ok: false, why: 'Give exactly one of node_id or path.' })
    expect(planBody({ preset: 'imports', params: {}, note: null }, presets).ok).toBe(false)
    expect(planBody({ preset: 'source-search', params: { q: '' }, note: null }, presets)).toEqual({ ok: false, why: 'Fill in q first.' })
  })
  it('raw MeTTa is refused; words that fit nothing plan nothing; a preset the hive lacks is not planned', () => {
    expect(planFromWords('(match &self (repo-node $x def $l $d) $x)', presets)).toEqual({ ok: false, why: RAW_REFUSED })
    expect(planFromWords('make it faster', presets)).toEqual({ ok: false, why: NO_FIT })
    expect(planFromWords('what does pkg/a.py import', presets.filter((p) => p.name !== 'imports')).ok).toBe(false)
  })
  it('an unknown preset is the host’s 400 unknown_preset', async () => {
    const r = await hostFor().api.query(SIM_REPO, SIM_SHA_1, { preset: 'raw-metta', params: {} })
    expect(!r.ok && r.failure.kind).toBe('unknown_preset')
  })
})

describe('potential-dependents: static, transitive, with distance; max_depth 1 = direct links only', () => {
  it('each result carries its distance; max_depth 1 keeps only direct links', async () => {
    const { api } = hostFor()
    const all = ok(await api.query(SIM_REPO, SIM_SHA_2, { preset: 'potential-dependents', params: { node_id: 'def:pkg/maths.py::add' } }))
    expect(all.nodes.map((n) => [n.id, n.distance])).toEqual([['file:pkg/util.py', 1]])
    const viaFile = ok(await api.query(SIM_REPO, SIM_SHA_2, { preset: 'potential-dependents', params: { path: 'pkg/maths.py' } }))
    expect(viaFile.nodes.every((n) => typeof n.distance === 'number')).toBe(true)
    const direct = ok(await api.query(SIM_REPO, SIM_SHA_2, { preset: 'potential-dependents', params: { node_id: 'def:pkg/maths.py::add', max_depth: 1 } }))
    expect(direct.nodes.every((n) => n.distance === 1)).toBe(true)
    expect(all.basis_note).toBe('static links, not runtime impact')
  })
  it('renders "potential dependents (static, transitive)", each distance, the basis note; the composer offers direct links only', () => {
    const nodes: MapNode[] = [
      { id: 'file:a.py', kind: 'file', label: 'a.py', source_digest: '', refs: [], distance: 1 },
      { id: 'file:b.py', kind: 'file', label: 'b.py', source_digest: '', refs: [], distance: 3 },
    ]
    const card = html(createElement(QueryCard, { preset: 'potential-dependents', params: { node_id: 'x' }, basisNote: 'static links, not runtime impact', nodes, edges: [{ id: 'e', kind: 'calls-expression', from: 'file:a.py', to: 'x', basis: 'heuristic', basis_note: 'name candidate', refs: [] }], truncated: false, note: null, onSelect: noop, onClose: noop }))
    // Kimi K4: a heuristic edge keeps its basis verbatim beside the tag
    expect(card).toContain('heuristic</span>')
    expect(card).toContain('basis: heuristic — name candidate')
    expect(card).toContain('potential dependents (static, transitive)')
    expect(card).toContain('distance 1 (direct)')
    expect(card).toContain('distance 3')
    expect(card).toContain('basis: static links, not runtime impact')
    expect(card).not.toContain('Impact')
    expect(presetTitle('potential-dependents')).toBe('potential dependents (static, transitive)')
    const comp = html(createElement(PresetComposer, { words: '', onWords: noop, plan: { preset: 'potential-dependents', params: { node_id: 'x', max_depth: '1' }, note: null }, why: null, presets, onPlan: noop, onRun: noop, busy: false, runWhy: null }))
    expect(comp).toContain(DIRECT_ONLY)
    expect(comp).toMatch(/type="checkbox" data-map-direct="true" checked=""/)
    expect(comp).toMatch(/data-map-param="max_depth"[^>]*value="1"/)
    expect(planBody({ preset: 'potential-dependents', params: { node_id: 'x', max_depth: '1' }, note: null }, presets)).toEqual({ ok: true, preset: 'potential-dependents', params: { node_id: 'x', max_depth: 1 } })
    expect(planBody({ preset: 'potential-dependents', params: { node_id: 'x', max_depth: '0' }, note: null }, presets).ok).toBe(false)
  })
})

describe('refs open at their excerpt; a stale anchor warns', () => {
  const ref = { path: 'tests/test_core.py', line: 3, excerpt: 'def test_add():' }
  it('the same excerpt two lines lower: "this line has moved since <sha>"', async () => {
    const { api } = hostFor()
    const d = ok(await api.node(SIM_REPO, SIM_SHA_2, 'test:tests/test_core.py::test_add'))
    const a = anchorRef(ref, SIM_SHA_1, SIM_SHA_2, d.node.refs)
    expect(a).toMatchObject({ state: 'moved', warning: 'this line has moved since 0000000', ref: { line: 5 } })
    const card = html(createElement(SourceCard, { anchor: a, sha: SIM_SHA_2, onClose: noop }))
    expect(card).toContain('this line has moved since 0000000')
    expect(card).toContain('def test_add():')
  })
  it('no matching excerpt: the source is unavailable and no other text opens', () => {
    const a = anchorRef(ref, SIM_SHA_1, SIM_SHA_2, [{ path: 'tests/test_core.py', line: 3, excerpt: 'def test_other():' }])
    expect(a).toMatchObject({ state: 'unavailable', words: COPY.sourceUnavailable })
    expect(html(createElement(SourceCard, { anchor: a, sha: SIM_SHA_1, onClose: noop }))).not.toContain('test_other')
  })
  it('at its own revision a ref opens exactly where it says', () => {
    expect(anchorRef(ref, SIM_SHA_1, SIM_SHA_1, [])).toEqual({ state: 'exact', ref })
  })
})

describe('route: #/code/map/<repo>@<sha>', () => {
  it('parses and prints, keeping a slash in the repo', () => {
    expect(parse(`#/code/map/${SIM_REPO}@${SIM_SHA_1}`)).toEqual({ name: 'code', map: `${SIM_REPO}@${SIM_SHA_1}` })
    expect(codeView({ name: 'code', map: `${SIM_REPO}@${SIM_SHA_1}` })).toEqual({ kind: 'map', repo: SIM_REPO, sha: SIM_SHA_1 })
    expect(href({ name: 'code', map: 'PhysixSNET/omegahive@c8a9aed' })).toBe('#/code/map/PhysixSNET%2Fomegahive@c8a9aed')
    expect(codeView(parse('#/code/map/PhysixSNET%2Fomegahive@c8a9aed') as never)).toEqual({ kind: 'map', repo: 'PhysixSNET/omegahive', sha: 'c8a9aed' })
    expect(parse('#/code/map')).toEqual({ name: 'code', map: '' })
    expect(href({ name: 'code', map: '' })).toBe('#/code/map')
    expect(codeView({ name: 'code', target: 'repo:x' })).toEqual({ kind: 'target', target: 'repo:x' })
  })
  it('"map" is reserved under #/code (Kimi K5): host target ids never take it, and every real id round-trips', () => {
    // hive/core/code.py _targets: "platform", "program:<id>", "mind:<id>", "repo:<id>"; none can be the bare word "map"
    for (const id of ['platform', 'program:map', 'mind:map', 'repo:map']) expect(codeView(parse(href({ name: 'code', target: id })) as never)).toEqual({ kind: 'target', target: id })
    expect(RESERVED_CODE_TARGETS).toEqual(['map'])
    expect(codeView(parse(href({ name: 'code', target: 'map' })) as never).kind).toBe('map')
  })
})
