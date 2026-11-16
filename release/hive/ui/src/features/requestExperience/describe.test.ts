import { describe, expect, it } from 'vitest'
import { applyLookPatch, decide, lookCandidates, lookPatchProblem } from '../../lib/intent'
import { NAME_MAX, tagged } from '../../lib/intent/look'
import { legibilityProblems, wellFormed, isLightPage, ACCENTS, type AccentName } from '../../lib/intent/palette'
import type { LookPatch } from '../../lib/intent/types'
import { DEFAULT_VARIANT, SEED_VARIANTS, blockedReason } from '../../shell/uiVariant'
import { buildLook, describeLook, settleLooks, shortName } from './describe'

/** "Request an experience", step 1: words → a look patch, here and deterministically. Invented words only. */

const world = { minds: [], swarms: [], pending: 0, experiences: [{ id: 'classic', name: 'Classic hive' }, { id: 'still', name: 'Still' }], looks: SEED_VARIANTS.map((v) => ({ id: v.id, name: v.name })) }
const patches = (words: string) => describeLook(words, world).looks.map((l) => l.patch)

describe('words → look patches (the fast path’s own look vocabulary)', () => {
  it('reads a whole description, phrase by phrase', () => {
    expect(patches('calmer, warmer, bigger text')).toEqual([
      { kind: 'motion', motion: 'calm' },
      { kind: 'warmth', warmth: 'warmer' },
      { kind: 'density', density: 'roomy' },
    ])
  })
  it('reads the same words without commas, and with polite openings', () => {
    expect(patches('calmer warmer bigger text')).toEqual(patches('calmer, warmer, bigger text'))
    expect(patches('please make it calmer and warmer with bigger text')).toEqual(patches('calmer, warmer, bigger text'))
  })
  it.each<[string, LookPatch]>([
    ['cooler', { kind: 'warmth', warmth: 'cooler' }],
    ['warm colours', { kind: 'warmth', warmth: 'warmer' }],
    ['more contrast', { kind: 'contrast', contrast: 'more' }],
    ['easier to read', { kind: 'contrast', contrast: 'more' }],
    ['softer contrast', { kind: 'contrast', contrast: 'less' }],
    ['a teal accent', { kind: 'accent', accent: 'teal' }],
    ['gold highlights', { kind: 'accent', accent: 'amber' }],
    ['larger text', { kind: 'density', density: 'roomy' }],
    ['small text', { kind: 'density', density: 'compact' }],
    ['smaller text', { kind: 'density', density: 'compact' }],
    ['no motion', { kind: 'motion', motion: 'none' }],
    ['livelier', { kind: 'motion', motion: 'lively' }],
    ['darker', { kind: 'darker' }],
    ['rounder corners', { kind: 'radius', radius: 'round' }],
    ['navigation at the top', { kind: 'layout', layout: 'topbar' }],
    ['like ember forge', { kind: 'variant', id: 'ember-forge' }],
  ])('“%s”', (words, patch) => {
    expect(patches(words)).toEqual([patch])
  })
  it('the Ask understands the same new words, and runs them at once', () => {
    const one = (t: string) => lookCandidates(t, world).map((c) => (c.act?.do === 'look' ? c.act.patch : null))
    expect(one('make it warmer')).toEqual([{ kind: 'warmth', warmth: 'warmer' }])
    expect(one('bigger text')).toEqual([{ kind: 'density', density: 'roomy' }])
    expect(decide(lookCandidates('bigger text', world), { orchestrator: true }).kind).toBe('run')
  })
  it('the same words always make the same patch', () => {
    expect(describeLook('calmer, warmer, a blue accent', world)).toEqual(describeLook('calmer, warmer, a blue accent', world))
  })
})

