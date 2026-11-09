import { describe, expect, it } from 'vitest'
import type { WorkGraph, WorkItem } from '../../api/types'
import { BODY_PATH, FIG_H, FIG_W, NERVES, ORGANS, VERTEBRAE } from './anatomy'
import { ask, PROMPTS } from './ask'
import { canConfirm, confirm, digestOf, editGate, idempotencyKey, MIN_DWELL_MS, noteKeyDown, openGate, settle, type Envelope } from './consent'
import { CONSEQUENTIAL, resolveMode } from './mode'
import {
  frameFor,
  gapsOf,
  indexGraph,
  marksAt,
  MAX_FULL_PER_STRUCTURE,
  placeAll,
  presence,
  readingOf,
  readingSentence,
  restingName,
  silentSpans,
  STRUCTURES,
  territoryCentre,
  territoryFrom,
  uncertaintyText,
  weightText,
} from './model'
import { anyRevealed, DEFAULT_IDLE_MS, isRevealed, remaining, reveal, sealed, tick, touch, conceal } from './privacy'
import { parse, recordClosed, recordSent, serialise, snapshotScope, untilText, withExpiry, EXPIRIES } from './requests'
import { ATLAS_DESCRIBE, EMPTY_GRAPH, sampleGraph } from './sample'
import { draftMissing, envelopeOf, simulateAct, type Draft } from './useAtlas'

const S = sampleGraph()
const ix = indexGraph(S, ATLAS_DESCRIBE)
const place = placeAll(ix)
const id = (s: string) => `sample:${s}`
const item = (s: string) => ix.byId.get(id(s))!

/* ================================================================ the sample dataset */

describe('the SAMPLE Atlas', () => {
  it('stays inside the Atlas projection limits and is internally consistent', () => {
    expect(S.items.length).toBeLessThanOrEqual(400)
    expect(S.links.length).toBeLessThanOrEqual(1200)
    expect(new Set(S.items.map((i) => i.id)).size).toBe(S.items.length)
    for (const l of S.links) {
      expect(ix.byId.has(l.from), l.from).toBe(true)
      expect(ix.byId.has(l.to), l.to).toBe(true)
    }
  })
  it('is labelled fictional and uses only Atlas kinds and relations', () => {
    expect(S.notes[0]).toMatch(/^SAMPLE/)
    expect(item('subject-a').label).toBe('Subject A')
    const kinds = new Set(ATLAS_DESCRIBE.kinds.map((k) => k.id))
    const rels = new Set(ATLAS_DESCRIBE.relations.map((r) => r.id))
    for (const i of S.items) expect(kinds.has(i.kind), i.kind).toBe(true)
    for (const l of S.links) expect(rels.has(l.rel), l.rel).toBe(true)
  })
  it('is deterministic', () => {
    expect(JSON.stringify(sampleGraph())).toBe(JSON.stringify(S))
  })
  it('has the messiness a real Atlas has', () => {
    const g = gapsOf(ix, place)
    expect(g.silentMonths).toEqual(expect.arrayContaining(['2024-06', '2024-07', '2024-08', '2024-09']))
    expect(silentSpans(g.silentMonths).find((s) => s.from === '2024-06')?.label).toBe('June – September 2024')
    expect(g.noRange.some((o) => /LDL/.test(o.label))).toBe(true)
    expect(g.unassessed.map((h) => h.id)).toContain(id('h-thyroid'))
    expect(item('ferritin-3x').status).toBe('corrected')
    expect(item('tsh-5').status).toBe('superseded')
    expect(S.items.some((i) => i.label.length > 90)).toBe(true)
    expect(g.unplaced).toEqual([])
  })
})

/* ================================================================ anatomy and placement */

