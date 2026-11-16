import { describe, expect, it, vi } from 'vitest'

/** A look a mind proposes carries text size the same way a described look does (Request an experience r1b). */
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })
const { proposedLook } = await import('./ask')
const { applyLookPatch } = await import('../lib/intent')
const { DEFAULT_VARIANT, SEED_VARIANTS } = await import('../shell/uiVariant')
const offered = [{ id: 'still', name: 'Still' }]

describe('proposedLook: density', () => {
  it.each(['compact', 'regular', 'roomy'] as const)('%s is applied, not dropped', (density) => {
    const { next, dropped } = proposedLook({ density }, null, offered)
    expect(dropped).toEqual([])
    expect(next.variant?.density).toBe(density)
    // the same look the words "bigger text" / "compact" make
    expect(next.variant).toEqual(applyLookPatch(null, { kind: 'density', density }, DEFAULT_VARIANT, SEED_VARIANTS).variant)
  })
  it('lands on the proposed look, whichever order the fields come in', () => {
    const { next } = proposedLook({ density: 'roomy', variant: 'ember-forge', layout: 'dock' }, null, offered)
    expect(next.variant?.id).toBe('ember-forge')
    expect(next.variant?.density).toBe('roomy')
    expect(next.layout).toBe('dock')
  })
  it('keeps the person’s own saved look and changes only the size', () => {
    const saved = { variant: SEED_VARIANTS[1], layout: null, apps: null, experience: 'still' }
    const { next } = proposedLook({ density: 'compact' }, saved, offered)
    expect(next.variant).toEqual({ ...SEED_VARIANTS[1], density: 'compact' })
    expect(next.experience).toBe('still')
  })
  it('a size this build has no scale for is not guessed at', () => {
    const { dropped } = proposedLook({ density: 'huge' }, null, offered)
    expect(dropped).toEqual(['a text size this build does not have (huge)'])
  })
})