describe('words that ask for more than a look', () => {
  it('“like a train timetable” needs a mind; the look part is still read', () => {
    const d = describeLook('calmer, warmer, bigger text, like a train timetable', world)
    expect(d.looks.map((l) => l.patch.kind)).toEqual(['motion', 'warmth', 'density'])
    expect(d.beyond).toEqual(['like a train timetable'])
  })
  it.each(['a new layout', 'make it a game', 'like a city', 'a kanban board of my swarms', 'a 3d map of the hive'])('“%s” needs a mind, and makes no look', (words) => {
    const d = describeLook(words, world)
    expect(d.looks).toEqual([])
    expect(d.beyond.length).toBeGreaterThan(0)
  })
  it('a mind-sized wish inside one phrase is split from the look words', () => {
    const d = describeLook('bigger text like a newspaper', world)
    expect(d.looks.map((l) => l.patch)).toEqual([{ kind: 'density', density: 'roomy' }])
    expect(d.beyond).toEqual(['like a newspaper'])
  })
  it('what this build cannot do is said plainly; an experience by name is pointed to, not switched', () => {
    const d = describeLook('lighter, switch to still', world)
    expect(d.looks).toEqual([])
    expect(d.cannot.map((c) => c.phrase)).toEqual(['lighter', 'switch to still'])
  })
  it('words that are not about the look are named back', () => {
    expect(describeLook('calmer, flibbertigibbet', world).unclear).toEqual(['flibbertigibbet'])
  })
})

describe('the look the words make', () => {
  it('is named from the words, applied in order, and keeps the experience the person is in', () => {
    const d = describeLook('calmer, warmer, bigger text', world)
    expect(shortName(d)).toBe('Calmer, warmer, bigger text')
    const p = buildLook({ variant: null, layout: null, apps: null, experience: 'still' }, d, DEFAULT_VARIANT, SEED_VARIANTS)!
    expect(p.variant?.name).toBe('My look: Calmer, warmer, bigger text')
    expect(p.variant?.id).toBe('my-calmer-warmer-bigger-text')
    expect(p.variant?.motion).toBe('calm')
    expect(p.variant?.density).toBe('roomy')
    expect(p.experience).toBe('still')
    expect(p.variant?.colors.void).not.toBe(DEFAULT_VARIANT.colors.void)
  })
  it('a named look comes first: “calmer, like ember forge” is Ember Forge, calmer', () => {
    const p = buildLook(null, describeLook('calmer, like ember forge', world), DEFAULT_VARIANT, SEED_VARIANTS)!
    const ember = SEED_VARIANTS.find((v) => v.id === 'ember-forge')!
    expect(p.variant?.colors).toEqual(ember.colors)
    expect(p.variant?.motion).toBe('calm')
  })
  it('never reuses an id already taken, and stays inside the host’s limits', () => {
    const d = describeLook('calmer and warmer and cooler and darker and more contrast and a pink accent and bigger text', world)
    const p = buildLook(null, d, DEFAULT_VARIANT, SEED_VARIANTS, ['my-calmer-warmer-cooler-darker'])!
    expect(p.variant!.id).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/)
    expect(p.variant!.id).not.toBe('my-calmer-warmer-cooler-darker')
    expect(p.variant!.name.length).toBeLessThanOrEqual(40)
    expect((p.variant!.blurb ?? '').length).toBeLessThanOrEqual(160)
  })
  it('no look words: no look', () => {
    expect(buildLook(null, describeLook('like a city', world), DEFAULT_VARIANT, SEED_VARIANTS)).toBeNull()
  })
})

describe('every colour move stays legible and well formed (the host’s floors)', () => {
  const moves: LookPatch[] = [
    { kind: 'warmth', warmth: 'warmer' },
    { kind: 'warmth', warmth: 'cooler' },
    { kind: 'contrast', contrast: 'more' },
    { kind: 'contrast', contrast: 'less' },
    ...(Object.keys(ACCENTS) as AccentName[]).map((accent) => ({ kind: 'accent', accent }) as LookPatch),
  ]
  const bases = [DEFAULT_VARIANT, ...SEED_VARIANTS.filter((v) => !blockedReason(v))]
  it.each(bases.map((b) => [b.id, b] as const))('from %s', (_id, base) => {
    for (const m of moves) {
      for (const twice of [1, 2]) {
        let p = applyLookPatch({ variant: base, layout: null }, m, DEFAULT_VARIANT, SEED_VARIANTS)
        if (twice === 2) p = applyLookPatch(p, m, DEFAULT_VARIANT, SEED_VARIANTS)
        expect(legibilityProblems(p.variant!.colors), `${base.id} ${JSON.stringify(m)}`).toEqual([])
        expect(wellFormed(p.variant!.colors)).toBe(true)
        expect(p.variant!.id).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/)
        expect(p.variant!.name.length).toBeLessThanOrEqual(40)
      }
    }
  })
  it('status colours never move', () => {
    const p = applyLookPatch(null, { kind: 'warmth', warmth: 'warmer' }, DEFAULT_VARIANT, SEED_VARIANTS)
    for (const k of ['good', 'warn', 'bad', 'accent-2'] as const) expect(p.variant!.colors[k]).toBe(DEFAULT_VARIANT.colors[k])
  })
})