describe('anatomy and territory placement', () => {
  it('builds the figure from closed paths in a 400 x 900 space', () => {
    expect([FIG_W, FIG_H]).toEqual([400, 900])
    expect(BODY_PATH.startsWith('M154 95')).toBe(true)
    expect(BODY_PATH.trim().endsWith('Z')).toBe(true)
    expect(ORGANS.map((o) => o.id)).toEqual(expect.arrayContaining(['brain', 'heart', 'lung-l', 'lung-r', 'gut']))
    expect(NERVES.length).toBeGreaterThan(16)
    expect(VERTEBRAE.every(([, y]) => y < 500)).toBe(true)
  })
  it('anchors body structures on the figure and context beside it', () => {
    for (const s of STRUCTURES) {
      expect(s.y).toBeGreaterThan(0)
      expect(s.y).toBeLessThan(FIG_H)
      if (s.territory === 'context') expect(s.x).toBeGreaterThan(330)
      else expect(Math.abs(s.x - 200)).toBeLessThan(80)
    }
    expect(territoryCentre('sleep').y).toBeLessThan(territoryCentre('metabolic').y)
  })
  it('reads legacy and plain territory names', () => {
    expect(territoryFrom('SLEEP_SYS')).toBe('sleep')
    expect(territoryFrom('MET_SYS')).toBe('metabolic')
    expect(territoryFrom('hormones')).toBe('endocrine')
    expect(territoryFrom('nonsense')).toBeNull()
    expect(territoryFrom(3)).toBeNull()
  })
  it('places by meta first, then the words of the record, then links', () => {
    expect(place.get(id('ferritin-1'))).toMatchObject({ territory: 'metabolic', structure: 'liver', via: 'meta' })
    expect(place.get(id('vitd-1'))).toMatchObject({ territory: 'metabolic', structure: null, via: 'meta' })
    expect(place.get(id('mood-1'))).toMatchObject({ territory: 'mind', structure: 'affect', via: 'meta' })
    expect(place.get(id('screen-2023-02'))).toMatchObject({ territory: 'context', structure: 'light', via: 'structure-words' })
    expect(place.get(id('h-caffeine'))).toMatchObject({ territory: 'sleep', via: 'meta' })
    expect(place.get(id('l-iron'))).toMatchObject({ territory: 'metabolic', via: 'link' })
    expect(place.get(id('lab-1'))?.via).toBe('link')
    expect(place.has(id('subject-a'))).toBe(false)
  })
  it('falls back to Context, never drops a record', () => {
    const g: WorkGraph = { revision: 'x', items: [{ id: 'a', kind: 'observation', label: 'Something unclassifiable' }], links: [], groups: [], notes: [] }
    const p = placeAll(indexGraph(g, null))
    expect(p.get('a')).toMatchObject({ territory: 'context', via: 'default' })
  })
  it('keeps observations around their structure and reasoning off to the side', () => {
    const f = place.get(id('ferritin-1'))!
    expect(Math.hypot(f.x - 222, f.y - 362)).toBeLessThan(80)
    const h = place.get(id('h-iron'))!
    expect(Math.abs(h.x - 200)).toBeGreaterThan(40)
  })
  it('frames the figure into the free area, leaning in at depth when focused', () => {
    const area = { x: 0, y: 0, w: 1000, h: 900 }
    const a = frameFor(area, 0, null)
    const b = frameFor(area, 2, { x: 222, y: 362 })
    expect(b.z).toBeGreaterThan(a.z * 1.4)
    expect(b.ox + 222 * b.z).toBeCloseTo(500, 0)
    expect(b.oy + 362 * b.z).toBeCloseTo(450, 0)
  })
})

/* ================================================================ semantic zoom */

