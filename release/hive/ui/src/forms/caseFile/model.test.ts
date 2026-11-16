import { describe, expect, it } from 'vitest'
import type { ProgramDescription, WorkGraph, WorkItem } from '../../api/types'
import { fixtureDescribe, fixtureGraph } from './fixture'
import { balanceFor, buildCase, leanSentence, collectErrata, collectExhibits, custodySteps, gateOf, labelU, markFor, polarityOf, proposalOf } from './model'

const d = (relations: ProgramDescription['relations']): ProgramDescription => ({
  contract: '0.1',
  kinds: [
    { id: 'claim', label: 'Claim', role: 'claim' },
    { id: 'evidence', label: 'Evidence', role: 'evidence' },
  ],
  relations,
  actions: [],
})
const g = (items: WorkItem[], links: WorkGraph['links']): WorkGraph => ({ revision: 'r1', items, links, groups: [], notes: [] })
const ev = (id: string, extra: Partial<WorkItem> = {}): WorkItem => ({ id, kind: 'evidence', label: id, ...extra })

describe('balance from polarity', () => {
  it('reads polarity from describe().relations, not from relation names', () => {
    const desc = d([
      { id: 'bolsters', label: 'bolsters', polarity: 'support' },
      { id: 'undercuts', label: 'undercuts', polarity: 'oppose' },
      // a relation called "supports" that the program declares neutral must stay off the balance
      { id: 'supports', label: 'supports', polarity: 'neutral' },
    ])
    const graph = g(
      [{ id: 'c', kind: 'claim', label: 'C' }, ev('a'), ev('b'), ev('n')],
      [
        { id: '1', from: 'a', to: 'c', rel: 'bolsters' },
        { id: '2', from: 'b', to: 'c', rel: 'undercuts' },
        { id: '3', from: 'n', to: 'c', rel: 'supports' },
      ],
    )
    const b = balanceFor(graph, desc, 'c')!
    expect(b.pro.pieces.map((p) => p.item.id)).toEqual(['a'])
    expect(b.con.pieces.map((p) => p.item.id)).toEqual(['b'])
    expect(b.qualify).toEqual([])
    expect(polarityOf('supports', desc)).toBe('neutral')
    expect(polarityOf('supports', null)).toBe('support')
  })

  it('weighs by link weight, tilts toward the heavier side, and calls an empty side a gap', () => {
    const desc = d([
      { id: 'supports', label: 'supports', polarity: 'support' },
      { id: 'contradicts', label: 'contradicts', polarity: 'oppose' },
    ])
    const graph = g(
      [{ id: 'c', kind: 'claim', label: 'C' }, ev('a'), ev('b', { weight: 0.25 })],
      [
        { id: '1', from: 'a', to: 'c', rel: 'supports', weight: 0.75 },
        { id: '2', from: 'b', to: 'c', rel: 'contradicts' },
      ],
    )
    const b = balanceFor(graph, desc, 'c')!
    expect(b.pro.weight).toBeCloseTo(0.75)
    expect(b.con.weight).toBeCloseTo(0.25)
    expect(b.tilt).toBeCloseTo(0.5)
    expect(b.empty).toBeNull()
    const lone = balanceFor(g([{ id: 'c', kind: 'claim', label: 'C' }, ev('a')], [{ id: '1', from: 'a', to: 'c', rel: 'supports' }]), desc, 'c')!
    expect(lone.empty).toBe('against')
    expect(balanceFor(g([{ id: 'c', kind: 'claim', label: 'C' }], []), desc, 'c')!.empty).toBe('both')
    expect(leanSentence(lone)).toMatch(/gap in the search, not support/)
    expect(leanSentence(b)).toMatch(/^On the present record the balance leans for the claim: 1 piece from 1 independent origin for, 1 piece/)
  })

  it('keeps retracted and superseded evidence on the record but adds no weight', () => {
    const b = buildCase(fixtureGraph, fixtureDescribe).balances.get('c1')!
    const press = b.pro.pieces.find((p) => p.item.id === 'e8')!
    expect(press.counted).toBe(false)
    expect(b.pro.count).toBe(3)
    expect(b.pro.pieces).toHaveLength(4)
    // e6 is corrected, not withdrawn: it still counts
    expect(b.con.pieces.find((p) => p.item.id === 'e6')!.counted).toBe(true)
  })
})

