import contractSrc from './contract.ts?raw'
import loadSrc from './load.ts?raw'
import viewerSrc from './ModuleViewer.tsx?raw'
import modulesSrc from './ReasoningModules.tsx?raw'
import pageViewSrc from './pageView.ts?raw'
import wordsSrc from './words.ts?raw'
import rootV2FixturesRaw from './fixtures/root-read-v2-invented-fixtures.json?raw'
import rootV3FixturesRaw from './fixtures/root-read-v3-flat-invented-fixtures.json?raw'
import v3CasesRaw from './fixtures/v3-reference-cases.json?raw'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The six reasoning-module viewers on Root's FLAT TYPED CARRIER (v3 proposal, 20261008-153446Z). Root's invented v3
 * fixtures (exact bytes), cases derived from them with Root's own reference verdicts (read_result_flat.py, run
 * read-only), synthetic SimClients and INVENTED envelopes only; nothing here is evidence of real state, and no hive is
 * called.
 */
const mem = new Map<string, string>()
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) }
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

const { parseReasoningRead, MODULES, presentFields } = await import('./contract')
const { loadReasoningModules, stateOf, tourStateOf, refusalOf, readerDeclared, allAt, startBatch, endBatch, batchWrites } = await import('./load')
const { ModuleViewer } = await import('./ModuleViewer')
const { UNAVAILABLE_TEXT, EMPTY_TEXT, plainCode, plainWords } = await import('./words')
const { inventedReasoningRequested } = await import('../../../api/client')
const { reasoningPageView } = await import('./pageView')
const { ApiError } = await import('../../../api/client')
const { SimClient } = await import('../../../api/sim/SimClient')
const { bindEpoch, STALE } = await import('../../../lib/identityEpoch')
const { releasePersons, signInAs, switchPerson, testPerson } = await import('../../../lib/identityEpoch.testkit')
const { fitView } = await import('../../ask/view')
const { BANKED_QUALIFICATION } = await import('../../guided/banked')
type ModuleId = import('./contract').ModuleId
type ViewState = import('./load').ViewState
type Doc = Record<string, unknown>

afterEach(() => releasePersons())