describe('semantic zoom', () => {
  it('reveals by depth: Systems, Structures, Values, Provenance', () => {
    const obs = item('ferritin-1')
    const hyp = item('h-iron')
    const pred = item('p-ferritin')
    const ev = item('lab-1')
    const lit = item('l-iron')
    expect([0, 1, 2, 3].map((l) => presence(obs, l as 0))).toEqual(['glimmer', 'glimmer', 'full', 'full'])
    expect([0, 1, 2, 3].map((l) => presence(hyp, l as 0))).toEqual(['glimmer', 'full', 'full', 'full'])
    expect([0, 1, 2, 3].map((l) => presence(pred, l as 0))).toEqual(['hidden', 'full', 'full', 'full'])
    expect([0, 1, 2, 3].map((l) => presence(ev, l as 0))).toEqual(['hidden', 'hidden', 'hidden', 'full'])
    expect(presence(lit, 2)).toBe('hidden')
  })
  it('shows corrected and superseded records only at Provenance', () => {
    const x = item('ferritin-3x')
    expect([0, 1, 2].map((l) => presence(x, l as 0))).toEqual(['hidden', 'hidden', 'hidden'])
    expect(presence(x, 3)).toBe('full')
    expect(marksAt(ix, place, 2).some((m) => m.item.id === x.id)).toBe(false)
    expect(marksAt(ix, place, 3).some((m) => m.item.id === x.id)).toBe(true)
  })
  it('folds years of history: the newest few per structure in full, the rest as glimmers with a count', () => {
    const marks = marksAt(ix, place, 2)
    const sleep = marks.filter((m) => m.place.structure === 'sleep-architecture' && m.item.kind === 'observation')
    const full = sleep.filter((m) => m.presence === 'full')
    expect(full.length).toBe(MAX_FULL_PER_STRUCTURE)
    expect(full[0].folded).toBe(sleep.length - MAX_FULL_PER_STRUCTURE)
    expect(full.every((m, i) => i === 0 || (m.item.at ?? '') <= (full[i - 1].item.at ?? ''))).toBe(true)
  })
  it('scrubs time: nothing after the date is drawn', () => {
    const marks = marksAt(ix, place, 3, { asOf: '2024-01-31' })
    expect(marks.every((m) => !m.item.at || m.item.at.slice(0, 10) <= '2024-01-31')).toBe(true)
    expect(marks.length).toBeLessThan(marksAt(ix, place, 3).length)
  })
  it('isolates a territory: other territories drop to glimmers', () => {
    const marks = marksAt(ix, place, 2, { territory: 'sleep' })
    expect(marks.filter((m) => m.place.territory !== 'sleep').every((m) => m.presence === 'glimmer')).toBe(true)
    expect(marks.some((m) => m.place.territory === 'sleep' && m.presence === 'full')).toBe(true)
  })
})

/* ================================================================ privacy */

describe('values are sealed by default and re-seal on idle', () => {
  it('starts sealed', () => {
    const s = sealed()
    expect(anyRevealed(s)).toBe(false)
    expect(isRevealed(s, 'a')).toBe(false)
    expect(remaining(s, 0)).toBeNull()
  })
  it('reveals on intent, one value or all', () => {
    let s = reveal(sealed(), 'a', 1000)
    expect(isRevealed(s, 'a')).toBe(true)
    expect(isRevealed(s, 'b')).toBe(false)
    s = reveal(s, '*', 1500)
    expect(isRevealed(s, 'b')).toBe(true)
  })
  it('re-seals everything after the idle interval, and activity keeps it open', () => {
    let s = reveal(sealed(), '*', 0)
    s = tick(s, DEFAULT_IDLE_MS - 1)
    expect(anyRevealed(s)).toBe(true)
    s = touch(s, DEFAULT_IDLE_MS - 1)
    s = tick(s, DEFAULT_IDLE_MS + 5000)
    expect(anyRevealed(s)).toBe(true)
    expect(remaining(s, DEFAULT_IDLE_MS + 5000)).toBe(7)
    s = tick(s, 2 * DEFAULT_IDLE_MS)
    expect(anyRevealed(s)).toBe(false)
  })
  it('activity while sealed changes nothing; conceal works per value and for all', () => {
    const s0 = sealed()
    expect(touch(s0, 99)).toBe(s0)
    const s1 = reveal(reveal(sealed(), 'a', 0), 'b', 0)
    expect(isRevealed(conceal(s1, 'a'), 'a')).toBe(false)
    expect(isRevealed(conceal(s1, 'a'), 'b')).toBe(true)
    expect(anyRevealed(conceal(s1))).toBe(false)
  })
  it('names at rest never carry a value, even when the label does (messy variant: no marker names at all)', () => {
    const token = (v: unknown) => new RegExp(`(^|[^\\d.])${String(v).replace('.', '\\.')}([^\\d.]|$)`)
    for (const g of [S, sampleGraph({ messy: true })])
      for (const o of g.items.filter((i) => i.kind === 'observation')) {
        expect(o.label).toMatch(token(o.meta!.value))
        // a marker is a name by construction ("Caffeine after 2 pm"); without one, figures in the label are sealed
        if (o.meta!.marker) expect(restingName(o)).toBe(o.meta!.marker)
        else expect(restingName(o), o.label).not.toMatch(token(o.meta!.value))
      }
  })
  it('Ask answers name records but never print their values', () => {
    let named = 0
    for (const p of PROMPTS) {
      const a = ask(ix, place, p.id)
      for (const l of a.lines) {
        const it = l.item ? ix.byId.get(l.item) : null
        if (it?.kind !== 'observation') continue
        named++
        expect(l.text, `${p.id}`).not.toContain(`${it.meta!.value} ${it.meta!.units ?? ''}`.trim())
      }
    }
    expect(named).toBeGreaterThan(0)
  })
})

