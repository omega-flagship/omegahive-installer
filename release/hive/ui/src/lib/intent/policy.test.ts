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

  it('a request merely holding a home place’s word goes to the mind, and asking for the place still offers it', () => {
    // a tester's research question met "Did you mean… Read what the hive learned lately", and Enter sent nothing: each
    // of these once matched a stem anywhere (learn, know, found, decide, status, busy, what…doing)
    for (const text of [
      'I’d like to research privacy attacks on federated learning',
      'what do you know about foundation models',
      'explain unknown unknowns to me',
      'help me decide between two laptops',
      'what’s the status of my order from the bakery',
      'what is the weather doing tomorrow in Lisbon',
      // a short question that holds every word of a place's phrase but asks about something of its own (Jon, #363)
      'what is happening with my order',
      'who is busy at the bakery',
      'anything for me to read about Rome',
      'what’s going on in Lyra',
    ]) {
      const cands = resolve(text, scope, world)
      expect(cands.filter((x) => x.act?.do === 'scroll').map((x) => x.key), text).toEqual([])
      expect(decide(cands, { orchestrator: true }).kind, text).toBe('mind')
    }
    // the place's own question runs at once; one asked in more words is offered
    expect(decide(resolve('what needs me', scope, world), { orchestrator: true }).kind).toBe('run')
    for (const [text, to] of [['what have you learned lately', 'learned'], ['anything for me today', 'needs'], ['what’s going on right now', 'now'], ['show me my inbox', 'needs'], ['my notifications', 'needs']] as const) {
      expect(resolve(text, scope, world).some((x) => x.act?.do === 'scroll' && x.act.to === to), text).toBe(true)
    }
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

describe('a line led by a name: the mind the Ask row names takes it, whoever else carries the name', () => {
  // a tester's swarm Taiga and their mind Taiga share the name; the Ask answered in their conversation with the mind, and
  // every "Taiga, …" there stopped at "Two things are called Taiga" with nothing sent (Hive Rapid Feedback Loop, 20 Nov)
  const taiga = { id: 'a_taiga01', name: 'Taiga', awake: true, swarm: 'Taiga' }
  const shared: World = { ...world, minds: [taiga, ...world.minds], swarms: [{ id: 's_taiga', name: 'Taiga' }, ...world.swarms] }
  const line = 'Taiga, why are you asking such a silly question?'

  it('in a conversation with the mind, the line goes as the Ask row’s request, and the swarm stays a row to pick', () => {
    const cands = resolve(line, scope, { ...shared, answeringMind: taiga.id })
    expect(cands.some((x) => x.choice)).toBe(false)
    expect(decide(cands, { orchestrator: true }).kind).toBe('mind')
    const swarm = cands.find((x) => x.key === 'also-swarm-s_taiga')
    expect(swarm?.act).toBeUndefined()
    expect(swarm?.fill).toMatch(/^Taiga#\w+, why are you asking such a silly question\?$/)
  })


  it('two minds carry the name: the one the Ask row names takes the line; with neither named it is still which one', () => {
    const atlas = 'ag_92be44c8e0'
    const cands = resolve('Mira, how are you getting on?', scope, { ...world, answeringMind: atlas })
    expect(decide(cands, { orchestrator: true }).kind).toBe('mind')
    expect(cands.some((x) => x.key === 'also-mind-ag_7d1c0a11f3')).toBe(true)
    expect(decide(resolve('Mira, how are you getting on?', scope, world), { orchestrator: true }).kind).toBe('which')
  })

  it('a name alone, and a swarm’s task, still ask which one, the row’s mind among them or not', () => {
    for (const text of ['Taiga', 'Taiga should water the plants'])
      expect(decide(resolve(text, scope, { ...shared, answeringMind: taiga.id }), { orchestrator: true }).kind, text).toBe('which')
  })

  it('a name only the row’s mind carries continues that conversation; a mind the row does not name is still sent to', () => {
    expect(decide(resolve('Vega, what did you find?', scope, { ...world, answeringMind: 'a_vega01' }), { orchestrator: true }).kind).toBe('mind')
    expect(decide(resolve('Vega, what did you find?', scope, { ...world, answeringMind: 'a_altr03' }), { orchestrator: true }).kind).toBe('own')
    expect(decide(resolve('Vega, what did you find?', scope, world), { orchestrator: true }).kind).toBe('own')
  })
})
