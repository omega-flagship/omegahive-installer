import { describe, expect, it } from 'vitest'
import type { ProgramDescription, WorkGraph } from '../../api/types'
import { navFor, surfaceOf, HOME } from './ask'
import { askBound, isConsequential, outcomeWords, seenOf, type Ask } from './gate'
import { BARE, buildSky, compareSides, constellationsFor, expectation, kindsOf, labelBox, labelled, LONE, matches, MIN_GAP, placeStars, readStatement, starLabel, termsOf, truthWords, unfold } from './model'
import { commonsGrammar, paletteFor } from './palette'
import { FORMS, formFor, NATIVE_GRAMMARS } from '../contract'

/** INVENTED data in the shape commons_explorer/program.py returns (describe, overview, one belief, compare). */
const DESCRIBE: ProgramDescription = {
  contract: '0.1',
  kinds: [
    { id: 'question', label: 'Question', role: 'question' },
    { id: 'belief', label: 'Shared belief', role: 'claim' },
    { id: 'report', label: 'Report', role: 'evidence' },
    { id: 'rival', label: 'Rival belief', role: 'hypothesis' },
    { id: 'gap', label: 'Missing research', role: 'gap' },
  ],
  relations: [
    { id: 'answers', polarity: 'neutral' },
    { id: 'supports', polarity: 'support' },
    { id: 'contradicts', polarity: 'oppose' },
    { id: 'rivals', polarity: 'oppose' },
    { id: 'shares-term', polarity: 'neutral' },
    { id: 'qualifies', polarity: 'qualify' },
  ],
  actions: [
    { id: 'inspect-source', label: 'Open source', applies_to: ['report'] },
    { id: 'compare', label: 'Compare', applies_to: ['belief', 'rival'], stage: 'compare' },
    { id: 'challenge', label: 'Look for counterevidence', applies_to: ['belief', 'rival'] },
    { id: 'investigate-gap', label: 'Research this', applies_to: ['gap'] },
  ],
}

const nal = (f: number, c: number) => ({ method: 'nal', f, c })
const belief = (s: string, f: number, c: number, sources: string[], kind = 'belief') => ({
  id: `b:${s}`,
  kind,
  label: s,
  uncertainty: nal(f, c),
  sources: sources.map((a) => ({ id: `dot:${a}`, label: a, kind: 'dot', status: 'cited', origin: `dot:${a}` })),
  weight: c,
  meta: { stamp: ['e1'], independent_sources: sources.length },
})

const OVERVIEW: WorkGraph = {
  revision: 'c-aaaa',
  focus: 'overview',
  title: 'What does Testbed believe?',
  items: [
    { id: 'overview', kind: 'question', label: 'What does Testbed believe?', text: '5 shared beliefs in this swarm’s commons.' },
    belief('(--> glim bright)', 0.95, 0.85, ['Ash', 'Birch']),
    belief('(--> glim distant)', 0.3, 0.6, ['Ash']),
    belief('(--> (× glim dust) has)', 0.5, 0.7, ['Ash', 'Cedar']),
    belief('(==> (--> $x bright) (--> $x hot))', 0.9, 0.3, ['Birch', 'Cedar']),
    belief('(--> zorp lonely)', 0.8, 0.5, ['Ash']),
    { id: 'gap:single:(--> glim distant)', kind: 'gap', label: 'Only one independent source for (--> glim distant)', meta: { statement: '(--> glim distant)', reason: 'single' } },
    { id: 'gap:ambiguous:(--> (× glim dust) has)', kind: 'gap', label: 'Evidence is split on (--> (× glim dust) has)', meta: { statement: '(--> (× glim dust) has)', reason: 'ambiguous' } },
    { id: 'gap:weak:(==> (--> $x bright) (--> $x hot))', kind: 'gap', label: 'Low confidence in …', meta: { reason: 'weak' } },
    { id: 'gap:single:(--> zorp lonely)', kind: 'gap', label: 'Only one independent source for (--> zorp lonely)', meta: { reason: 'single' } },
  ],
  links: [
    { id: 'l1', from: 'gap:single:(--> glim distant)', to: 'b:(--> glim distant)', rel: 'qualifies' },
    { id: 'l2', from: 'gap:ambiguous:(--> (× glim dust) has)', to: 'b:(--> (× glim dust) has)', rel: 'qualifies' },
    { id: 'l3', from: 'gap:weak:(==> (--> $x bright) (--> $x hot))', to: 'b:(==> (--> $x bright) (--> $x hot))', rel: 'qualifies' },
    { id: 'l4', from: 'gap:single:(--> zorp lonely)', to: 'b:(--> zorp lonely)', rel: 'qualifies' },
  ],
  groups: [
    { id: 'agreement', label: 'Well supported', items: ['b:(--> glim bright)'] },
    { id: 'gap', label: 'Missing research', items: ['gap:single:(--> glim distant)'] },
  ],
  notes: [],
}

