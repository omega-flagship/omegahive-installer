// The personal mind's space, run directly (no worker): beliefs, revision on disjoint evidence only, forgetting,
// recall, provenance, inference, and the file round trip with its merge rules.
import { describe, expect, it } from 'vitest'
import { MindCore, MindError } from './core'
import type { Integrated } from './types'

const clock = 1_000
/** a remembered exchange: it was said (f = 1), as sure as the record is */
const SAID = { f: 1, c: 0.9 }
const fresh = () => MindCore.create({ self: 'm-test', salt: 'salt-a', now: () => clock })
const ok = <T extends { ok: boolean }>(r: T) => {
  expect(r.ok).toBe(true)
  return r as Extract<T, { ok: true }>
}

describe('beliefs', () => {
  it('adopts a new belief with a minted stamp and keeps the given frequency', () => {
    const s = fresh()
    const r = ok(s.addBelief('b1', 'preference', 'Likes short answers', { f: 0.8, c: 0.5 }, { at: 10, turn: 't1' })) as Integrated
    expect(r.outcome).toBe('adopted')
    expect(r.before).toBeNull()
    expect(r.after.stv).toEqual({ f: 0.8, c: 0.5 })
    expect(r.after.stamp).toEqual([{ agent: 'm-test', n: 1 }])
    expect(s.belief('b1')).toMatchObject({ kind: 'preference', statement: 'Likes short answers', stv: { f: 0.8, c: 0.5 } })
  })

  it('revises with lib_nal Truth_Revision on disjoint evidence', () => {
    const s = fresh()
    s.addBelief('b1', 'preference', 'x', { f: 0.9, c: 0.5 }, { at: 10 })
    const r = ok(s.reviseBelief('b1', { f: 0.2, c: 0.3 }, { at: 11 })) as Integrated
    expect(r.outcome).toBe('revised')
    // w1 = 1, w2 = 3/7; f = (0.9 + 0.2*3/7) / (10/7) = 0.69; c = w2c(10/7) = 10/17
    expect(r.after.stv.f).toBeCloseTo(0.69, 12)
    expect(r.after.stv.c).toBeCloseTo(10 / 17, 12)
    expect(r.after.stamp).toEqual([{ agent: 'm-test', n: 1 }, { agent: 'm-test', n: 2 }])
  })

  it('never revises on overlapping evidence: the same source twice does not inflate confidence', () => {
    const s = fresh()
    const ev = [{ agent: 'turn', n: 7 }]
    s.addBelief('b1', 'fact', 'Lives by the sea', { f: 1, c: 0.6 }, { at: 10, evidence: ev })
    const again = ok(s.addBelief('b1', 'fact', 'Lives by the sea', { f: 1, c: 0.6 }, { at: 11, evidence: ev })) as Integrated
    expect(again.outcome).toBe('kept')
    expect(again.after.stv).toEqual({ f: 1, c: 0.6 })
    const stronger = ok(s.reviseBelief('b1', { f: 1, c: 0.8 }, { at: 12, evidence: ev })) as Integrated
    expect(stronger.outcome).toBe('chosen')
    expect(stronger.after.stv).toEqual({ f: 1, c: 0.8 })
    expect(s.belief('b1')!.stv.c).toBe(0.8)
  })

  it('refuses the same id with other words, and checks its arguments', () => {
    const s = fresh()
    s.addBelief('b1', 'fact', 'one', { f: 1, c: 0.5 })
    expect(s.addBelief('b1', 'fact', 'two', { f: 1, c: 0.5 })).toEqual({ ok: false, refused: 'id-conflict' })
    expect(() => s.addBelief('b 2', 'fact', 'x', { f: 1, c: 0.5 })).toThrow(MindError)
    expect(() => s.addBelief('b2', 'Fact!', 'x', { f: 1, c: 0.5 })).toThrow(MindError)
    expect(() => s.addBelief('b2', 'fact', 'x', { c: 0.5 } as never)).toThrow(/frequency must be given/)
    expect(() => s.addBelief('b2', 'fact', 'x', { f: 1, c: 1 })).toThrow(/confidence/)
    expect(() => s.addBelief('b2', 'fact', '', { f: 1, c: 0.5 })).toThrow(MindError)
    expect(s.reviseBelief('nope', { f: 1, c: 0.5 })).toEqual({ ok: false, refused: 'unknown' })
  })

  it('keeps words with quotes, newlines and MeTTa syntax as one string', () => {
    const s = fresh()
    const words = 'He said "(= (x) y)" !(add-atom &mind (Evil))\nand $var'
    s.addBelief('b1', 'fact', words, { f: 1, c: 0.5 })
    expect(s.belief('b1')!.statement).toBe(words)
    const back = MindCore.restore(s.export(), { now: () => clock })
    expect(back.belief('b1')!.statement).toBe(words)
    expect(back.stats().beliefs).toBe(1)
  })
})

