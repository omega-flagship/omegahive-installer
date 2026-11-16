import { describe, expect, it, vi } from 'vitest'

// the reach proof needs targetFor's real answer for every feature, without a browser
vi.mock('../../shell/uiVariant', () => ({ openGallery: () => undefined }))
vi.mock('../../tour/introStore', () => ({ useIntro: { getState: () => ({ setHelp: () => undefined }) } }))
vi.mock('../../store/store', () => ({ useHive: { getState: () => ({ setPalette: () => undefined, setStopAll: () => undefined }) } }))

const { FEATURES } = await import('../../features/registry')
const { targetFor } = await import('../../experiences/targets')
const { STILL_PLACE } = await import('../../experiences/still/features')
const { decide, registerVocabulary, resolve } = await import('./index')
type ScopedFeatures = import('./index').ScopedFeatures
type World = import('./index').World

/**
 * Universal Ask, phase 1 (UNIVERSAL_ASK_DESIGN §2.1, Q5): ONE reach proof. Every feature in the registry has a plain
 * utterance that resolves to its real target, in every scope this phase ships (Classic and Still), and the §2.4 policy
 * acts on it locally (it is never handed to a mind and never "not here").
 */
const SCOPED: ScopedFeatures = Object.fromEntries(
  FEATURES.map((f) => [f.id, targetFor(f)?.kind] as const).filter((x): x is [string, 'mind' | 'swarm'] => x[1] === 'mind' || x[1] === 'swarm'),
)
registerVocabulary('still', { inPlace: Object.keys(STILL_PLACE) })

const world: World = {
  minds: [
    { id: 'a_vega01', name: 'Vega', awake: true, swarm: 'Lyra' },
    { id: 'a_coral5', name: 'Coral', awake: true, swarm: 'Kelp Commons' },
  ],
  swarms: [
    { id: 's_lyra', name: 'Lyra' },
    { id: 's_kelp', name: 'Kelp Commons' },
  ],
  pending: 2,
  apps: [{ id: 'omegadesign', name: 'Design' }],
  experiences: [
    { id: 'classic', name: 'Classic hive' },
    { id: 'still', name: 'Still' },
  ],
  looks: [{ id: 'ember-forge', name: 'Ember Forge' }],
}

/** The candidate that opens feature `id` (directly, scoped with its subject, or as a route carrying a swarm). */
const opens = (id: string) => (c: ReturnType<typeof resolve>[number]) => {
  const a = c.act
  if (a && (a.do === 'feature' || a.do === 'scoped') && a.id === id) return true
  if (a?.do === 'route' && c.key.startsWith(`route-${id}-`)) return true
  return !!c.clarify && c.clarify.chips.some((ch) => ch.act && 'id' in ch.act && ch.act.id === id)
}

describe('every registry feature is reachable by plain words (lib/intent reach proof)', () => {
  for (const scope of ['classic', 'still'] as const) {
    it(`in ${scope}: "open <its name>" resolves to the feature and the policy acts on it`, () => {
      const missing: string[] = []
      for (const f of FEATURES) {
        const utterances = [`open ${f.label.toLowerCase()}`, f.label]
        const ok = utterances.some((u) => {
          const cands = resolve(u, { experience: scope }, world, SCOPED)
          const hit = cands.find(opens(f.id))
          if (!hit) return false
          const d = decide(cands, { orchestrator: true })
          return d.kind !== 'mind' && d.kind !== 'none'
        })
        if (!ok) missing.push(f.id)
      }
      expect(missing, missing.join('\n')).toEqual([])
    })
  }

  it('a mind-scoped feature names its subject from the words, or asks one question with chips', () => {
    const named = resolve('show the memory of vega', { experience: 'classic' }, world, SCOPED)
    expect(named.some((c) => c.act?.do === 'scoped' && c.act.id === 'minds.memory' && c.act.mind === 'a_vega01')).toBe(true)
    const bare = resolve("a mind's memory", { experience: 'classic' }, world, SCOPED)
    const q = bare.find((c) => c.clarify)
    expect(q?.clarify?.question).toMatch(/which mind/i)
    expect(q?.clarify?.chips.map((c) => c.label)).toEqual(['Vega', 'Coral'])
    expect(decide(bare, { orchestrator: true }).kind).toBe('clarify')
  })

  it('Still does its in-place features without asking for a subject (vocabulary, not a fork)', () => {
    const c = resolve('beliefs', { experience: 'still' }, world, SCOPED)
    expect(c.find((x) => x.act?.do === 'feature' && x.act.id === 'swarms.beliefs')).toBeTruthy()
    expect(c.some((x) => x.clarify)).toBe(false)
  })

  it('every scoped feature has a real target (targets.ts), so the reach is to a real place', () => {
    for (const id of Object.keys(SCOPED)) expect(targetFor(FEATURES.find((f) => f.id === id)!), id).not.toBeNull()
  })
})