describe('inherited names are not words (stand-in r1b P2)', () => {
  const odd = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'a constructor accent', 'toString highlights', 'accent __proto__', 'the valueOf', 'flibbertigibbet', 'zzz accent']
  it.each(odd)('“%s” makes no look patch and does not throw', (words) => {
    expect(() => lookCandidates(words, world)).not.toThrow()
    expect(lookCandidates(words, world).filter((c) => c.act?.do === 'look')).toEqual([])
    expect(() => describeLook(words, world)).not.toThrow()
    expect(describeLook(words, world).looks).toEqual([])
  })
  it('a whole description of them reads as nothing, and builds nothing', () => {
    const d = describeLook(odd.join(', '), world)
    expect(d.looks).toEqual([])
    expect(buildLook(null, d, DEFAULT_VARIANT, SEED_VARIANTS)).toBeNull()
  })
  it('an accent patch naming no accent (stored or hand-made) changes nothing and does not throw', () => {
    for (const accent of ['constructor', '__proto__', 'toString', 'nope'])
      expect(applyLookPatch({ variant: DEFAULT_VARIANT, layout: null }, { kind: 'accent', accent: accent as AccentName }, DEFAULT_VARIANT, SEED_VARIANTS).variant?.colors).toEqual(DEFAULT_VARIANT.colors)
  })
})

describe('Kimi K3: a named accent is the hue named, or a plain no', () => {
  const base = { variant: DEFAULT_VARIANT, layout: null }
  it.each(['dark purple', 'a deep blue accent', 'navy', 'maroon highlights', 'forest green'])('“%s” cannot be read on this build’s dark looks: said plainly, nothing applied', (words) => {
    const d = describeLook(words, world)
    expect(d.looks).toHaveLength(1)
    const settled = settleLooks(base, d, DEFAULT_VARIANT, SEED_VARIANTS)
    expect(settled.looks).toEqual([])
    expect(settled.cannot[0].text).toMatch(/^That dark (purple|blue|red|green) is too dark to read (on this page|buttons on); try a lighter (purple|blue|red|green)\.$/)
    expect(buildLook(base, settled, DEFAULT_VARIANT, SEED_VARIANTS)).toBeNull()
    // applied anyway (a stored patch): nothing changes, never a drifted colour
    const patch = d.looks[0].patch
    expect(applyLookPatch(base, patch, DEFAULT_VARIANT, SEED_VARIANTS).variant?.colors).toEqual(DEFAULT_VARIANT.colors)
    expect(lookPatchProblem(base, patch, DEFAULT_VARIANT)).toBe(settled.cannot[0].text)
  })
  // the light-token round added a light look (Paper Studio): a bright named accent is exact on every dark base, and on a
  // light page it is too light to read, so it is a plain no there (worded that way), and its deep version is exact
  const usable = [DEFAULT_VARIANT, ...SEED_VARIANTS.filter((s) => !blockedReason(s))]
  const darkBases = usable.filter((v) => !isLightPage(v.colors)), lightBases = usable.filter((v) => isLightPage(v.colors))
  it('this build has dark looks and at least one light one', () => {
    expect(darkBases.length).toBeGreaterThan(0)
    expect(lightBases.map((v) => v.id)).toContain('paper')
  })
  it.each(Object.keys(ACCENTS).filter((k) => !k.startsWith('deep-')) as AccentName[])('%s: the accent is exactly the named colour on every dark base; on a light one, a plain no', (name) => {
    for (const v of darkBases) {
      const p = applyLookPatch({ variant: v, layout: null }, { kind: 'accent', accent: name }, DEFAULT_VARIANT, SEED_VARIANTS)
      expect(p.variant!.colors.accent).toBe(ACCENTS[name])
      expect(legibilityProblems(p.variant!.colors)).toEqual([])
    }
    for (const v of lightBases) {
      const base = { variant: v, layout: null }
      expect(lookPatchProblem(base, { kind: 'accent', accent: name }, DEFAULT_VARIANT)).toBe(`That ${name} is too light to read on this page; try a darker ${name}.`)
      expect(applyLookPatch(base, { kind: 'accent', accent: name }, DEFAULT_VARIANT, SEED_VARIANTS).variant?.colors).toEqual(v.colors)
    }
  })
  it.each((Object.keys(ACCENTS) as AccentName[]).filter((k) => k.startsWith('deep-')))('%s: exactly the named colour on a light page', (name) => {
    for (const v of lightBases) {
      const p = applyLookPatch({ variant: v, layout: null }, { kind: 'accent', accent: name }, DEFAULT_VARIANT, SEED_VARIANTS)
      expect(p.variant!.colors.accent).toBe(ACCENTS[name])
      expect(legibilityProblems(p.variant!.colors)).toEqual([])
    }
  })
  it('the rest of the look stays when one accent is refused', () => {
    const settled = settleLooks(null, describeLook('calmer, dark purple, bigger text', world), DEFAULT_VARIANT, SEED_VARIANTS)
    expect(settled.looks.map((l) => l.patch.kind)).toEqual(['motion', 'density'])
    expect(settled.cannot.map((c) => c.phrase)).toEqual(['dark purple'])
  })
})

