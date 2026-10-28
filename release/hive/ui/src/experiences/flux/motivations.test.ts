import { describe, expect, it } from 'vitest'
import { FEATURES } from '../../features/registry'
import { clip, countByMotivation, serves } from './motivations'
import { FLUX_NATIVE, targetFor } from './nav'

// synthetic links: t1 serves two motivations, t2 one, t3 none (Unsorted)
const links = { t1: [{ id: 'mo_a' }, { id: 'mo_b' }], t2: [{ id: 'mo_a' }], t3: [] }

describe('Flux tasks by motivation', () => {
  it('filters any, one motivation, and Unsorted', () => {
    const ids = ['t1', 't2', 't3', 't4']
    expect(ids.filter((t) => serves(links, t, ''))).toEqual(ids)
    expect(ids.filter((t) => serves(links, t, 'mo_a'))).toEqual(['t1', 't2'])
    expect(ids.filter((t) => serves(links, t, 'mo_b'))).toEqual(['t1'])
    // t4's links were never read: not Unsorted (stand-in P2-3 on 61936cb), so a partial read never fills Unsorted
    expect(ids.filter((t) => serves(links, t, 'none'))).toEqual(['t3'])
    expect(countByMotivation(ids, links).none).toBe(1)
  })

  it('counts each task once in the total, however many motivations it serves', () => {
    const c = countByMotivation(['t1', 't2', 't3', 't1'], { ...links, t1: [{ id: 'mo_a' }, { id: 'mo_b' }, { id: 'mo_a' }] })
    expect(c.any).toBe(3)
    expect(c.none).toBe(1)
    expect(c.per).toEqual({ mo_a: 2, mo_b: 1 })
  })

  it('clips long titles for a phone-width pill', () => {
    expect(clip('short')).toBe('short')
    expect(clip('a'.repeat(40))).toHaveLength(26)
  })

  it('draws Tasks and Motivations as its own sheets', () => {
    const f = (id: string) => FEATURES.find((x) => x.id === id)!
    expect(targetFor(f('work.goals'))).toEqual({ kind: 'page', page: 'goals' })
    expect(targetFor(f('work.motivations'))).toEqual({ kind: 'page', page: 'motivations' })
    expect(FLUX_NATIVE).toContain('work.motivations')
  })
})
