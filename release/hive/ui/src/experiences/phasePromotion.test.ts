import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('Jon-approved native phase promotion', () => {
  it.each(['production', 'demo'])('releases exactly Cosmos, Professional, Still and Construct in %s', async mode => {
    vi.resetModules()
    vi.stubEnv('PROD', true); vi.stubEnv('MODE', mode); vi.stubEnv('VITE_UNREVIEWED_EXPERIENCES', '1')
    const { ALL_EXPERIENCES } = await import('./registry')
    const released = ['construct', 'cosmos', 'professional', 'still']
    expect(ALL_EXPERIENCES.filter(e => e.phasesReviewed).map(e => e.id).sort()).toEqual(released)
    expect(ALL_EXPERIENCES.filter(e => e.phases).map(e => e.id).sort()).toEqual(released)
    for (const id of ['classic', 'flux', 'canvas']) {
      const entry = ALL_EXPERIENCES.find(e => e.id === id)!
      expect(entry.phasesReviewed, id).not.toBe(true)
      expect(entry.phases, id).toBeUndefined()
    }
  })
})
