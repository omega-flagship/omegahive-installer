import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../features/registry'
import { NATIVE } from '../coverage'
import { COSMOS_NATIVE, NAV_FEATURES, targetFor } from './nav'

describe('cosmos navigation reaches everything', () => {
  it('lists every feature that has any UI, from its own navigation', () => {
    for (const f of FEATURES) if (f.classic || targetFor(f)) expect(NAV_FEATURES, f.id).toContain(f.id)
  })
  it('offers starting a swarm and making a mind', () => {
    expect(NAV_FEATURES).toContain('swarms.launch')
    expect(NAV_FEATURES).toContain('minds.create')
  })
  it('coverage claims exactly what it draws natively', () => {
    expect([...NATIVE['cosmos']].sort()).toEqual([...COSMOS_NATIVE].sort())
  })
  it('never routes a mind feature to the bare hive page (it would open nothing over the experience)', () => {
    for (const f of FEATURES) {
      const t = targetFor(f)
      if (t?.kind === 'classic') expect(t.route.name, f.id).not.toBe('hive')
    }
  })
})

describe('Motivations above Tasks in Cosmos', () => {
  const f = (id: string) => FEATURES.find((x) => x.id === id)!
  it('reaches Motivations and Tasks on its own deck', () => {
    expect(targetFor(f('work.motivations'))).toEqual({ kind: 'page', page: 'motivations' })
    expect(targetFor(f('work.goals'))).toEqual({ kind: 'page', page: 'goals' })
    expect(COSMOS_NATIVE).toContain('work.motivations')
  })
  it('opens Tasks filtered to one motivation, and any other opening clears the filter', async () => {
    const { useCosmos } = await import('./state')
    useCosmos.getState().setDeck('goals', { motivation: 'mo_synthetic' })
    expect(useCosmos.getState()).toMatchObject({ deck: 'goals', deckMotivation: 'mo_synthetic' })
    useCosmos.getState().setDeck('goals', { swarm: 's_synthetic' })
    expect(useCosmos.getState()).toMatchObject({ deck: 'goals', deckSwarm: 's_synthetic', deckMotivation: null })
    useCosmos.getState().setDeck(null)
  })
  it('people see Tasks, never Goals, on the deck and the system panel', async () => {
    const sources = { 'Deck.tsx': (await import('./Deck.tsx?raw')).default, 'Panels.tsx': (await import('./Panels.tsx?raw')).default }
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/Full goals board|'GOALS'|Launch goal|NEW GOAL|"Goal (title|detail)"|'Goals'|Which goals|>\s*Goals\s*</)
    }
  })
})
