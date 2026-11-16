import { describe, expect, it } from 'vitest'
import { shown } from './displayName'

describe('shown', () => {
  it('drops the implicit Omega prefix', () => {
    expect(shown('OmegaDesign')).toBe('Design')
    expect(shown('OmegaReview Coordinator v1')).toBe('Review Coordinator v1')
    expect(shown('OmegaEvolve Omega')).toBe('Evolve Omega')
    expect(shown('OmegaPlanner plan checker')).toBe('Planner plan checker')
  })
  it('keeps product names, bare Omega and non-prefix uses', () => {
    expect(shown('OmegaHive')).toBe('OmegaHive')
    expect(shown('OmegaClaw core')).toBe('OmegaClaw core')
    expect(shown('Omega')).toBe('Omega')
    expect(shown('Omega Design')).toBe('Omega Design')
    expect(shown('OMEGA')).toBe('OMEGA')
    expect(shown('Lumen')).toBe('Lumen')
    expect(shown('')).toBe('')
    expect(shown(undefined)).toBe('')
  })
})