describe('r2: one carrier with the minds (Platform plan R2 §4.1)', () => {
  it('beliefs are (Current (Belief id) ...), memories (Current (Memory id) ...), both with (Said id kind text at)', () => {
    const s = fresh()
    ok(s.addBelief('b1', 'preference', 'likes tea', { f: 0.8, c: 0.5 }, { at: 10, evidence: [{ agent: 'turn', n: 1 }] }))
    ok(s.remember('m1', 'exchange', 'we talked about tea', SAID, { at: 10, evidence: [{ agent: 'turn', n: 1 }] }))
    const text = s.export()
    expect(text).toContain('(Current (Belief "b1") (stv 0.8 0.5) ((ev "turn" 1)))')
    expect(text).toContain('(Current (Memory "m1") (stv 1 0.9) ((ev "turn" 1)))')
    expect(text).toContain('(Said "b1" "preference" "likes tea" 10)')
    expect(text).toContain('(Said "m1" "exchange" "we talked about tea" 10)')
    expect(text).toMatch(/\(Words "m1" "[0-9a-f]{64}"\)/)
    expect(s.stats()).toMatchObject({ beliefs: 1, memories: 1 })
    expect(s.belief('m1')).toMatchObject({ type: 'memory', kind: 'exchange' })
    // recall covers both, each with its truth and stamp
    const r = s.recall('tea', 5)
    expect(r.items.map((i) => [i.id, i.type]).sort()).toEqual([['b1', 'belief'], ['m1', 'memory']])
    // one id is one thing
    expect(s.remember('b1', 'exchange', 'likes tea', SAID)).toEqual({ ok: false, refused: 'id-taken' })
    expect(s.addBelief('m1', 'fact', 'we talked about tea', SAID)).toEqual({ ok: false, refused: 'id-taken' })
    // memories revise by the same law, on disjoint evidence only
    expect(ok(s.reviseBelief('m1', { f: 1, c: 0.5 }, { evidence: [{ agent: 'turn', n: 1 }] })).outcome).toBe('kept')
    expect(ok(s.reviseBelief('m1', { f: 1, c: 0.5 }, { evidence: [{ agent: 'turn', n: 2 }] })).outcome).toBe('revised')
  })

  it('evidence contract: a missing evidence id is minted and flagged; strictEvidence refuses', () => {
    const s = fresh()
    const a = ok(s.addBelief('b1', 'fact', 'x', { f: 1, c: 0.5 }))
    expect(a.minted).toBe(true)
    expect(a.warning).toMatch(/counts as new evidence/)
    // the same source again without its evidence revises (the hazard the warning names)
    expect(ok(s.addBelief('b1', 'fact', 'x', { f: 1, c: 0.5 })).outcome).toBe('revised')
    const b = ok(s.addBelief('b2', 'fact', 'y', { f: 1, c: 0.5 }, { evidence: [{ agent: 'src', n: 4 }] }))
    expect(b.minted).toBeUndefined()
    expect(() => s.addBelief('b3', 'fact', 'z', { f: 1, c: 0.5 }, { strictEvidence: true })).toThrow(/evidence is required/)
  })
})