const report = (s: string, n: number, who: string, f: number, c: number, stamp: string[], outcome = 'revised') => ({
  id: `r:${s}:${n}`,
  kind: 'report',
  label: `${who} reported f=${f} c=${c}`,
  uncertainty: nal(f, c),
  at: '2026-10-01T10:00:00Z',
  sources: [{ id: `dot:${who}`, label: who, kind: 'dot', status: 'cited', origin: `stamp:${stamp.join(',')}`, locator: `evidence ${stamp.join(', ')}` }],
  status: outcome === 'kept' || outcome === 'denied' ? 'superseded' : 'current',
  meta: { outcome, stamp },
})

const S = '(--> glim bright)'
const ONE: WorkGraph = {
  revision: 'c-aaaa',
  focus: `b:${S}`,
  title: S,
  items: [
    belief(S, 0.95, 0.85, ['Ash', 'Birch']),
    report(S, 0, 'Ash', 0.96, 0.6, ['e1']),
    report(S, 1, 'Birch', 0.94, 0.6, ['e1']),
    report(S, 2, 'Cedar', 0.2, 0.4, ['e9'], 'kept'),
    belief('(--> glim distant)', 0.3, 0.6, ['Ash'], 'rival'),
  ],
  links: [
    { id: 'a', from: `r:${S}:0`, to: `b:${S}`, rel: 'supports' },
    { id: 'b', from: `r:${S}:1`, to: `b:${S}`, rel: 'supports' },
    { id: 'c', from: `r:${S}:2`, to: `b:${S}`, rel: 'contradicts' },
    { id: 'd', from: 'b:(--> glim distant)', to: `b:${S}`, rel: 'rivals' },
  ],
  groups: [{ id: 'agreement', items: [`b:${S}`] }],
  notes: ['Reports from minds that share evidence carry the same origin; they are not independent.'],
}

describe('statements', () => {
  it('reads terms the way the program does (operators and numbers are not terms)', () => {
    expect(termsOf('(--> rr-lyrae variable)')).toEqual(['rr-lyrae', 'variable'])
    expect(termsOf('(--> (× vega dust) has)')).toEqual(['vega', 'dust', 'has'])
    expect(termsOf('(--> x 3)')).toEqual(['x'])
    expect(termsOf('(((')).toEqual([])
  })
  it('gives the shared plain reading (uifix-r3), and an unreadable form never gets a guessed sentence', () => {
    expect(readStatement('(--> vega star)')).toBe('Vega is a star')
    expect(readStatement('(--> (× urchin kelp) grazes)')).toBe('Urchin grazes kelp')
    expect(readStatement('(--> altair (× rotates fast))')).toBe('Altair rotates fast')
    expect(readStatement('(==> (--> $x cepheid) (--> $x periodic))')).toBe('If something is a cepheid, then it is periodic')
    expect(readStatement('(==> warm-water (--> kelp stressed))')).toBe('If ‘warm-water’, then kelp is stressed') // uifix-r3.4: a multi-piece atom is one name
    expect(readStatement('(--> a')).toBe('A belief about a') // uifix-r3.4: one simple token reads as a word, no word list
  })
})

describe('truth', () => {
  it('words and expectation', () => {
    expect(truthWords({ f: 0.95, c: 0.85 })).toBe('Near certain')
    expect(truthWords({ f: 0.5, c: 0.3 })).toBe('Tentative')
    expect(truthWords(null)).toBe('Not assessed')
    expect(expectation({ f: 1, c: 1 })).toBe(1)
    expect(expectation({ f: 0, c: 0 })).toBe(0.5)
  })
})