describe('origin non-independence', () => {
  const desc = d([{ id: 'supports', label: 'supports', polarity: 'support' }])
  const src = (id: string, origin?: string) => ({ id, label: id, origin })
  const graph = g(
    [
      { id: 'c', kind: 'claim', label: 'C' },
      ev('a', { sources: [src('s1', 'wire')] }),
      ev('b', { sources: [src('s2', 'wire')] }),
      ev('x', { sources: [src('s3', 'own')] }),
    ],
    [
      { id: '1', from: 'a', to: 'c', rel: 'supports', weight: 0.6 },
      { id: '2', from: 'b', to: 'c', rel: 'supports', weight: 0.9 },
      { id: '3', from: 'x', to: 'c', rel: 'supports', weight: 0.5 },
    ],
  )

  it('counts pieces sharing an origin once, at the heaviest', () => {
    const b = balanceFor(graph, desc, 'c')!
    expect(b.pro.count).toBe(3)
    expect(b.pro.independent).toBe(2)
    expect(b.pro.weight).toBeCloseTo(0.9 + 0.5)
    expect(b.pro.shared).toEqual(['wire'])
    const [a, bb] = ['a', 'b'].map((id) => b.pro.pieces.find((p) => p.item.id === id)!)
    expect(a.group).toBe(bb.group)
  })

  it('flags exhibits that share an origin as not independent; one source cited twice is not "shared"', () => {
    const ex = collectExhibits(graph, desc)
    const byId = (id: string) => ex.find((e) => e.source.id === id)!
    expect(byId('s1').sameOrigin).toEqual([byId('s2').mark])
    expect(byId('s3').sameOrigin).toEqual([])
    const twice = g([ev('p', { sources: [src('s9', 'one')] }), ev('q', { sources: [src('s9', 'one')] })], [])
    const t = collectExhibits(twice, desc)
    expect(t).toHaveLength(1)
    expect(t[0].sameOrigin).toEqual([])
    expect(t[0].citedBy.map((c) => c.id)).toEqual(['p', 'q'])
  })

  it('in the fixture, the GridCo billing exhibits are marked as one origin', () => {
    const ex = collectExhibits(fixtureGraph, fixtureDescribe).filter((e) => e.source.origin === 'gridco-billing')
    expect(ex).toHaveLength(3)
    for (const e of ex) expect(e.sameOrigin).toHaveLength(2)
  })

  it('marks run A..Z then AA', () => {
    expect([0, 25, 26, 27].map(markFor)).toEqual(['A', 'Z', 'AA', 'AB'])
  })
})

describe('uncertainty labelling', () => {
  it('names the method and keeps every component separate', () => {
    const nal = labelU({ method: 'nal', f: 0.74, c: 0.62 })
    expect(nal.methodName).toBe('NAL')
    expect(nal.parts.map((p) => [p.name, p.value])).toEqual([
      ['frequency', '0.74'],
      ['confidence', '0.62'],
    ])
    const pln = labelU({ method: 'pln', strength: 0.4, confidence: 0.3 })
    expect(pln.methodName).toBe('PLN')
    expect(pln.parts.map((p) => p.name)).toEqual(['strength', 'confidence'])
    expect(pln.text).toContain('PLN')
    expect(labelU({ method: 'qualitative', status: 'contested' }).text).toBe('Qualitative: contested')
  })
  it('shows other methods as given, never converted', () => {
    const o = labelU({ method: 'bayes-ish', label: 'likely' })
    expect(o.method).toBe('other')
    expect(o.methodName).toBe('bayes-ish')
    expect(o.parts).toEqual([{ key: 'label', name: 'label', value: 'likely' }])
  })
  it('treats missing as unassessed, which is not zero', () => {
    for (const u of [undefined, null]) {
      const l = labelU(u)
      expect(l.assessed).toBe(false)
      expect(l.parts).toEqual([])
      expect(l.text).toMatch(/not zero/)
    }
    const b = buildCase(fixtureGraph, fixtureDescribe).balances.get('c2')!
    // e4 (opening hours) has no uncertainty: counted, and counted as unassessed
    expect(b.con.unassessed).toBe(1)
  })
})