describe('forgetting', () => {
  it('forget removes everything held for the id, and refuses it again', () => {
    const s = fresh()
    s.addBelief('b1', 'fact', 'Has a dog called Rex', { f: 1, c: 0.5 }, { at: 10 })
    expect(ok(s.forget('b1', { at: 20 })).removed).toBeGreaterThanOrEqual(3)
    expect(s.belief('b1')).toBeNull()
    expect(s.vectors.has('b1')).toBe(false)
    expect(s.addBelief('b1', 'fact', 'Has a dog called Rex', { f: 1, c: 0.5 }, { at: 30 })).toEqual({ ok: false, refused: 'forgotten' })
    expect(s.recall('dog Rex', 5).items).toEqual([])
  })

  it('forgotten words stay refused under another id when their evidence is older than the forget', () => {
    const s = fresh()
    s.addBelief('b1', 'fact', 'Has a dog called Rex', { f: 1, c: 0.5 }, { at: 10 })
    s.forget('b1', { at: 20 })
    expect(s.addBelief('b2', 'fact', '  has a DOG called rex. ', { f: 1, c: 0.5 }, { at: 15 })).toEqual({ ok: false, refused: 'forgotten' })
    expect(s.remember('x1', 'exchange', 'has a dog called rex', SAID, { at: 20 })).toEqual({ ok: false, refused: 'forgotten' })
    // said again after the forget: new evidence, learned
    expect(s.addBelief('b2', 'fact', 'Has a dog called Rex', { f: 1, c: 0.5 }, { at: 25 }).ok).toBe(true)
  })

  it('forgetting words also forgets them where they are held under another id', () => {
    const s = fresh()
    s.remember('x1', 'exchange', 'My password hint is blue', SAID, { at: 5, turn: 't1' })
    s.addBelief('b1', 'fact', 'my password hint is blue.', { f: 1, c: 0.5 }, { at: 6, turn: 't1' })
    s.addBelief('b2', 'fact', 'my password hint is blue', { f: 1, c: 0.5 }, { at: 40 })
    const r = ok(s.forget('b1', { at: 20 }))
    expect(r.alsoForgot).toEqual(['x1'])
    expect(s.belief('b2')).not.toBeNull()
    expect(s.vectors.has('x1')).toBe(false)
  })

  it('forget everything sets a watermark that refuses older evidence and keeps tombstones', () => {
    const s = fresh()
    s.addBelief('b1', 'fact', 'one', { f: 1, c: 0.5 }, { at: 10 })
    s.remember('x1', 'exchange', 'hello', SAID, { at: 11, turn: 't1' })
    s.forget('b0', { at: 12 })
    const r = ok(s.forgetAll({ at: 50 }))
    expect(r.watermark).toBe(50)
    expect(s.stats()).toMatchObject({ beliefs: 0, memories: 0, tombstones: 1, watermark: 50 })
    expect(s.addBelief('b2', 'fact', 'two', { f: 1, c: 0.5 }, { at: 49 })).toEqual({ ok: false, refused: 'forgotten' })
    expect(s.addBelief('b2', 'fact', 'two', { f: 1, c: 0.5 }, { at: 51 }).ok).toBe(true)
    // the watermark only moves forward
    expect(ok(s.forgetAll({ at: 40 })).watermark).toBe(50)
  })
})

describe('recall', () => {
  it('ranks by similarity, truth expectation and attention, from held atoms only', () => {
    const s = fresh()
    s.addBelief('b1', 'preference', 'prefers short answers', { f: 0.9, c: 0.8 }, { at: 10 })
    s.addBelief('b2', 'preference', 'prefers short answers in the morning', { f: 0.1, c: 0.8 }, { at: 10 })
    s.addBelief('b3', 'place', 'lives in Lisbon', { f: 1, c: 0.9 }, { at: 10 })
    s.remember('x1', 'exchange', 'keep answers short please', SAID, { at: 10, turn: 't1' })
    const r = s.recall('short answers', 3, { now: 100 })
    expect(r.items.map((i) => i.id)).toContain('b1')
    expect(r.items.find((i) => i.id === 'b3')).toBeUndefined()
    const b1 = r.items.find((i) => i.id === 'b1')!
    const b2 = r.items.find((i) => i.id === 'b2')
    expect(b1.stv).toEqual({ f: 0.9, c: 0.8 })
    if (b2) expect(b1.score).toBeGreaterThan(b2.score)
    // score = sim * (0.5 + 0.5 * E) + 0.05 * attention, E = c (f - 0.5) + 0.5
    const E = 0.8 * (0.9 - 0.5) + 0.5
    expect(b1.score).toBeCloseTo(b1.similarity * (0.5 + 0.5 * E), 10)
    for (let i = 1; i < r.items.length; i++) expect(r.items[i - 1].score).toBeGreaterThanOrEqual(r.items[i].score)
  })

  it('attention: use promotes (+1, decaying as the minds\' promotion)', () => {
    const s = fresh()
    s.addBelief('b1', 'fact', 'tea in the afternoon', { f: 1, c: 0.5 }, { at: 0 })
    expect(ok(s.use('b1', { at: 0 })).attention).toBe(1)
    const r = s.recall('tea afternoon', 1, { now: 86400 })
    expect(r.items[0].attention).toBeCloseTo(Math.pow(2, -0.7), 10)
    expect(s.use('nope')).toEqual({ ok: false, refused: 'unknown' })
  })

  it('leaves out beliefs below the confidence floor', () => {
    const s = fresh()
    s.addBelief('b1', 'fact', 'maybe likes jazz', { f: 1, c: 0.01 }, { at: 0 })
    expect(s.recall('jazz', 5).items).toEqual([])
    expect(s.recall('jazz', 5, { minConfidence: 0.001 }).items).toHaveLength(1)
  })
})