describe('the sky', () => {
  const sky = buildSky(OVERVIEW, DESCRIBE)
  it('takes beliefs, gaps and "well supported" from the program, not from its own rules', () => {
    expect(sky.question).toBe('What does Testbed believe?')
    expect(sky.stars).toHaveLength(5)
    expect(sky.well).toBe(1)
    expect(sky.stars.find((s) => s.statement === S)!.well).toBe(true)
    expect(sky.gaps).toHaveLength(4)
    expect(sky.stars.find((s) => s.statement === '(--> glim distant)')!.gaps.map((g) => g.reason)).toEqual(['single'])
    expect(sky.stars.find((s) => s.statement === S)!.independent).toBe(2)
  })
  it('draws beliefs that share a term as one constellation; a belief sharing nothing is a lone star', () => {
    const where = constellationsFor(OVERVIEW.items.filter((i) => i.kind === 'belief').map((i) => i.label))
    expect(where.get(S)).toBe('glim')
    expect(where.get('(--> (× glim dust) has)')).toBe('glim')
    // shares only "bright" (with a belief drawn under glim); $x is never a term; a constellation of one is a lone star
    expect(where.get('(==> (--> $x bright) (--> $x hot))')).toBe(LONE)
    expect(where.get('(--> zorp lonely)')).toBe(LONE)
    expect(sky.constellations.at(-1)!.id).toBe(LONE)
    expect(sky.constellations[0].name).toBe('glim')
  })
  it('filters and searches', () => {
    const s = sky.stars
    expect(s.filter((x) => matches(x, 'well', '')).map((x) => x.statement)).toEqual([S])
    expect(s.filter((x) => matches(x, 'split', '')).map((x) => x.statement)).toEqual(['(--> (× glim dust) has)'])
    expect(s.filter((x) => matches(x, 'gaps', '')).length).toBe(4)
    expect(s.filter((x) => matches(x, 'all', 'glim has')).map((x) => x.statement)).toEqual(['(--> (× glim dust) has)'])
    expect(s.filter((x) => matches(x, 'all', 'cedar')).length).toBe(2)
  })
  it('labels a star in words (nothing by colour or size alone)', () => {
    const l = starLabel(sky.stars.find((x) => x.statement === '(--> glim distant)')!)
    expect(l).toContain('Glim is distant')
    expect(l).not.toMatch(/\bf 0\.|-->/)
    expect(l).toContain('1 independent source')
    expect(l).toContain('missing research: rests on one independent source')
  })
  it('an empty commons is an empty sky, with the program’s note', () => {
    const empty = buildSky({ revision: 'c-0', items: [{ id: 'overview', kind: 'question', label: 'What does X believe?' }], links: [], groups: [], notes: ['empty'] }, DESCRIBE)
    expect(empty.stars).toEqual([])
    expect(empty.notes).toEqual(['empty'])
  })
  it('follows kinds by role when a program names them differently', () => {
    const k = kindsOf({ ...DESCRIBE, kinds: DESCRIBE.kinds.map((x) => (x.role === 'claim' ? { ...x, id: 'shared' } : x)) })
    expect(k.belief).toBe('shared')
  })
})