/* ================================================================ mode */

describe('whose Atlas: mode detection', () => {
  const real: WorkGraph = { revision: 'r', items: [{ id: 's', kind: 'subject', label: 'S' }, { id: 'o', kind: 'observation', label: 'x' }], links: [], groups: [], notes: [] }
  it('the owner sees their graph', () => expect(resolveMode(real, { isOwner: true }, false)).toEqual({ mode: 'owner', reason: null }))
  it('anyone else sees an empty Atlas, never the graph', () => {
    expect(resolveMode(real, { isOwner: false }, false)).toEqual({ mode: 'empty', reason: 'not-owner' })
    expect(resolveMode(real, undefined, false)).toEqual({ mode: 'empty', reason: 'not-owner' })
  })
  it('a newcomer with nothing recorded sees the empty state', () => {
    expect(resolveMode(EMPTY_GRAPH, { isOwner: true }, false)).toEqual({ mode: 'empty', reason: 'no-items' })
    expect(resolveMode(null, { isOwner: true }, false).mode).toBe('empty')
    expect(resolveMode({ ...real, items: [real.items[1]] }, { isOwner: true }, false)).toEqual({ mode: 'empty', reason: 'no-subject' })
  })
  it('the sample is only ever an explicit choice, and wins over everything', () => {
    expect(resolveMode(real, { isOwner: true }, true)).toEqual({ mode: 'sample', reason: null })
    expect(resolveMode(EMPTY_GRAPH, undefined, true).mode).toBe('sample')
  })
  it('consequential actions are named', () => expect([...CONSEQUENTIAL].sort()).toEqual(['cancel-request', 'investigate', 'revoke-request']))
  it('sample actions are simulated and say so', () => {
    const r = simulateAct(S, 'investigate', [id('h-iron')])
    expect(r.status).toBe('started')
    expect(typeof r.detail?.request_digest).toBe('string')
    expect(r.message).toMatch(/SAMPLE: simulated/)
    expect(simulateAct(S, 'inspect-source', [id('ferritin-1')]).detail?.sources?.length).toBe(1)
  })
})

/* ================================================================ investigate, revoke, cancel: the confirm gate */