describe('history', () => {
  it('explains a belief: its events, and the exchange of the turn it was learned in', () => {
    const s = fresh()
    s.remember('x1', 'exchange', 'I moved to Porto last year', SAID, { at: 10, turn: 't1' })
    s.addBelief('b1', 'place', 'lives in Porto', { f: 1, c: 0.6 }, { at: 10, turn: 't1' })
    s.reviseBelief('b1', { f: 1, c: 0.5 }, { at: 20, turn: 't2' })
    s.forget('x1', { at: 30 })
    const e = s.explain('b1')
    expect(e.held).toBe(true)
    expect(e.events.map((x) => x.op)).toEqual(['learned', 'adopted', 'revised'])
    expect(e.linked).toEqual([{ turn: 't1', id: 'x1', held: false }])
    // the journal keeps no words
    expect(s.export().split('\n').filter((l) => l.startsWith('(History')).join('\n')).not.toMatch(/Porto/)
  })
})

describe('inference (lib_pln)', () => {
  it('deduction with its trace', () => {
    const s = fresh()
    const t = ok(s.infer({ link: 'Inheritance', from: 'A', to: 'B', stv: { f: 0.9, c: 0.9 } }, { link: 'Inheritance', from: 'B', to: 'C', stv: { f: 0.8, c: 0.9 } }))
    expect(t.conclusions).toHaveLength(1)
    const c = t.conclusions[0]
    expect(c).toMatchObject({ rule: 'deduction', formula: 'Truth__Deduction', link: 'Inheritance', from: 'A', to: 'C' })
    expect(c.inputs.priors).toEqual({ A: { f: 0.1, c: 0.9 }, B: { f: 0.1, c: 0.9 }, C: { f: 0.1, c: 0.9 } })
    // sAB*sBC + (1-sAB)(sC - sB*sBC)/(1-sB) = 0.72 + 0.1*(0.1-0.08)/0.9; c = sAB*sBC*cAB*cBC
    expect(c.stv.f).toBeCloseTo(0.72 + (0.1 * 0.02) / 0.9, 12)
    expect(c.stv.c).toBeCloseTo(0.72 * 0.81, 12)
  })

  it('induction and abduction, and premises from held beliefs', () => {
    const s = fresh()
    s.addBelief('cat-animal', 'fact', 'cats are animals', { f: 0.9, c: 0.9 })
    const ind = ok(s.infer({ link: 'Inheritance', from: 'A', to: 'B', belief: 'cat-animal' }, { link: 'Inheritance', from: 'A', to: 'C', stv: { f: 0.8, c: 0.9 } }))
    expect(ind.premises[0].stv).toEqual({ f: 0.9, c: 0.9 })
    expect(ind.conclusions[0]).toMatchObject({ rule: 'induction', from: 'B', to: 'C' })
    const abd = ok(s.infer({ link: 'Inheritance', from: 'A', to: 'C', stv: { f: 0.9, c: 0.9 } }, { link: 'Inheritance', from: 'B', to: 'C', stv: { f: 0.8, c: 0.9 } }))
    expect(abd.conclusions[0]).toMatchObject({ rule: 'abduction', from: 'A', to: 'B' })
    expect(s.infer({ link: 'Inheritance', from: 'A', to: 'B', belief: 'gone' }, { link: 'Inheritance', from: 'B', to: 'C', stv: { f: 1, c: 0.5 } }))
      .toMatchObject({ ok: false, refused: 'unknown' })
    expect(ok(s.infer({ link: 'Inheritance', from: 'A', to: 'B', stv: { f: 1, c: 0.5 } }, { link: 'Inheritance', from: 'X', to: 'Y', stv: { f: 1, c: 0.5 } })).conclusions).toEqual([])
  })
})