describe('placement', () => {
  for (const width of [200, 330, 390, 520, 900]) {
    for (const n of [1, 2, 5, 9, 17, 40]) {
      const ids = Array.from({ length: n }, (_, i) => `b:(--> s${i} p)`)
      it(`${n} bare stars in ${width}px: inside the field, never closer than ${MIN_GAP}px`, () => {
        const { at, height } = placeStars(ids, width, BARE)
        for (const p of at) {
          expect(p.x).toBeGreaterThanOrEqual(22)
          expect(p.x).toBeLessThanOrEqual(width - 22)
          expect(p.y).toBeGreaterThanOrEqual(22)
          expect(p.y).toBeLessThanOrEqual(height - 22)
        }
        for (let i = 0; i < at.length; i++)
          for (let j = i + 1; j < at.length; j++) expect(Math.hypot(at[i].x - at[j].x, at[i].y - at[j].y)).toBeGreaterThanOrEqual(MIN_GAP)
      })
      it(`${n} labelled stars in ${width}px: no star or label box touches another, all inside`, () => {
        const sp = labelled(width)
        const lb = labelBox(sp)
        const { at, height } = placeStars(ids, width, sp)
        // a star's box (its 44px target) plus the label under it
        const box = (p: { x: number; y: number }) => ({ l: p.x - Math.max(22, lb.w / 2), r: p.x + Math.max(22, lb.w / 2), t: p.y - 22, b: p.y + lb.dy + lb.h })
        for (const p of at) {
          const b = box(p)
          expect(b.t).toBeGreaterThanOrEqual(0)
          expect(b.b).toBeLessThanOrEqual(height)
          if (width >= sp.col + 2 * sp.pad) {
            expect(b.l).toBeGreaterThanOrEqual(0)
            expect(b.r).toBeLessThanOrEqual(width)
          }
        }
        for (let i = 0; i < at.length; i++)
          for (let j = i + 1; j < at.length; j++) {
            const a = box(at[i])
            const b = box(at[j])
            const apart = a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t
            expect(apart).toBe(true)
          }
      })
    }
  }
  it('is stable for the same stars', () => {
    expect(placeStars(['a', 'b', 'c'], 400)).toEqual(placeStars(['a', 'b', 'c'], 400))
  })
})

describe('a belief unfolded', () => {
  const u = unfold(ONE, `b:${S}`, DESCRIBE)!
  it('lists the reports behind it, for and against, and marks echoes (shared evidence is not independent)', () => {
    expect(u.reports).toHaveLength(3)
    expect(u.forCount).toBe(2)
    expect(u.againstCount).toBe(1)
    expect(u.origins).toBe(2)
    expect(u.reports[0].echoes).toBe(1)
    expect(u.reports[2].echoes).toBe(0)
    expect(u.reports[2].superseded).toBe(true)
    expect(u.reports[0].locator).toBe('evidence e1')
  })
  it('lists its rivals and the program’s notes', () => {
    expect(u.rivals.map((r) => r.statement)).toEqual(['(--> glim distant)'])
    expect(u.notes[0]).toMatch(/not independent/)
  })
  it('is null for a graph about something else', () => {
    expect(unfold(OVERVIEW, 'b:nothing', DESCRIBE)).toBeNull()
  })
  it('compares sides in the order asked', () => {
    const sides = compareSides(ONE, ['b:(--> glim distant)', `b:${S}`], DESCRIBE)
    expect(sides.map((x) => x.star.statement)).toEqual(['(--> glim distant)', S])
    expect(sides[1].forCount).toBe(2)
    expect(sides[1].againstCount).toBe(1)
    expect(sides[1].rivals).toBe(1)
  })
})

describe('the confirm binding (drift)', () => {
  const u = unfold(ONE, `b:${S}`, DESCRIBE)!
  const ask: Ask = { action: 'challenge', target: `b:${S}`, belief: `b:${S}`, seen: seenOf(u, 'challenge', `b:${S}`)!, sources: ['Ash', 'Birch'], seq: 1 }
  it('only challenge and investigate-gap need a confirm; reads run at once', () => {
    expect(isConsequential('challenge')).toBe(true)
    expect(isConsequential('investigate-gap')).toBe(true)
    expect(isConsequential('compare')).toBe(false)
    expect(isConsequential('inspect-source')).toBe(false)
  })
  it('is ready while the record matches what was read', () => {
    expect(askBound(ask, u)).toEqual({ kind: 'ready' })
  })
  it('turns off and names what changed: truth, revision', () => {
    const moved: WorkGraph = { ...ONE, revision: 'c-bbbb', items: ONE.items.map((i) => (i.id === `b:${S}` ? { ...i, uncertainty: nal(0.9, 0.88) } : i)) }
    const b = askBound(ask, unfold(moved, `b:${S}`, DESCRIBE))
    expect(b).toEqual({ kind: 'changed', fields: ['truth', 'commons revision'] })
  })
  it('a newer commons alone is drift too (the program refuses any other revision)', () => {
    expect(askBound(ask, { ...u, revision: 'c-cccc' })).toEqual({ kind: 'changed', fields: ['commons revision'] })
  })
  it('a gap that is no longer there, or a belief that left, is gone', () => {
    const gapAsk: Ask = { action: 'investigate-gap', target: 'gap:single:x', belief: `b:${S}`, seen: { ...ask.seen }, sources: [], gap: { label: 'x', reason: 'single' }, seq: 2 }
    expect(askBound(gapAsk, u)).toEqual({ kind: 'gone' })
    expect(askBound(ask, null)).toEqual({ kind: 'gone' })
  })
  it('says what a result means', () => {
    expect(outcomeWords('started', 'posted goal g1 to the swarm').text).toBe('Posted goal g1 to the swarm.')
    expect(outcomeWords('stale').tone).toBe('bad')
    expect(outcomeWords('refused', 'choose a gap').text).toBe('Refused: choose a gap')
  })
})