describe('the consent gate', () => {
  const env: Envelope = { action: 'investigate', items: ['h1'], params: { worker_id: 'w', question: 'Does it hold?', budget_seconds: 900, expiry_ms: 3600000 } }
  const pointer = (g: { digest: string }) => ({ kind: 'pointer' as const, digest: g.digest })
  it('binds to exactly the envelope shown (order-independent), and a change re-opens review', () => {
    expect(digestOf(env)).toBe(digestOf({ ...env, items: ['h1'] }))
    expect(digestOf({ ...env, items: ['a', 'b'] })).toBe(digestOf({ ...env, items: ['b', 'a'] }))
    expect(digestOf({ ...env, params: { ...env.params, budget_seconds: 300 } })).not.toBe(digestOf(env))
    const g = openGate(env, 0)
    const g2 = editGate(g, { ...env, params: { ...env.params, budget_seconds: 300 } }, 5000)
    expect(canConfirm(g2, pointer(g), 6000)).toBe('changed')
    expect(canConfirm(g2, pointer(g2), 5100)).toBe('too-soon')
    expect(canConfirm(g2, pointer(g2), 5000 + MIN_DWELL_MS)).toBeNull()
  })
  it('needs a dwell: the activation that opened it can never confirm it', () => {
    const g = openGate(env, 1000)
    expect(canConfirm(g, pointer(g), 1000 + MIN_DWELL_MS - 1)).toBe('too-soon')
    expect(canConfirm(g, pointer(g), 1000 + MIN_DWELL_MS)).toBeNull()
  })
  it('refuses key repeat, and a key that began before the dialog', () => {
    const g = openGate(env, 0)
    const t = MIN_DWELL_MS + 10
    expect(canConfirm(g, { kind: 'key', digest: g.digest, repeat: true }, t)).toBe('repeat')
    expect(canConfirm(g, { kind: 'key', digest: g.digest }, t)).toBe('not-armed')
    expect(noteKeyDown(g, { key: 'Enter', repeat: true }, t).keyArmedAt).toBeNull()
    expect(noteKeyDown(g, { key: 'a', repeat: false }, t).keyArmedAt).toBeNull()
    const armed = noteKeyDown(g, { key: 'Enter', repeat: false }, t)
    expect(canConfirm(armed, { kind: 'key', digest: g.digest }, t + 1)).toBeNull()
  })
  it('one opening sends one envelope', () => {
    const g = openGate(env, 0)
    const r = confirm(g, pointer(g), MIN_DWELL_MS)
    expect(r.ok).toBe(true)
    expect(confirm(r.gate, pointer(g), MIN_DWELL_MS + 1).reason).toBe('closed')
    expect(confirm({ ...r.gate, phase: 'open' }, pointer(g), MIN_DWELL_MS + 1).reason).toBe('consumed')
    expect(settle(r.gate, true).phase).toBe('done')
    expect(idempotencyKey(g)).toBe(idempotencyKey({ digest: g.digest, openedAt: g.openedAt }))
  })
  it('revoke and cancel go through the same gate, with a reason', () => {
    const d: Draft = { action: 'revoke-request', items: ['h1'], digest: 'abc', reason: '', worker: '', question: '', budget: 900, expiryMs: 3600000, viaKey: false }
    expect(draftMissing(d)).toMatch(/why/i)
    expect(draftMissing({ ...d, reason: 'no longer needed' })).toBeNull()
    expect(envelopeOf({ ...d, reason: 'done' })).toEqual({ action: 'revoke-request', items: ['h1'], params: { request_digest: 'abc', reason: 'done' } })
    const inv: Draft = { ...d, action: 'investigate', worker: '', question: 'Does iron explain it?' }
    expect(draftMissing(inv)).toMatch(/worker/i)
    expect(draftMissing({ ...inv, worker: 'w1' })).toBeNull()
  })
  it('never offers an expiry the exchange would refuse (24 h)', () => {
    expect(Math.max(...EXPIRIES.map((e) => e.ms))).toBeLessThan(24 * 3600_000)
  })
})

/* ================================================================ requests */