describe('the file', () => {
  it('round-trips through export and restore', () => {
    const s = fresh()
    s.addBelief('b1', 'fact', 'one', { f: 0.7, c: 0.4 }, { at: 10, turn: 't1' })
    s.reviseBelief('b1', { f: 0.1, c: 0.2 }, { at: 11 })
    s.remember('x1', 'exchange', 'hello there', SAID, { at: 12, turn: 't1' })
    s.forget('b9', { at: 13 })
    s.use('b1', { at: 14 })
    const text = s.export()
    expect(text.startsWith('; omegahive-mind-space 1\n')).toBe(true)
    const back = MindCore.restore(text, { now: () => clock })
    expect(back.export()).toBe(text)
    expect(back.belief('b1')).toEqual(s.belief('b1'))
    expect(back.recall('hello', 2).items.map((i) => i.id)).toEqual(['x1'])
    // new evidence after restore continues the counter: never minted twice
    const r = ok(back.reviseBelief('b1', { f: 1, c: 0.3 })) as Integrated
    expect(r.outcome).toBe('revised')
  })

  it('refuses files that are not a mind space, or of another version, or with unknown atoms', () => {
    const s = fresh()
    expect(() => s.import('(Said "b1")')).toThrow(/not a mind space/)
    expect(() => s.import('; omegahive-mind-space 2\n')).toThrow(/version/)
    expect(() => s.import('; omegahive-mind-space 1\n(= (evil) 1)\n')).toThrow(/unexpected atom/)
    expect(() => s.import('; omegahive-mind-space 1\n(Said "b1" "fact" "x" "fp" &mind)\n')).toThrow(/unexpected atom/)
    // r2: an imported truth value keeps the API's bounds
    for (const tv of ['(stv 1.5 0.5)', '(stv -0.1 0.5)', '(stv 0.5 1)', '(stv 0.5 0)', '(stv 0.5 1.2)'])
      expect(() => s.import(`; omegahive-mind-space 1\n(Current (Belief "b1") ${tv} ((ev "m" 1)))\n`), tv).toThrow(/unexpected atom/)
  })

  it('import is a union: the same file twice changes nothing, its evidence is not counted twice', () => {
    const a = fresh()
    a.addBelief('b1', 'fact', 'one', { f: 1, c: 0.5 }, { at: 10 })
    const file = a.export()
    const b = fresh()
    const r1 = b.import(file, { at: 20 })
    expect(r1.beliefs).toEqual({ merged: 1, skipped: 0 })
    const once = b.belief('b1')
    b.import(file, { at: 21 })
    expect(b.belief('b1')).toEqual(once)
    a.import(file, { at: 22 })
    expect(a.belief('b1')!.stv).toEqual({ f: 1, c: 0.5 })
  })

  it('import revises a shared belief on disjoint evidence from another copy', () => {
    const a = MindCore.create({ self: 'm-a', salt: 'salt-a', now: () => clock })
    const b = MindCore.create({ self: 'm-b', salt: 'salt-b', now: () => clock })
    a.addBelief('b1', 'fact', 'one', { f: 1, c: 0.5 }, { at: 10 })
    b.addBelief('b1', 'fact', 'one', { f: 0, c: 0.5 }, { at: 10 })
    b.import(a.export(), { at: 20 })
    expect(b.belief('b1')!.stv).toEqual({ f: 0.5, c: 2 / 3 })
    expect(b.belief('b1')!.stamp).toHaveLength(2)
  })

  it('tombstones and the watermark win in both directions, across salts', () => {
    const a = MindCore.create({ self: 'm-a', salt: 'salt-a', now: () => clock })
    const b = MindCore.create({ self: 'm-b', salt: 'salt-b', now: () => clock })
    a.addBelief('b1', 'fact', 'secret words', { f: 1, c: 0.5 }, { at: 10 })
    a.addBelief('b2', 'fact', 'kept words', { f: 1, c: 0.5 }, { at: 10 })
    b.addBelief('other-id', 'fact', 'Secret words.', { f: 1, c: 0.5 }, { at: 10 })
    a.forget('b1', { at: 30 })
    // b holds the forgotten words under another id and salt: merging a's tombstone purges them
    const r = b.import(a.export(), { at: 40 })
    expect(r.purged).toEqual(['other-id'])
    expect(b.belief('other-id')).toBeNull()
    expect(b.belief('b2')).not.toBeNull()
    // an old copy (from before the forget) cannot bring them back
    const old = MindCore.create({ self: 'm-c', salt: 'salt-c', now: () => clock })
    old.addBelief('b1', 'fact', 'secret words', { f: 1, c: 0.5 }, { at: 10 })
    old.addBelief('b3', 'fact', 'secret words', { f: 1, c: 0.5 }, { at: 11 })
    const r2 = a.import(old.export(), { at: 50 })
    expect(r2.beliefs.merged).toBe(0)
    expect(a.belief('b1')).toBeNull()
    expect(a.belief('b3')).toBeNull()
    // forget everything travels too
    a.forgetAll({ at: 60 })
    const c = fresh()
    c.addBelief('b5', 'fact', 'from before', { f: 1, c: 0.5 }, { at: 55 })
    c.addBelief('b6', 'fact', 'from after', { f: 1, c: 0.5 }, { at: 65 })
    const r3 = c.import(a.export(), { at: 70 })
    expect(r3.watermark).toBe(60)
    expect(r3.purged).toEqual(['b5'])
    expect(c.belief('b6')).not.toBeNull()
    expect(c.export()).toMatch(/\(Forgotten "b1" "/)
  })
})
