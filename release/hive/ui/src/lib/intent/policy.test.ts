import { describe, expect, it } from 'vitest'
import { DEFAULT_VARIANT, SEED_VARIANTS } from '../../shell/uiVariant'
import { applyLookPatch, decide, enterTakesFirst, lookCandidates, mindCandidate, resolve, type Candidate, type World } from './index'

/** Universal Ask phase 1: the fast path's policy (§2.4) and look pack (§2.1), pure. */
const world: World = {
  minds: [
    { id: 'a_vega01', name: 'Vega', awake: true, swarm: 'Lyra' },
    { id: 'a_altr03', name: 'Altair', awake: false, swarm: 'Lyra' },
    { id: 'ag_7d1c0a11f3', name: 'Mira', awake: false, swarm: 'Forge' },
    { id: 'ag_92be44c8e0', name: 'Mira', awake: false, swarm: 'Atlas Team' },
  ],
  swarms: [{ id: 's_lyra', name: 'Lyra' }],
  pending: 1,
  experiences: [
    { id: 'classic', name: 'Classic hive' },
    { id: 'still', name: 'Still' },
  ],
  looks: SEED_VARIANTS.map((v) => ({ id: v.id, name: v.name })),
}
const scope = { experience: 'classic' }
const c = (p: Partial<Candidate>): Candidate => ({ key: Math.random().toString(36), tag: 'T', parts: [{ t: 'x' }], confidence: 0, ...p })

describe('the §2.4 policy', () => {
  it('runs a clear view at once, offers choices when close, hands low confidence to the orchestrator', () => {
    const view = c({ act: { do: 'route', route: { name: 'usage' }, label: 'Usage' }, effect: 'view', confidence: 0.95 })
    expect(decide([view], { orchestrator: true }).kind).toBe('run')
    const near = c({ act: { do: 'route', route: { name: 'goals' }, label: 'Goals' }, effect: 'view', confidence: 0.9 })
    const d = decide([view, near], { orchestrator: true })
    expect(d.kind).toBe('choose')
    expect(enterTakesFirst(d)).toBe(true)
    expect(decide([c({ act: { do: 'search', text: 'x' }, effect: 'view', confidence: 0.3 })], { orchestrator: true }).kind).toBe('mind')
    const none = decide([c({ act: { do: 'feature', id: 'money.usage' }, effect: 'view', confidence: 0.3 })], { orchestrator: false })
    expect(none.kind).toBe('none')
  })

  it('a person-typed hive action is "own" (preview, then Enter behind the arming gate); a decision feature only opens', () => {
    expect(decide(resolve('wake Altair', scope, world), { orchestrator: true }).kind).toBe('own')
    const d = decide(resolve('open decisions waiting on you', scope, world), { orchestrator: true })
    expect(d.kind).toBe('open-decision')
  })

  it('several things with one name: which one, and nothing runs', () => {
    expect(decide(resolve('wake Mira', scope, world), { orchestrator: true }).kind).toBe('which')
  })

  it('a time or condition is said plainly, with the safe part offered', () => {
    const d = decide(resolve('wake Altair tomorrow', scope, world), { orchestrator: true })
    expect(d.kind).toBe('limit')
  })

  it('a free question goes to the orchestrator, never run locally', () => {
    expect(decide(resolve('why did the build fail yesterday afternoon', scope, world), { orchestrator: true }).kind).toBe('mind')
    expect(mindCandidate('why', 'Omega').parts.map((p) => p.t).join('')).toContain('Omega') // the name is the host's; shownMind guards display
  })

  it('apps open by name; "search for X" searches', () => {
    const w = { ...world, apps: [{ id: 'omegadesign', name: 'Design' }] }
    expect(decide(resolve('open Design', scope, w), { orchestrator: true })).toMatchObject({ kind: 'run', c: { act: { do: 'route', route: { name: 'program', id: 'omegadesign' } } } })
    expect(decide(resolve('search for riverside', scope, world), { orchestrator: true })).toMatchObject({ kind: 'run', c: { act: { do: 'search', text: 'riverside' } } })
  })
})

describe('the look pack: the person’s own words are the acceptance, applied at once with Undo', () => {
  const kinds = (t: string) => lookCandidates(t, world).map((x) => (x.act?.do === 'look' ? x.act.patch.kind : x.limit ? 'limit' : '?'))
  it('understands darker, calmer, layouts, named looks and offered experiences', () => {
    expect(kinds('make it darker')).toEqual(['darker'])
    expect(kinds('calmer')).toEqual(['motion'])
    expect(kinds('put the navigation at the top')).toEqual(['layout'])
    expect(kinds('use ember forge')).toEqual(['variant'])
    expect(kinds('switch to Still')).toEqual(['experience'])
    expect(kinds('go back to classic')).toEqual(['experience'])
  })
  it('says plainly what this build cannot do (light, an experience not offered), and changes nothing', () => {
    expect(kinds('lighter')).toEqual(['limit'])
    expect(kinds('switch to cosmos')).toEqual(['limit'])
  })
  it('text size, temperature, contrast and accent are looks now (Request an experience, step 1)', () => {
    expect(kinds('bigger text')).toEqual(['density'])
    expect(kinds('make it warmer')).toEqual(['warmth'])
    expect(kinds('more contrast')).toEqual(['contrast'])
    expect(kinds('a blue accent')).toEqual(['accent'])
  })
  it('a look command runs at once under the policy', () => {
    expect(decide(resolve('make it darker', scope, world), { orchestrator: true }).kind).toBe('run')
  })
  it('applyLookPatch: data only, legible, and undoable from the prefs before', () => {
    const before = null
    const dark = applyLookPatch(before, { kind: 'darker' }, DEFAULT_VARIANT, SEED_VARIANTS)
    expect(dark.variant?.id).toBe('default-darker')
    expect(dark.variant?.colors.ink).toBe(DEFAULT_VARIANT.colors.ink)
    expect(applyLookPatch(dark, { kind: 'darker' }, DEFAULT_VARIANT, SEED_VARIANTS).variant?.id).toBe('default-darker')
    expect(applyLookPatch(null, { kind: 'layout', layout: 'dock' }, DEFAULT_VARIANT, SEED_VARIANTS).layout).toBe('dock')
    expect(applyLookPatch(dark, { kind: 'reset' }, DEFAULT_VARIANT, SEED_VARIANTS).variant).toBeNull()
    expect(applyLookPatch(null, { kind: 'experience', id: 'still' }, DEFAULT_VARIANT, SEED_VARIANTS).experience).toBe('still')
  })
})