describe('Scientist requests', () => {
  const started = { status: 'started' as const, detail: { request_digest: 'd1' }, task: { id: 'g1', kind: 'goal', status: 'open' } }
  it('are recorded only with a digest, and closed only when Atlas says done', () => {
    expect(recordSent([], { items: ['h'], worker: 'w', expiresAt: 10, budgetSeconds: 60 }, { status: 'refused' }, 0)).toEqual([])
    const l = recordSent([], { items: ['h'], worker: 'w', expiresAt: 10_000, budgetSeconds: 60 }, started, 0)
    expect(l[0]).toMatchObject({ digest: 'd1', state: 'pending', goalId: 'g1' })
    expect(recordClosed(l, 'd1', 'revoke-request', { status: 'refused' })[0].state).toBe('pending')
    expect(recordClosed(l, 'd1', 'revoke-request', { status: 'done' })[0].state).toBe('revoked')
    expect(recordClosed(l, 'd1', 'cancel-request', { status: 'done' })[0].state).toBe('cancelled')
    expect(withExpiry(l, 10_000)[0].state).toBe('expired')
  })
  it('stores nothing private', () => {
    const l = recordSent([], { items: ['h'], worker: 'w', expiresAt: 10_000, budgetSeconds: 60 }, started, 0)
    const raw = serialise([{ ...l[0], question: 'secret question' } as never])
    expect(raw).not.toMatch(/secret/)
    expect(parse(raw)[0].digest).toBe('d1')
    expect(parse('nonsense')).toEqual([])
  })
  it('the envelope shows exactly the sealed snapshot Atlas would build', () => {
    const s = snapshotScope(S, [id('h-thyroid')])
    expect(s.ids.has(id('h-thyroid'))).toBe(true)
    expect(s.ids.has(id('tsh-4'))).toBe(true)
    expect(s.ids.has(id('lab-4'))).toBe(true)
    expect(s.ids.has(id('l-tsh'))).toBe(true)
    expect(s.ids.has(id('h-iron'))).toBe(false)
    expect(s.ids.has(id('p-tsh'))).toBe(false)
    expect(s.byKind.hypothesis).toBe(1)
  })
  it('says when, plainly', () => {
    expect(untilText(0)).toBe('expired')
    expect(untilText(5 * 60_000)).toBe('in 5 min')
    expect(untilText(6 * 3600_000)).toBe('in 6 h')
  })
})

/* ================================================================ uncertainty: by method, never fused */

describe('uncertainty is labelled by its method', () => {
  it('names each method and never converts between them', () => {
    expect(uncertaintyText({ method: 'nal', f: 0.72, c: 0.41 })).toMatchObject({ assessed: true, method: 'nal', short: 'NAL f 0.72 · c 0.41' })
    expect(uncertaintyText({ method: 'pln', strength: 0.55, confidence: 0.3 })).toMatchObject({ method: 'pln', short: 'PLN s 0.55 · c 0.30' })
    expect(uncertaintyText({ method: 'qualitative', status: 'contested' }).short).toBe('Qualitative · contested')
    const rec = uncertaintyText(item('h-caffeine').uncertainty)
    expect(rec.method).toBe('atlas-recorded-confidence')
    expect(rec.long).toMatch(/not a calibrated probability/)
  })
  it('unassessed is not zero', () => {
    const u = uncertaintyText(item('h-thyroid').uncertainty)
    expect(u.assessed).toBe(false)
    expect(u.long).toMatch(/not zero/)
  })
  it('link weights are heuristics, never probabilities', () => {
    expect(weightText(0.6)).toBe('heuristic weight 0.60')
    expect(weightText(undefined)).toBeNull()
  })
})

/* ================================================================ readings */

describe('values as sentences against their range', () => {
  it('reads the legacy units and general ranges', () => {
    const r = readingOf(item('ferritin-4'))!
    expect(r).toMatchObject({ value: '21', unit: 'ng/mL', low: 30, high: 400, state: 'below', generic: false })
    expect(readingSentence(r)).toBe('21 ng/mL, below the laboratory’s own interval of 30–400')
    const sol = readingOf(item('sol-2023-02'))!
    expect(sol.generic).toBe(true)
    expect(readingSentence(sol)).toMatch(/a general range, not this laboratory’s/)
  })
  it('says so when there is no range', () => {
    const r = readingOf(item('ldl-1'))!
    expect(r.state).toBeNull()
    expect(readingSentence(r)).toMatch(/no reference range is recorded/)
  })
  it('a record without a value has no reading', () => {
    expect(readingOf({ id: 'x', kind: 'observation', label: 'x' } as WorkItem)).toBeNull()
  })
})