const sha256 = async (t: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('')
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Root's six invented flat bodies, exactly as delivered (state synthetic, mind `invented-mind`). */
const V3 = JSON.parse(rootV3FixturesRaw) as { snapshots: Doc[] }
const MIND = 'invented-mind'
const FIXTURE = Object.fromEntries(V3.snapshots.map((s) => [s.module as ModuleId, s])) as Record<ModuleId, Doc>
const HOST_PROVENANCE = { source_revision: 'src-1', evidence_refs: [], read_path: 'host-consent-filtered-snapshot', authority: 'none' }
/** Each fixture as a CURRENT read (the harness's `cur()`): state current, host path, a source revision. */
const cur = (m: ModuleId, patch: Doc = {}): Doc => ({ ...clone(FIXTURE[m]), state: 'current', provenance: HOST_PROVENANCE, ...patch })
const unav = (m: ModuleId, patch: Doc = {}): Doc => ({
  module: m, mind_id: MIND, qualification: FIXTURE[m].qualification, explain: FIXTURE[m].explain,
  revision: null, observed_at: null, available: false, state: 'unavailable', unavailable_reason: 'no_reader', items: [],
  provenance: { source_revision: null, evidence_refs: [], read_path: 'none', authority: 'none' }, ...patch,
})
const parse = (raw: unknown, m: ModuleId = 'attention', mind = MIND) => parseReasoningRead(raw, { mindId: mind, module: m })
const ok = (m: ModuleId, raw: Doc) => {
  const p = parse(raw, m)
  if (!p.ok) throw new Error(p.why)
  return p.envelope
}

/** Richer current reads for drawing (secrets planted where nothing may be drawn). */
const EV = (FIXTURE.temporal.events as Doc[])[0]
const EX = (FIXTURE.temporal.expectations as Doc[])[0]
const RICH: Record<ModuleId, Doc> = {
  attention: cur('attention', { focus_ref: 'SECRET_FOCUS', spread_edges: [{ from: 'sample-a', to: 'SECRET_TO', weight: 0.5, explain: 'A link.' }],
    ranked_items: [{ id: 'SECRET_ID_A', label: 'Invented sample A', score: 0.4, reason_codes: ['task-pin'], explain: 'Made up: pinned.' }, { id: 'SECRET_ID_B', label: 'Invented sample B', score: 0.2, reason_codes: [], explain: 'Made up.' }] }),
  energy: cur('energy', { next_wake_at: '2026-10-08T13:00:00Z' }),
  self: cur('self'),
  scratch: cur('scratch'),
  assume: cur('assume', { model_ref: 'SECRET_MODEL', update_delta: { target_ref: 'SECRET_TARGET', before: 1, after: 2, delta: 1, unit: 'sample', explain: 'An update.' } }),
  temporal: cur('temporal', {
    events: [{ ...EV, id: 'SECRET_EVENT_ID', term: 'SECRET_TERM', truth: { f: 0.9, c: 0.8 }, evidence_refs: ['ev:SECRET_OWNER:7'] }],
    rules: [{ id: 'SECRET_RULE_ID', premise: 'SECRET_PREMISE', conclusion: 'SECRET_CONCLUSION', lag: 5, truth: null, evidence_refs: [], explain: 'A rule.' }],
    expectations: [{ ...EX, rule_ref: 'SECRET_RULE_REF', term: 'SECRET_EXPECT_TERM', late: true }],
    projection: { source_time: 10, target_time: 20, truth_before: null, truth_after: { f: 0.5, c: 0.4 }, model_ref: 'SECRET_PROJ_MODEL', explain: 'A projection.' },
    interval_relations: [{ left_ref: 'SECRET_LEFT', right_ref: 'SECRET_RIGHT', relation: 'overlapped-by', explain: 'A relation.' }],
    explanation_refs: ['ev:SECRET_EXPL:1'],
  }),
}

describe('Root’s v3 flat carrier: fixtures and reference verdicts (read_result_flat.py, run read-only)', () => {
  it('the six invented fixtures are byte-exact (d943ac2b…) and parse in the guided area as the reference does; the current pane refuses them', async () => {
    expect(await sha256(rootV3FixturesRaw)).toBe('d943ac2b9e5303b56a2f886eb0afd90fecb2906ac64c25fd253f37de0ff51ecc')
    expect(V3.snapshots.map((s) => s.module)).toEqual(['attention', 'energy', 'self', 'scratch', 'assume', 'temporal'])
    for (const s of V3.snapshots) {
      const m = s.module as ModuleId
      // guided (tour) area: read, drawn as synthetic
      expect([m, tourStateOf(s, MIND, m).kind]).toEqual([m, 'synthetic'])
      expect([m, parse(s, m)]).toMatchObject([m, { ok: true, envelope: { state: 'synthetic', body: { module: m } } }])
      // current pane: a synthetic answer is never current state
      expect([m, stateOf(s, MIND, m)]).toEqual([m, { kind: 'unavailable', why: 'unreadable' }])
    }
  })

  it('every case agrees with Root’s v3 r2 reference (aafc45d8…) in both areas: verdict, fixed refusal code and meaningful fields; Surface’s stricter checks only ever refuse more', async () => {
    const { source, cases } = JSON.parse(v3CasesRaw) as { source: Record<string, string>; cases: { name: string; mind: string; module: ModuleId; doc: Doc; surface_stricter: boolean; ref_current: string; ref_guided: string; ref_present_fields?: string[] }[] }
    expect(source.reference).toBe('read_result_flat.py aafc45d8 (v3 r2)')
    expect(cases.length).toBe(130)
    // stand-in r5 P3: the byte-limit boundary is compared too (Root's reference yields unreadable-value for it)
    expect(cases.filter((c) => c.name.startsWith('over-byte-limit-')).map((c) => [c.ref_current, c.ref_guided])).toEqual([['refuse:unreadable-value', 'refuse:unreadable-value'], ['refuse:unreadable-value', 'refuse:unreadable-value']])
    const codeMismatch: string[] = []
    const fieldMismatch: string[] = []
    for (const c of cases) {
      if (c.surface_stricter) continue
      const p = parseReasoningRead(c.doc, { mindId: c.mind, module: c.module })
      if (c.ref_guided.startsWith('refuse:')) {
        // a fixed code, the reference's own, never an echo of the input
        if (p.ok || p.why !== c.ref_guided.slice('refuse:'.length)) codeMismatch.push(`${c.name}: ${p.ok ? 'accepted' : p.why} vs ${c.ref_guided}`)
      } else if (p.ok && JSON.stringify(presentFields(p.envelope)) !== JSON.stringify(c.ref_present_fields ?? [])) fieldMismatch.push(`${c.name}: ${presentFields(p.envelope).join(',')} vs ${(c.ref_present_fields ?? []).join(',')}`)
    }
    expect(codeMismatch).toEqual([])
    expect(fieldMismatch).toEqual([])
    const verdict = (s: ViewState) => (s.kind === 'unavailable' && s.why === 'unreadable' ? 'refuse' : 'accept')
    let stricter = 0
    for (const c of cases) {
      const mine = { current: verdict(stateOf(c.doc, c.mind, c.module)), guided: verdict(tourStateOf(c.doc, c.mind, c.module)) }
      const ref = { current: c.ref_current.startsWith('accept') ? 'accept' : 'refuse', guided: c.ref_guided.startsWith('accept') ? 'accept' : 'refuse' }
      if (c.surface_stricter) {
        stricter++
        expect([c.name, ref, mine]).toEqual([c.name, { current: 'accept', guided: 'accept' }, { current: 'refuse', guided: 'refuse' }])
      } else expect([c.name, mine]).toEqual([c.name, ref])
    }
    expect(stricter).toBe(5)
  })

  it('the old v2 aggregate layout (d5ea9152…) is refused, as by the reference', async () => {
    expect(await sha256(rootV2FixturesRaw)).toBe('d5ea91528723539c9020840dee6cee0e6b46ee7ab86bf9f53faa9ff5aa56f885')
    for (const s of (JSON.parse(rootV2FixturesRaw) as { snapshots: Doc[] }).snapshots) {
      const m = s.module as ModuleId
      expect([m, tourStateOf({ ...s, mind_id: MIND }, MIND, m).kind]).toEqual([m, 'unavailable'])
    }
  })
})

describe('the strict parser (v3, plus what r1–r3 kept)', () => {
  it('the caller supplies the expected mind and module; any mismatch, or none given, is refused', () => {
    expect(parse(cur('energy'), 'energy').ok).toBe(true)
    expect(parse(cur('energy'), 'energy', 'other-mind').ok).toBe(false)
    expect(parse(cur('energy'), 'self').ok).toBe(false)
    expect(parse(cur('energy'), 'energy', '').ok).toBe(false)
  })

  it('unavailable carries the common envelope only: no module data, no items, null time and revision, path none', () => {
    for (const m of MODULES) {
      const p = parse(unav(m), m)
      expect([m, p]).toMatchObject([m, { ok: true, envelope: { state: 'unavailable', body: null, observed_at: null, revision: null, unavailable_reason: 'no_reader' } }])
      for (const reason of ['withheld', 'stale']) expect([m, reason, stateOf(unav(m, { unavailable_reason: reason }), MIND, m)]).toEqual([m, reason, { kind: 'unavailable', why: reason }])
    }
    expect(parse(unav('attention', { focus_ref: null })).ok).toBe(false)
    expect(parse(unav('energy', { budget: FIXTURE.energy.budget }), 'energy').ok).toBe(false)
    expect(parse(unav('self', { observed_at: '2026-10-08T00:00:00Z' }), 'self').ok).toBe(false)
    expect(parse(unav('self', { unavailable_reason: null }), 'self').ok).toBe(false)
    expect(parse(unav('self', { provenance: { ...HOST_PROVENANCE } }), 'self').ok).toBe(false)
    expect(parse(unav('self', { available: true }), 'self').ok).toBe(false)
  })

  it('empty current is distinct from unavailable; emptiness counts every meaningful field (never just the item list)', () => {
    const empty = cur('scratch', { items: [], promotion_reasons: [], demotion_reasons: [] })
    expect(stateOf(empty, MIND, 'scratch').kind).toBe('empty')
    expect(stateOf(unav('scratch'), MIND, 'scratch').kind).toBe('unavailable')
    // attention with a focus and links but no ranked items holds something: current, drawn in full
    const att = cur('attention', { ranked_items: [], focus_ref: 'f', spread_edges: [{ from: 'a', to: 'b', weight: 1, explain: 'x' }] })
    expect(stateOf(att, MIND, 'attention').kind).toBe('current')
    expect(render('attention', stateOf(att, MIND, 'attention'))).toContain('Focus: held · 1 spread link')
    expect(stateOf(cur('attention', { ranked_items: [], focus_ref: null, spread_edges: [] }), MIND, 'attention').kind).toBe('empty')
    expect(stateOf(cur('attention', { ranked_items: [], focus_ref: null, spread_edges: [], items: [{ id: 'g', kind: 'note', explain: 'x' }] }), MIND, 'attention').kind).toBe('current')
    // self: reasons alone are held; energy always holds its budget (a required object)
    expect(stateOf(cur('self', { skills: [], selected_skill: null, selection_reason_codes: ['selection-unavailable'] }), MIND, 'self').kind).toBe('current')
    expect(stateOf(cur('self', { skills: [], selected_skill: null, selection_reason_codes: [] }), MIND, 'self').kind).toBe('empty')
    expect(stateOf(cur('energy', { mode: null }), MIND, 'energy').kind).toBe('current')
    expect(stateOf(cur('assume', { model_ref: null, nodes: [], edges: [], prediction: null }), MIND, 'assume').kind).toBe('empty')
    expect(stateOf(cur('temporal', { events: [], expectations: [] }), MIND, 'temporal').kind).toBe('empty')
  })

  it('kept from r3: technical formats (digest now v3’s 64 hex; version semver-like and revision a token, stricter than v3)', () => {
    const skill = (patch: Doc) => cur('self', { skills: [{ ...(FIXTURE.self.skills as Doc[])[0], ...patch }] })
    expect(parse(skill({}), 'self').ok).toBe(true)
    for (const d of ['Goals board', `sha256:${'a'.repeat(64)}`, 'A'.repeat(64), 'a'.repeat(63)]) expect([d, parse(skill({ source_digest: d }), 'self').ok]).toEqual([d, false])
    for (const v of ['0.1', '2', '1.2.3-rc.1']) expect([v, parse(skill({ version: v }), 'self').ok]).toEqual([v, true])
    for (const v of ['Goals board', '1.0-goals', 'v1']) expect([v, parse(skill({ version: v }), 'self').ok]).toEqual([v, false])
    for (const r of ['invented-1', 'r1', 'a1b2c3d', 'src:12']) expect([r, parse(cur('attention', { revision: r })).ok]).toEqual([r, true])
    for (const r of ['Goals board', 'has space', '', 7]) expect([r, parse(cur('attention', { revision: r })).ok]).toEqual([r, false])
    // the revision is never drawn; the digest only shortened
    const html = render('self', { kind: 'current', envelope: ok('self', skill({ source_digest: 'ab'.repeat(32) })) })
    expect(html).toContain(`${'ab'.repeat(6)}…`)
    expect(html).not.toContain(`>${'ab'.repeat(32)}<`)
    expect(render('attention', { kind: 'current', envelope: ok('attention', cur('attention', { revision: 'rev-visible-token' })) })).not.toContain('rev-visible-token')
  })

  it('kept from r3: common times are strict UTC with seconds and round-trip; v3 temporal times are integer seconds, intervals [start,end] nonempty', () => {
    for (const t of ['2026-02-30T12:00:00Z', '2026-04-31T12:00:00Z', '2026-10-08T24:00:00Z', '2026-10-08T12:00:00+02:00', '2026-10-08T12:00Z']) {
      expect([t, stateOf(cur('energy', { observed_at: t }), MIND, 'energy')]).toEqual([t, { kind: 'unavailable', why: 'unreadable' }])
      expect([t, parse(cur('energy', { next_wake_at: t }), 'energy').ok]).toEqual([t, false])
    }
    expect(parse(cur('energy', { observed_at: '2024-02-29T00:00:00+00:00' }), 'energy').ok).toBe(true)
    // v3 overrides r3 here: ISO event times and interval objects are refused; seconds and pairs are read
    expect(parse(cur('temporal', { events: [{ ...EV, occurrence_time: '2026-10-08T00:00:00Z' }] }), 'temporal').ok).toBe(false)
    expect(parse(cur('temporal', { events: [{ ...EV, valid_interval: { start: 10, end: 12 } }] }), 'temporal').ok).toBe(false)
    for (const iv of [[12, 10], [10, 10], [-1, 5], [1.5, 3]]) expect([iv, parse(cur('temporal', { events: [{ ...EV, valid_interval: iv }] }), 'temporal').ok]).toEqual([iv, false])
    expect(stateOf(cur('temporal', { expectations: [{ ...EX, due_interval: [22, 20] }] }), MIND, 'temporal')).toEqual({ kind: 'unavailable', why: 'unreadable' })
  })

  it('kept from r2: fields with a schema are read typed; anything unknown in them is refused', () => {
    expect(parse(cur('assume', { prediction: { unknown_field: 'fabricated' } }), 'assume').ok).toBe(false)
    expect(parse(cur('temporal', { projection: { unknown_field: 'fabricated' } }), 'temporal').ok).toBe(false)
    expect(parse(cur('temporal', { interval_relations: [{ unknown_field: 'fabricated' }] }), 'temporal').ok).toBe(false)
    expect(parse(RICH.temporal, 'temporal').ok).toBe(true)
    expect(parse(RICH.assume, 'assume').ok).toBe(true)
    expect(parse(cur('attention', { executed_now: false })).ok).toBe(false)
  })

  it('aggregate limits: 64 content in all, 128 edges in all, 64 KB', () => {
    const many = (k: number) => Array.from({ length: k }, (_, i) => ({ id: `i${i}`, label: 'L', score: 0.1, reason_codes: [], explain: 'x' }))
    expect(parse(cur('attention', { ranked_items: many(64) })).ok).toBe(true)
    expect(parse(cur('attention', { ranked_items: many(64), items: [{ id: 'g', kind: 'k', explain: 'x' }] })).ok).toBe(false)
    const edges = (k: number) => Array.from({ length: k }, () => ({ from: 'a', to: 'b', weight: 1, explain: 'x' }))
    expect(parse(cur('attention', { spread_edges: edges(128) })).ok).toBe(true)
    expect(parse(cur('attention', { spread_edges: edges(129) })).ok).toBe(false)
    const big = cur('attention', { ranked_items: many(64).map((r) => ({ ...r, explain: 'e'.repeat(1100) })) })
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeGreaterThan(65536)
    expect(parse(big)).toEqual({ ok: false, why: 'unreadable-value' })
  })

  it('diagnostics are fixed codes: no key, value or private marker is ever echoed (v3 r2)', () => {
    const marked = [cur('energy', { PRIVATE_MARKER: 1 }), cur('energy', { observed_at: 'PRIVATE_MARKER' }), cur('energy', { observed_at: '\uff12\uff10\uff12\uff16-10-08T00:00:00Z' }), cur('energy', { budget: { PRIVATE_MARKER: 1 } }), cur('temporal', { events: [{ ...EV, evidence_refs: ['PRIVATE_MARKER'] }] })]
    for (const raw of marked) {
      const p = parse(raw, raw.module as ModuleId)
      expect(p.ok).toBe(false)
      if (!p.ok) {
        expect(p.why).not.toMatch(/PRIVATE|MARKER|\uff12/)
        expect(['unreadable-schema', 'unreadable-value']).toContain(p.why)
      }
    }
  })

  it('r5: exact years 1–99 (Root 161705Z probe e0857ed4: Date.UTC read them as 1900–1999); any fraction digits; year 0 and bad calendar dates refused', () => {
    for (const t of ['0001-01-01T00:00:00Z', '0004-02-29T00:00:00Z', '0099-12-31T23:59:59Z', '0100-01-01T00:00:00Z', '2026-10-08T00:00:00.1234567890Z', '9999-12-31T23:59:59Z'])
      expect([t, parse(cur('energy', { observed_at: t }), 'energy').ok]).toEqual([t, true])
    for (const t of ['0000-01-01T00:00:00Z', '0100-02-29T00:00:00Z', '2026-02-30T00:00:00Z'])
      expect([t, parse(cur('energy', { observed_at: t }), 'energy')]).toEqual([t, { ok: false, why: 'unreadable-value' }])
    expect(parse(cur('energy', { observed_at: '2026-10-08T00:00:00.Z' }), 'energy')).toEqual({ ok: false, why: 'unreadable-schema' })
  })

  it('r5: a string that is not well-formed Unicode (a lone surrogate) is unreadable-json, in labels, explanations, ids and units', () => {
    const ri = (FIXTURE.attention.ranked_items as Doc[])[0]
    const bad: [ModuleId, Doc][] = [
      ['attention', cur('attention', { ranked_items: [{ ...ri, label: 'a\ud800b' }] })],
      ['attention', cur('attention', { ranked_items: [{ ...ri, explain: '\udc00x' }] })],
      ['attention', cur('attention', { ranked_items: [{ ...ri, id: 'id\udbff' }] })],
      ['energy', cur('energy', { budget: { ...(FIXTURE.energy.budget as Doc), unit: '\ud800' } })],
    ]
    for (const [m, raw] of bad) {
      expect(parse(raw, m)).toEqual({ ok: false, why: 'unreadable-json' })
      expect(stateOf(raw, MIND, m)).toEqual({ kind: 'unavailable', why: 'unreadable' })
    }
    // a proper surrogate pair is fine
    expect(parse(cur('attention', { ranked_items: [{ ...ri, label: 'ok \u{1F600} pair' }] })).ok).toBe(true)
  })

  it('r5: an unavailable read may carry a revision (Root’s schema and reference); it is still unavailable and the revision is not drawn', () => {
    const raw = unav('energy', { revision: 'rev-unavail-7' })
    expect(parse(raw, 'energy')).toMatchObject({ ok: true, envelope: { state: 'unavailable', revision: 'rev-unavail-7', body: null } })
    const s = stateOf(raw, MIND, 'energy')
    expect(s).toEqual({ kind: 'unavailable', why: 'no_reader' })
    expect(render('energy', s)).not.toContain('rev-unavail-7')
  })

  it('refusals: the uniform visibility answer is "not visible or withheld"; unknown_read is no reader', () => {
    expect(refusalOf(new ApiError(404, 'not_found', 'not found'))).toEqual({ kind: 'unavailable', why: 'withheld' })
    expect(refusalOf(new ApiError(403, 'program_refused', 'no'))).toEqual({ kind: 'unavailable', why: 'withheld' })
    expect(refusalOf(new ApiError(404, 'unknown_read', 'no'))).toEqual({ kind: 'unavailable', why: 'no_reader' })
    expect(refusalOf(new ApiError(413, 'read_too_large', 'big'))).toEqual({ kind: 'unavailable', why: 'unreadable' })
    expect(refusalOf(new Error('down'))).toEqual({ kind: 'unavailable', why: 'unreadable' })
  })
})

const render = (m: ModuleId, s: ViewState, context?: 'current' | 'tour') => renderToStaticMarkup(createElement(ModuleViewer, { module: m, state: s, context }))
/** Every module's CURRENT envelope as the viewers draw it (RICH where planted). */
const CURRENT: Record<ModuleId, Doc> = RICH

describe('the six viewers render every state', () => {
  it.each(MODULES.map((m) => [m] as const))('%s: current, nothing held, each unavailable, synthetic and banked (tour only)', (m) => {
    const c = render(m, { kind: 'current', envelope: ok(m, CURRENT[m]) })
    expect(c).toContain(`data-tour="module-${m}"`)
    expect(c).toContain('data-state="current"')
    expect(c).toMatch(/Current · observed /)
    expect(render(m, { kind: 'empty', envelope: ok(m, CURRENT[m]) })).toContain(EMPTY_TEXT)
    for (const why of ['no_reader', 'withheld', 'stale', 'unreadable'] as const) {
      const html = render(m, { kind: 'unavailable', why })
      expect(html).toContain(UNAVAILABLE_TEXT[why])
      expect(html).toContain('data-state="unavailable"')
    }
    expect(UNAVAILABLE_TEXT.no_reader).toBe('Unavailable: no reader yet')
    // Root's synthetic fixture: never drawn in the current-state area; drawn in a tour, always labelled
    const synthetic = tourStateOf(FIXTURE[m], MIND, m)
    const here = render(m, synthetic)
    expect(here).toContain('data-state="unavailable"')
    expect(here).not.toContain(BANKED_QUALIFICATION)
    const tour = render(m, synthetic, 'tour')
    expect(tour).toContain('data-state="synthetic"')
    expect(tour).toContain(BANKED_QUALIFICATION)
    const banked = { kind: 'banked' as const, envelope: ok(m, { ...clone(FIXTURE[m]), state: 'banked', provenance: { source_revision: null, evidence_refs: [], read_path: 'banked-receipt', authority: 'none' } }) }
    expect(render(m, banked)).not.toContain(BANKED_QUALIFICATION)
    expect(render(m, banked, 'tour')).toContain(BANKED_QUALIFICATION)
    expect(render(m, { kind: 'loading' })).toContain('data-state="loading"')
  })

  it('never draws ids, refs, terms, premises, evidence links, model refs or revisions', () => {
    const html = MODULES.map((m) => render(m, { kind: 'current', envelope: ok(m, CURRENT[m]) })).join('\n')
    for (const secret of ['SECRET_', 'sample-a', 'sample-skill', 'sample-node', 'sample-event', 'sample-bell', 'sample-light', 'sample-rule', 'sample-model', 'invented-1', 'src-1']) expect([secret, html.includes(secret)]).toEqual([secret, false])
    // labels (consent-filtered by the host), plain explanations and published codes in plain words are shown
    for (const shown of ['Invented sample A', 'Made up: pinned.', 'task pin', 'overlapped by', 'A projection.', '(late evidence)', 'f 0.90 · c 0.80', 'truth unknown', 't=10s']) expect([shown, html.includes(shown)]).toEqual([shown, true])
  })

  it('no goal/board wording in any host string shown: labels, explanations, kinds, units, qualification', () => {
    expect(plainWords('Goals board')).toBe('Task list')
    expect(plainWords('the goal board and its goals')).toBe('the task list and its tasks')
    expect(plainCode('goal_board')).toBe('task list')
    const G = 'Goals board'
    const tagged: [ModuleId, Doc][] = [
      ['attention', cur('attention', { qualification: G, explain: G, ranked_items: [{ id: 'a', label: G, score: 1, reason_codes: [], explain: G }], items: [{ id: 'g', kind: G, label: G, explain: G }] })],
      ['self', cur('self', { qualification: G, explain: G, skills: [{ ...(FIXTURE.self.skills as Doc[])[0], label: G, explain: G }] })],
      ['energy', cur('energy', { qualification: G, explain: G, budget: { unit: G, limit: 1, reserved: 0, spent: 0 } })],
      ['scratch', cur('scratch', { qualification: G, explain: G, items: [{ id: 'x', kind: G, promotion_state: 'proposed', expiry: null, explain: G }] })],
      ['assume', cur('assume', { qualification: G, explain: G, nodes: [{ id: 'n', kind: G, label: G, explain: G }], prediction: { target_ref: 'n', value: 1, unit: G, explain: G } })],
      ['temporal', cur('temporal', { qualification: G, explain: G, events: [{ ...EV, explain: G }], expectations: [{ ...EX, explain: G }], projection: { source_time: 1, target_time: 2, truth_before: null, truth_after: null, model_ref: 'm', explain: G } })],
    ]
    for (const [m, raw] of tagged) {
      const html = render(m, { kind: 'current', envelope: ok(m, raw) })
      expect(html, m).toContain('Task list')
      expect(html.replace(/<[^>]+>/g, ' '), m).not.toMatch(/\bgoals?\b|\bboards?\b/i)
    }
  })
})

describe('reads', () => {
  const recorder = () => {
    const out: Partial<Record<ModuleId, ViewState>> = {}
    return { out, write: (m: ModuleId, s: ViewState) => void (out[m] = s) }
  }

  it('the plain simulator (as every hive today) declares no reader: no read is made, all six say "no reader yet"', async () => {
    const sim = new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 1 })
    const spy = vi.spyOn(sim, 'programRead')
    expect(await readerDeclared(sim)).toBe(false)
    const r = recorder()
    await loadReasoningModules(sim, { id: MIND, swarm_id: 's1' }, r.write, bindEpoch())
    expect(spy).not.toHaveBeenCalled()
    expect(r.out).toEqual(allAt({ kind: 'unavailable', why: 'no_reader' }))
    sim.disconnect()
  })

  it('undeclared, disabled, missing app or no read route: never called', async () => {
    const programRead = vi.fn()
    const cases = [
      { program: async () => ({ enabled: true, error: null, describe: { reads: [] } }), programRead },
      { program: async () => ({ enabled: false, error: null, describe: { reads: [{ id: 'reasoning-module' }] } }), programRead },
      { program: async () => Promise.reject(new ApiError(404, 'not_found', 'no program')), programRead },
      { program: async () => ({ enabled: true, error: null, describe: { reads: [{ id: 'reasoning-module' }] } }) },
    ]
    for (const c of cases) {
      const r = recorder()
      await loadReasoningModules(c as never, { id: MIND, swarm_id: 's1' }, r.write, bindEpoch())
      expect(r.out).toEqual(allAt({ kind: 'unavailable', why: 'no_reader' }))
    }
    expect(programRead).not.toHaveBeenCalled()
    const r = recorder()
    await loadReasoningModules(null, { id: MIND, swarm_id: 's1' }, r.write, bindEpoch())
    expect(r.out).toEqual(allAt({ kind: 'unavailable', why: 'no_reader' }))
  })

  it('declared: one read per module, exactly the contract body, under the mind asked for', async () => {
    const calls: unknown[][] = []
    const c = {
      program: async () => ({ enabled: true, error: null, describe: { reads: [{ id: 'reasoning-module' }] } }),
      programRead: async (...a: unknown[]) => {
        calls.push(a)
        const ref = (a[3] as { ref: string }).ref
        const m = ref.split(':')[2] as ModuleId
        if (m === 'assume') throw new ApiError(404, 'not_found', 'not found')
        return { program: 'omega-tools', query: 'reasoning-module', result: m === 'temporal' ? { ...CURRENT.temporal, mind_id: 'm_other' } : CURRENT[m] }
      },
    }
    const r = recorder()
    await loadReasoningModules(c as never, { id: MIND, swarm_id: 's1' }, r.write, bindEpoch())
    expect(calls).toEqual(MODULES.map((m) => ['omega-tools', 's1', 'reasoning-module', { ref: `mind:${MIND}:${m}` }]))
    expect(r.out.attention?.kind).toBe('current')
    expect(r.out.assume).toEqual({ kind: 'unavailable', why: 'withheld' })
    expect(r.out.temporal).toEqual({ kind: 'unavailable', why: 'unreadable' })
  })

  it('the invented fixture needs BOTH ?sim=1 and ?reasoning=invented, explicitly (stand-in r1 P2)', () => {
    expect(inventedReasoningRequested('?sim=1&reasoning=invented')).toBe(true)
    expect(inventedReasoningRequested('?reasoning=invented&sim=1')).toBe(true)
    for (const q of ['', '?reasoning=invented', '?sim=0&reasoning=invented', '?sim=1', '?sim=1&reasoning=1', '?sim=true&reasoning=invented'])
      expect([q, inventedReasoningRequested(q)]).toEqual([q, false])
  })

  it('the invented sim fixture (opt-in) shows each state, and is labelled invented', async () => {
    const sim = new SimClient({ seed: 4, latency: false, autoStart: false, historyDays: 1, reasoning: 'invented' })
    const r = recorder()
    const swarm = (await sim.listSwarms())[0].id
    await loadReasoningModules(sim, { id: 'any-mind', swarm_id: swarm }, r.write, bindEpoch())
    expect(Object.fromEntries(MODULES.map((m) => [m, r.out[m]?.kind === 'unavailable' ? `unavailable:${(r.out[m] as { why: string }).why}` : r.out[m]?.kind]))).toEqual({
      attention: 'current', self: 'current', energy: 'current', scratch: 'empty', assume: 'unavailable:withheld', temporal: 'unavailable:stale',
    })
    const a = r.out.attention
    expect(a && 'envelope' in a && a.envelope.qualification).toMatch(/invented .*not evidence of real state/)
    sim.disconnect()
  })

  it.each([['another tab', false], ['the same tab (credential only)', true]] as const)('a late answer after an identity switch (%s) writes nothing', async (_n, sameTab) => {
    const a = testPerson(`rv-a-${sameTab}`)
    const b = sameTab ? testPerson(`rv-b-${sameTab}`, { sameTab: a }) : testPerson(`rv-b-${sameTab}`)
    await signInAs(a)
    let release: () => void = () => undefined
    const gate = new Promise<void>((res) => (release = res))
    const c = {
      program: async () => ({ enabled: true, error: null, describe: { reads: [{ id: 'reasoning-module' }] } }),
      programRead: async (_id: string, _s: string, _q: string, p: { ref: string }) => {
        await gate
        return { program: 'omega-tools', query: 'reasoning-module', result: CURRENT[p.ref.split(':')[2] as ModuleId] }
      },
    }
    const write = vi.fn()
    const binding = bindEpoch()
    const done = loadReasoningModules(c as never, { id: MIND, swarm_id: 's1' }, write, binding)
    await new Promise((res) => setTimeout(res, 0))
    await switchPerson(a, b)
    release()
    expect(await done).toBe(STALE)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('the PageView export: metadata only', () => {
  it('module, state, counts and time; no labels, terms, ids, codes or evidence', () => {
    const states = Object.fromEntries(MODULES.map((m) => [m, { kind: 'current', envelope: ok(m, CURRENT[m]) }])) as Record<ModuleId, ViewState>
    states.scratch = { kind: 'unavailable', why: 'no_reader' }
    const view = reasoningPageView(MIND, states)
    const wire = JSON.stringify(fitView(view))
    const whole = JSON.stringify(view)
    expect(view.summary).toMatch(/^attention: current, 4 held, observed 2026-10-08T00:00:00Z; self: current, 3 held/)
    expect(view.summary).toContain('scratch: unavailable (no reader)')
    for (const text of [whole, wire]) {
      for (const secret of ['SECRET_', 'Invented sample', 'Invented skill', 'Invented node', 'Invented fixture', 'Made up', 'sample-', 'task-pin', 'prerequisites-present', 'ev:', 'aaaaaaaa', 'invented-1', 'src-1']) expect([secret, text.includes(secret)]).toEqual([secret, false])
    }
    expect(view.refs).toEqual([{ kind: 'mind', ref: MIND }])
    expect(new TextEncoder().encode(wire).length).toBeLessThanOrEqual(2048)
  })
})

describe('boundaries and tokens', () => {
  // code only: comments may name what is never done
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = [contractSrc, loadSrc, viewerSrc, modulesSrc, pageViewSrc, wordsSrc].map(strip).join('\n')

  it('token lint: no colour literals in the viewers or their rendered markup', () => {
    const lit = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|bg-white|bg-black|text-white|text-black/i
    expect(src).not.toMatch(lit)
    const html = MODULES.map((m) => render(m, { kind: 'current', envelope: ok(m, CURRENT[m]) }) + render(m, { kind: 'unavailable', why: 'no_reader' })).join('')
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|white|black/i)
  })

  it('read-only: no act, run, fetch, filesystem or _hive path; the only route is the declared read', () => {
    expect(src).not.toMatch(/programAct\(|confirmAct|run-native|fetch\(|['"`]\/api\/|_hive|node:fs|mind_token|Authorization/)
    expect(src).toMatch(/programRead/)
  })

  it('every post-await write goes through the identity epoch binding', () => {
    const load = loadSrc
    expect(load.match(/binding\.commit\(/g)?.length).toBeGreaterThanOrEqual(2)
    const view = modulesSrc
    expect(view).toMatch(/bindEpoch\(\)/)
    expect(view).toMatch(/useIdentityEpoch\(\)/)
  })

  it('never Atlas or Truth', () => {
    expect(src).not.toMatch(/atlas|omegatruth/i)
  })
})

describe('tour targets line up with Root’s demo catalogue (20261008-150701Z, demo-catalogue.json 8011cba0…)', async () => {
  const { GUIDE_SCRIPTS } = await import('../../guided/scripts')
  it('each banked hook leads to the viewer of the module its catalogue entry names; temporal and Assume stay stubs', () => {
    const banked = Object.fromEntries(GUIDE_SCRIPTS.filter((s) => s.banked).map((s) => [s.banked, s.viewer]))
    // catalogue: attention-demo-focus→attention, skill-demo-nominate→self, energy-demo-reserve→energy, scratch-demo-promotion→scratch
    expect(banked).toEqual({ 'attention-demo-focus': 'attention', 'skill-demo-nominate': 'self', 'energy-demo-reserve': 'energy', 'scratch-demo-promotion': 'scratch' })
    // catalogue: both temporal hooks available:false; Assume has no catalogue entry. Neither is marked ready.
    for (const id of ['temporal', 'assume']) expect(GUIDE_SCRIPTS.find((s) => s.id === id)).toMatchObject({ status: 'stub', viewer: id })
    expect(GUIDE_SCRIPTS.find((s) => s.id === 'temporal')?.hooks).toEqual(['temporal-demo-sequence', 'temporal-demo-anticipation'])
  })
})

describe('read batches: one per mount, person and mind; a StrictMode replay never reads twice; ended batches write nothing (Root 172706Z)', () => {
  afterEach(() => vi.useRealTimers())
  it('a dev StrictMode replay (setup, cleanup, setup in one commit) revives the batch: dispatched once', () => {
    vi.useFakeTimers()
    const client = {}
    let dispatched = 0
    const a = startBatch(null, '1|a_m|s', client, () => dispatched++)
    endBatch(a)
    const b = startBatch(a, '1|a_m|s', client, () => dispatched++)
    expect([b === a, dispatched, batchWrites(b)]).toEqual([true, 1, true])
    vi.advanceTimersByTime(10)
    expect([b.aborted, batchWrites(b)]).toEqual([false, true])
  })
  it('production (no replay): one setup, one batch; an unmount aborts it on the next task and its late answers are refused', () => {
    vi.useFakeTimers()
    let dispatched = 0
    const a = startBatch(null, '1|a_m|s', {}, () => dispatched++)
    expect(dispatched).toBe(1)
    endBatch(a)
    expect(batchWrites(a)).toBe(false) // ended: nothing written from now on, even before the abort lands
    vi.advanceTimersByTime(1)
    expect([a.aborted, batchWrites(a)]).toEqual([true, false])
  })
  it('another person (epoch), mind or client: the batch in flight is aborted and a new one reads; nothing is shared', () => {
    vi.useFakeTimers()
    const client = {}
    const seen: number[] = []
    const a = startBatch(null, '1|a_m|s', client, (x) => seen.push(x.id))
    for (const [key, cl] of [['2|a_m|s', client], ['2|a_other|s', client], ['2|a_other|s', {}]] as const) {
      const prev = seen.length
      const cur = startBatch(null, key, cl, (x) => seen.push(x.id))
      expect(seen.length).toBe(prev + 1)
      expect(cur.id).not.toBe(a.id)
    }
    // a replay with a different key does not revive: the old one is aborted, a new one dispatched
    endBatch(a)
    const b = startBatch(a, '2|a_m|s', client, (x) => seen.push(x.id))
    expect([b === a, a.aborted, batchWrites(a), batchWrites(b)]).toEqual([false, true, false, true])
  })
  it('an aborted batch is never revived', () => {
    vi.useFakeTimers()
    let dispatched = 0
    const a = startBatch(null, 'k', null, () => dispatched++)
    endBatch(a)
    vi.advanceTimersByTime(1)
    const b = startBatch(a, 'k', null, () => dispatched++)
    expect([b === a, dispatched, a.aborted]).toEqual([false, 2, true])
  })
})