describe('Kimi K4: a tagged name is cut after tagging, never past the host’s 40', () => {
  it('every tag on a 40-character name, and chained, stays ≤ 40 with the tag whole', () => {
    const long = { ...DEFAULT_VARIANT, name: 'My look: Calmer, warmer, bigger text xyz' }
    expect(long.name.length).toBe(40)
    let v = long
    for (const tag of ['warmer', 'cooler', 'contrast', 'soft', 'deep-purple', 'purple', 'amber']) {
      const one = tagged(long, tag)
      expect(one.name.length).toBeLessThanOrEqual(NAME_MAX)
      expect(one.name.endsWith(` (${tag})`)).toBe(true)
      v = tagged(v, tag)
      expect(v.name.length).toBeLessThanOrEqual(NAME_MAX)
      expect(v.id).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/)
    }
  })
  it('a name already too long coming in leaves at most 40', () => {
    expect(tagged({ ...DEFAULT_VARIANT, name: 'x'.repeat(60) }, 'warmer').name.length).toBeLessThanOrEqual(NAME_MAX)
    expect(tagged({ ...DEFAULT_VARIANT, name: `${'y'.repeat(50)} (warmer)` }, 'warmer').name.length).toBeLessThanOrEqual(NAME_MAX)
  })
  it('through the Ask: warmer on a kept 40-character look', () => {
    const p = applyLookPatch({ variant: { ...DEFAULT_VARIANT, name: 'My look: Calmer, warmer, bigger text xyz' }, layout: null }, { kind: 'warmth', warmth: 'warmer' }, DEFAULT_VARIANT, SEED_VARIANTS)
    expect(p.variant!.name.length).toBeLessThanOrEqual(NAME_MAX)
  })
})

describe('Kimi r1g P1: spacing is not a look (it would move hit targets); text size is', () => {
  it.each(['more room', 'roomier', 'compact', 'denser', 'tighter'])('“%s” is said plainly and changes nothing', (words) => {
    const d = describeLook(words, world)
    expect(d.looks).toEqual([])
    expect(d.cannot.map((c) => c.text)).toEqual(['Changing spacing needs the next look update, so nothing changed. “Bigger text” and “smaller text” work now.'])
  })
  it('“bigger text” and “smaller text” are text size, labelled as such', () => {
    expect(describeLook('bigger text, smaller text', world).looks.map((l) => l.label)).toEqual(['Bigger text', 'Smaller text'])
  })
})
