import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../features/registry'
import { NATIVE } from '../coverage'
import { FLUX_NATIVE, NAV_FEATURES, targetFor } from './nav'

describe('flux navigation reaches everything', () => {
  it('lists every feature that has any UI, from its own navigation', () => {
    for (const f of FEATURES) if (f.classic || targetFor(f)) expect(NAV_FEATURES, f.id).toContain(f.id)
  })
  it('offers starting a swarm and making a mind', () => {
    expect(NAV_FEATURES).toContain('swarms.launch')
    expect(NAV_FEATURES).toContain('minds.create')
  })
  it('coverage claims exactly what it draws natively', () => {
    expect([...NATIVE['flux']].sort()).toEqual([...FLUX_NATIVE].sort())
  })
  it('never routes a mind feature to the bare hive page (it would open nothing over the experience)', () => {
    for (const f of FEATURES) {
      const t = targetFor(f)
      if (t?.kind === 'classic') expect(t.route.name, f.id).not.toBe('hive')
    }
  })
})