describe('errata extraction', () => {
  it('collects corrections, retractions and supersessions, newest first, with the earlier wording', () => {
    const { errata, affected } = collectErrata(fixtureGraph)
    expect(errata.map((e) => [e.item.id, e.kind])).toEqual([
      ['e8', 'retracted'],
      ['e6', 'corrected'],
      ['a2', 'superseded'],
    ])
    const e6 = errata.find((e) => e.item.id === 'e6')!
    expect(e6.was).toBe('The main meter was replaced in October.')
    expect(e6.now).toMatch(/November/)
    expect(e6.revision).toBe('r5')
    expect(affected.map((a) => a.id)).toEqual(['a1'])
  })
  it('current items are not errata', () => {
    expect(collectErrata(g([ev('a'), ev('b', { status: 'current' })], [])).errata).toEqual([])
  })
})

describe('custody and proposals', () => {
  it('walks the custody chain and breaks it at unavailable', () => {
    expect(custodySteps('retrieved').map((s) => s.state)).toEqual(['done', 'current', 'todo'])
    expect(custodySteps('unavailable').map((s) => [s.step, s.state])).toEqual([
      ['cited', 'done'],
      ['unavailable', 'broken'],
    ])
    expect(custodySteps(undefined)[0].state).toBe('current')
  })
  it('keeps transport and review as two parts, top-level or in meta', () => {
    expect(proposalOf({ id: 'a', kind: 'assessment', label: 'a', meta: { proposal: { goal_id: 'g1', transport: 'validated', review: 'pending' } } })).toEqual({ goalId: 'g1', transport: 'validated', review: 'pending' })
    const top = { id: 'a', kind: 'assessment', label: 'a', proposal: { transport: 'stale' } } as WorkItem
    expect(proposalOf(top)).toEqual({ goalId: null, transport: 'stale', review: 'unknown' })
    expect(proposalOf({ id: 'a', kind: 'claim', label: 'a' })).toBeNull()
  })
})

describe('which actions need the full-context confirm', () => {
  it('gates agent dispatch, money, egress and permanent changes', () => {
    expect(gateOf('ask-scientist')?.kind).toBe('dispatch')
    expect(gateOf('ask-challenger')?.kind).toBe('dispatch')
    expect(gateOf('dispatch-bias-trial')?.kind).toBe('spend')
    expect(gateOf('retrieve-source')?.kind).toBe('egress')
    expect(gateOf('correct')?.kind).toBe('durable')
    expect(gateOf('buy-shares')?.kind).toBe('spend')
    expect(gateOf('ask-oracle')?.kind).toBe('dispatch')
    expect(gateOf('add-claim')).toBeNull()
    expect(gateOf('inspect-source')).toBeNull()
  })
  it('every gated action Truth declares in the fixture is gated', () => {
    const ids = fixtureDescribe.actions.map((a) => a.id)
    for (const id of ['ask-scientist', 'verify-claim', 'ask-challenger', 'challenge', 'investigate-gap', 'dispatch-bias-trial']) {
      expect(ids).toContain(id)
      expect(gateOf(id)).not.toBeNull()
    }
  })
})

describe('the whole case', () => {
  it('puts the best-evidenced live claim on the balance first, or the focus when weighable', () => {
    const c = buildCase(fixtureGraph, fixtureDescribe)
    expect(c.question?.id).toBe('q1')
    expect(c.primary).toBe('c1')
    expect(c.weighable.map((w) => w.id)).toEqual(['c1', 'c2', 'h1', 'h2', 'h3'])
    expect(buildCase({ ...fixtureGraph, focus: 'h2' }, fixtureDescribe).primary).toBe('h2')
  })
})