describe('the commons in the form contract', () => {
  it('commons-explorer opens as the commons, never the case file', () => {
    expect(formFor('commons-explorer', DESCRIBE)).toBe('commons')
    expect(formFor('commons-explorer', null)).toBe('commons')
    expect(FORMS.commons).toBeDefined()
    expect(NATIVE_GRAMMARS.commons).toEqual(['classic', 'still', 'canvas'])
  })
  it('Cosmos, Flux and Construct fall back to classic; Canvas follows the board’s light or dark', () => {
    for (const g of ['cosmos', 'flux', 'construct', 'classic'] as const) expect(commonsGrammar(g)).toBe('classic')
    expect(commonsGrammar('still')).toBe('still')
    expect(commonsGrammar('canvas')).toBe('canvas')
    expect(paletteFor('canvas', 'dark')).toBe('canvas-dark')
    expect(paletteFor('canvas', 'light')).toBe('canvas-light')
    expect(paletteFor('still', 'dark')).toBe('still')
  })
})

describe('for the Ask layer: what the commons shows and can do, and navigation as state', () => {
  const sky = buildSky(OVERVIEW, DESCRIBE)
  const u = unfold(ONE, `b:${S}`, DESCRIBE)!
  it('the sky: visible beliefs, no acts (acts belong to an unfolded belief)', () => {
    const s = surfaceOf('commons-explorer', sky, { ...HOME, filter: 'gaps' }, null, DESCRIBE)
    expect(s.form).toBe('commons')
    expect(s.entities.map((e) => e.kind)).toEqual(['belief', 'belief', 'belief', 'belief'])
    expect(s.actions).toEqual([])
    expect(s.filters.map((f) => f.id)).toEqual(['all', 'well', 'split', 'gaps'])
  })
  it('a belief unfolded: its reports, rivals, gaps, and every act with its act id and whether it needs the host confirm', () => {
    const s = surfaceOf('commons-explorer', sky, { ...HOME, focus: `b:${S}` }, u, DESCRIBE)
    expect(s.nav.focus).toBe(`b:${S}`)
    expect(s.entities.filter((e) => e.kind === 'report')).toHaveLength(3)
    expect(s.actions.find((a) => a.act === 'challenge')).toEqual({ act: 'challenge', label: 'Look for counterevidence', items: [`b:${S}`], confirm: true })
    expect(s.actions.filter((a) => a.act === 'inspect-source').every((a) => !a.confirm)).toBe(true)
    expect(s.actions.find((a) => a.act === 'compare')!.items).toEqual([`b:${S}`, 'b:(--> glim distant)'])
  })
  it('acts the program does not declare are never offered', () => {
    const s = surfaceOf('commons-explorer', sky, { ...HOME, focus: `b:${S}` }, u, { ...DESCRIBE, actions: [] })
    expect(s.actions).toEqual([])
  })
  it('"show me the beliefs about X" is state: a search, and a focus when exactly one belief matches', () => {
    expect(navFor(sky, { about: 'glim' })).toEqual({ focus: null, filter: 'all', query: 'glim' })
    expect(navFor(sky, { about: 'zorp' })).toEqual({ focus: 'b:(--> zorp lonely)', filter: 'all', query: 'zorp' })
    expect(navFor(sky, { belief: S })).toEqual({ focus: `b:${S}`, filter: 'all', query: '' })
    expect(navFor(sky, { belief: '(--> nothing here)' }).focus).toBeNull()
    expect(navFor(sky, { filter: 'well' })).toEqual({ focus: null, filter: 'well', query: '' })
    expect(navFor(sky, {})).toEqual(HOME)
  })
})
